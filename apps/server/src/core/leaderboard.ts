import { and, asc, count, eq, inArray, lt } from 'drizzle-orm';
import { seasonOf, type Champion, type ProfileGlory, type SeasonInfo, type StandingRow, type Tally } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, matches, matchPlayers, seasonClosings } from '../db/schema';
import type { Clock } from '../lib/clock';
import type { EventBus } from './bus';
import { toPublic, type IdentityRow } from './identity';
import { rankLines, rateSeason, type RatedMatch } from './ratings';

export interface LeaderboardDeps {
  clock: Clock;
  bus: EventBus;
  /** The catalog, in its order: the hall of fame and the announcement list games this way. */
  games: () => { id: string; name: string }[];
}

/** Seasons, Elo, standings, the hall of fame and the Carbon-vs-Silicon tally, all derived from match results (M4). */
/** Whoever posts the closing line: the CommunicationManager in production, a fake in tests. */
export interface Announcer {
  postSystem(channel: string, text: string): Promise<unknown>;
}

/** "2026-09" → "September". */
export function monthName(season: string): string {
  return new Date(`${season}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

export class LeaderboardManager {
  /** `${season}:${gameId}` → standings. Closed seasons stay forever; open ones go on `match.finished`. */
  private cache = new Map<string, StandingRow[]>();
  /** Bumped on every drop, so a query that started before it never stores a stale result. */
  private generation = 0;
  private closed: Set<string> | null = null;
  private warned = new Set<string>();

  constructor(
    private db: DB,
    private deps: LeaderboardDeps,
  ) {
    deps.bus.on('match.finished', () => this.dropOpen());
  }

  async tally(season: string): Promise<Tally> {
    const rows = await this.db
      .select({ matchId: matchPlayers.matchId, kind: matchPlayers.kind, result: matchPlayers.result })
      .from(matchPlayers)
      .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
      .where(and(eq(matches.season, season), eq(matches.status, 'over')));
    const byMatch = new Map<string, { kind: string; result: string | null }[]>();
    for (const r of rows) {
      const list = byMatch.get(r.matchId) ?? [];
      list.push(r);
      byMatch.set(r.matchId, list);
    }
    let carbon = 0;
    let silicon = 0;
    let draws = 0;
    for (const players of byMatch.values()) {
      if (new Set(players.map((p) => p.kind)).size < 2) continue;
      const winners = players.filter((p) => p.result === 'win');
      if (winners.length === 0) draws += 1;
      else if (winners.every((w) => w.kind === 'human')) carbon += 1;
      else if (winners.every((w) => w.kind === 'agent')) silicon += 1;
    }
    return { season, carbon, silicon, draws };
  }

  async standings(season: string, gameId: string): Promise<StandingRow[]> {
    const closed = await this.closedSeasons();
    const key = `${season}:${gameId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const generation = this.generation;
    const rows = await this.db
      .select({ matchId: matches.id, outcome: matches.outcome, seat: matchPlayers.seat, i: identities })
      .from(matchPlayers)
      .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
      .innerJoin(identities, eq(identities.id, matchPlayers.identityId))
      .where(and(eq(matches.season, season), eq(matches.gameId, gameId), eq(matches.status, 'over'), eq(matches.rated, true)))
      .orderBy(asc(matches.endedAt), asc(matches.id), asc(matchPlayers.seat));
    const people = new Map<string, IdentityRow>();
    const list: RatedMatch[] = [];
    const byId = new Map<string, RatedMatch>();
    for (const r of rows) {
      let m = byId.get(r.matchId);
      if (!m) {
        const o = r.outcome as { winners?: unknown; placement?: unknown } | null;
        if (!o || !Array.isArray(o.winners) || !Array.isArray(o.placement)) {
          this.warnOnce(r.matchId);
          continue;
        }
        m = { id: r.matchId, outcome: { winners: o.winners as string[], placement: o.placement as string[][] }, seats: [] };
        byId.set(r.matchId, m);
        list.push(m);
      }
      people.set(r.i.id, r.i);
      m.seats.push({ seat: r.seat, playerId: r.i.id });
    }
    const board = rankLines(rateSeason(list), (id) => people.get(id)!.handle).map((l) => ({
      rank: l.rank,
      identity: toPublic(people.get(l.playerId)!),
      points: l.points,
      wins: l.wins,
      draws: l.draws,
      losses: l.losses,
      games: l.games,
      elo: Math.round(l.elo),
    }));
    if (generation === this.generation || closed.has(season)) this.cache.set(key, board);
    return board;
  }

  /** Every season with at least one match, plus the current one, newest first. */
  async seasons(): Promise<SeasonInfo[]> {
    const rows = await this.db.selectDistinct({ season: matches.season }).from(matches);
    const closed = await this.closedSeasons();
    const all = new Set(rows.map((r) => r.season));
    all.add(seasonOf(this.deps.clock.now()));
    return [...all].sort().reverse().map((season) => ({ season, closed: closed.has(season) }));
  }

  /** Each closed season's first place per game: newest season first, games in catalog order. */
  async hallOfFame(): Promise<Champion[]> {
    const closed = [...(await this.closedSeasons())].sort().reverse();
    const out: Champion[] = [];
    for (const season of closed) {
      for (const g of this.deps.games()) {
        const [top] = await this.standings(season, g.id);
        if (top) out.push({ season, gameId: g.id, row: top });
      }
    }
    return out;
  }

  /** What a profile shows of the leaderboard: standing, this season's rows, matches played, titles. */
  async glory(identityId: string): Promise<ProfileGlory> {
    const [row] = await this.db.select().from(identities).where(eq(identities.id, identityId)).limit(1);
    const now = this.deps.clock.now();
    const pub = row ? toPublic(row) : null;
    const rankedAt = row?.rankedAt?.toISOString() ?? null;
    const ranked = !!pub && !(pub.kind === 'human' && !pub.locked) && rankedAt !== null && Date.parse(rankedAt) <= now;
    const current = seasonOf(now);
    const season: ProfileGlory['season'] = [];
    for (const g of this.deps.games()) {
      const mine = (await this.standings(current, g.id)).find((r) => r.identity.id === identityId);
      if (mine) season.push({ gameId: g.id, row: mine });
    }
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(matchPlayers)
      .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
      .where(and(eq(matchPlayers.identityId, identityId), eq(matches.status, 'over')));
    const titles = (await this.hallOfFame()).filter((c) => c.row.identity.id === identityId).map((c) => ({ season: c.season, gameId: c.gameId }));
    return { rankedAt, ranked, season, matchesPlayed: Number(n), titles };
  }

  /**
   * Closes every past season that has matches, none of them still in countdown or live, and no
   * closing row yet. The insert is the guard: only the call whose insert lands announces, so a restart
   * or a second server never announces a season twice.
   */
  async closeSeasons(announcer: Announcer): Promise<string[]> {
    const now = this.deps.clock.now();
    const current = seasonOf(now);
    const closed = await this.closedSeasons();
    const past = (await this.db.selectDistinct({ season: matches.season }).from(matches).where(lt(matches.season, current)))
      .map((r) => r.season)
      .filter((s) => !closed.has(s))
      .sort();
    const done: string[] = [];
    for (const season of past) {
      const [busy] = await this.db
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.season, season), inArray(matches.status, ['countdown', 'live'])))
        .limit(1);
      if (busy) continue;
      const inserted = await this.db
        .insert(seasonClosings)
        .values({ season, closedAt: new Date(now) })
        .onConflictDoNothing()
        .returning({ season: seasonClosings.season });
      closed.add(season);
      if (inserted.length === 0) continue;
      await announcer.postSystem('lobby', await this.announcement(season, current));
      done.push(season);
    }
    return done;
  }

  private async announcement(season: string, current: string): Promise<string> {
    const champions: string[] = [];
    for (const g of this.deps.games()) {
      const [top] = await this.standings(season, g.id);
      if (top) champions.push(`${g.name} — ${top.identity.released ? 'a former player' : `@${top.identity.handle}`}`);
    }
    const middle = champions.length > 0 ? `Champions: ${champions.join(' · ')}.` : 'No ranked games were played.';
    return `${monthName(season)} is in the books. ${middle} ${monthName(current)} is open; every rating is back to 1000.`;
  }

  protected async closedSeasons(): Promise<Set<string>> {
    if (!this.closed) {
      const rows = await this.db.select({ season: seasonClosings.season }).from(seasonClosings);
      this.closed ??= new Set(rows.map((r) => r.season));
    }
    return this.closed;
  }

  private dropOpen(): void {
    this.generation += 1;
    for (const key of [...this.cache.keys()]) {
      if (!this.closed?.has(key.slice(0, key.indexOf(':')))) this.cache.delete(key);
    }
  }

  private warnOnce(matchId: string): void {
    if (this.warned.has(matchId)) return;
    this.warned.add(matchId);
    console.warn(`[leaderboard] match ${matchId} has no usable outcome; it is left out of the ratings`);
  }
}

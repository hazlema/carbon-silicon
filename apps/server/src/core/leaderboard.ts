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

/** Whoever posts the closing line: the CommunicationManager in production, a fake in tests. */
export interface Announcer {
  postSystem(channel: string, text: string): Promise<unknown>;
}

/** "2026-09" → "September". */
export function monthName(season: string): string {
  return new Date(`${season}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

const SEASON_GRACE_MS = 5 * 60_000;

/** Seasons, Elo, standings, the hall of fame and the Carbon-vs-Silicon tally, all derived from match results (M4). */
export class LeaderboardManager {
  /** `${season}:${gameId}` → standings. Closed seasons stay forever; open ones go when a match is recorded. */
  private cache = new Map<string, StandingRow[]>();
  /** Bumped on every drop, so a query that started before it never stores a stale result. */
  private generation = 0;
  /** Bumped by `forget()` alone: even a closed season's board read before a release must not be stored. */
  private forgets = 0;
  private closed: Set<string> | null = null;
  private warned = new Set<string>();

  constructor(
    private db: DB,
    private deps: LeaderboardDeps,
  ) {
    deps.bus.on('match.recorded', (e) => this.dropRecorded(e.season, e.gameId));
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
    const forgets = this.forgets;
    // Closedness as it was when the read began: a season that closes mid-read may have been read without a
    // straggler that landed just before the close, so only a board read whole from a closed season skips the
    // generation check.
    const wasClosed = closed.has(season);
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
    // An empty board is cheap to recompute, and never storing one keeps a crawler's made-up seasons out of the cache.
    if (board.length > 0 && forgets === this.forgets && (generation === this.generation || wasClosed)) this.cache.set(key, board);
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
    // A match created in the first moments of a month is stamped with the new season; waiting a few
    // minutes means the previous season's last matches are all in before it can close.
    const before = seasonOf(now - SEASON_GRACE_MS);
    const past = (await this.db.selectDistinct({ season: matches.season }).from(matches).where(lt(matches.season, before)))
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
      try {
        await announcer.postSystem('lobby', await this.announcement(season, current));
      } catch (e) {
        // Nothing was announced: undo the closing so the next check tries again.
        await this.db.delete(seasonClosings).where(eq(seasonClosings.season, season));
        closed.delete(season);
        throw e;
      }
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

  /** A match was written (or its write failed): that game's open season is stale; nothing else is. */
  private dropRecorded(season: string, gameId: string): void {
    this.generation += 1;
    if (!this.closed?.has(season)) this.cache.delete(`${season}:${gameId}`);
  }

  /**
   * A name was released or deleted: closed seasons embed the old public identity, so every entry goes
   * and recomputes (cheaply) with the tombstone.
   */
  async forget(_identityId: string): Promise<void> {
    this.generation += 1;
    this.forgets += 1;
    this.cache.clear();
  }

  /** For tests: how many boards are cached. */
  cacheSize(): number {
    return this.cache.size;
  }

  private warnOnce(matchId: string): void {
    if (this.warned.has(matchId)) return;
    this.warned.add(matchId);
    console.warn(`[leaderboard] match ${matchId} has no usable outcome; it is left out of the ratings`);
  }
}

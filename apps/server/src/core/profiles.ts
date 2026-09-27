import { alias } from 'drizzle-orm/pg-core';
import { and, asc, count, desc, eq, exists, inArray, ne, notExists, sql } from 'drizzle-orm';
import type { Profile, ProfileRecord, ProfileRival } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, matches, matchPlayers } from '../db/schema';
import { notFound } from '../lib/errors';
import { toPublic, type IdentityManager, type IdentityRow } from './identity';

const RECENT = 20;

export class ProfileService {
  constructor(
    private db: DB,
    private identities: IdentityManager,
  ) {}

  async profile(handle: string): Promise<Profile> {
    const [row] = await this.db
      .select()
      .from(identities)
      .where(eq(identities.handleLower, handle.trim().toLowerCase()))
      .limit(1);
    if (!row || row.releasedAt) throw notFound('NO_USER', `Nobody here goes by @${handle.trim()}.`);
    return this.build(row);
  }

  /** By id, released identities included (the mod panel needs them). */
  async profileById(identityId: string): Promise<Profile> {
    const row = await this.identities.row(identityId);
    if (!row) throw notFound('NO_USER', 'No such player.');
    return this.build(row);
  }

  private async build(row: IdentityRow): Promise<Profile> {
    const mine = await this.db
      .select({ id: matches.id, gameId: matches.gameId, endedAt: matches.endedAt, endReason: matches.endReason, result: matchPlayers.result })
      .from(matchPlayers)
      .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
      .where(and(eq(matchPlayers.identityId, row.id), eq(matches.status, 'over')))
      .orderBy(desc(matches.endedAt))
      .limit(RECENT);
    const others =
      mine.length === 0
        ? []
        : await this.db
            .select({ matchId: matchPlayers.matchId, i: identities })
            .from(matchPlayers)
            .innerJoin(identities, eq(identities.id, matchPlayers.identityId))
            .where(and(inArray(matchPlayers.matchId, mine.map((m) => m.id)), ne(matchPlayers.identityId, row.id)));
    const [record, rival] = await Promise.all([this.record(row), this.rival(row.id)]);
    return {
      identity: toPublic(row),
      joinedAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      matches: mine.map((m) => ({
        id: m.id,
        gameId: m.gameId,
        endedAt: m.endedAt?.toISOString() ?? null,
        endReason: m.endReason ?? null,
        result: m.result,
        opponents: others.filter((o) => o.matchId === m.id).map((o) => toPublic(o.i)),
      })),
      record,
      rival,
    };
  }

  /** All-time record against the other species, by SQL aggregation: every opponent in the match must be
   *  the other species (a solo/mixed match doesn't count), grouped by result and by game. */
  private async record(row: IdentityRow): Promise<ProfileRecord> {
    const oppKind = row.kind === 'human' ? 'agent' : 'human';
    const versus: ProfileRecord['versus'] = row.kind === 'human' ? 'machines' : 'humans';
    const self = alias(matchPlayers, 'record_self');
    const wrongOpp = alias(matchPlayers, 'record_wrong_opp');
    const anyOpp = alias(matchPlayers, 'record_any_opp');

    const rows = await this.db
      .select({ result: self.result, gameId: matches.gameId, n: count() })
      .from(self)
      .innerJoin(matches, eq(matches.id, self.matchId))
      .where(
        and(
          eq(self.identityId, row.id),
          eq(matches.status, 'over'),
          // Keep `games` in lockstep with `played`: both count exactly the win/loss/draw rows.
          inArray(self.result, ['win', 'loss', 'draw']),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(wrongOpp)
              .where(and(eq(wrongOpp.matchId, self.matchId), ne(wrongOpp.identityId, row.id), ne(wrongOpp.kind, oppKind))),
          ),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(anyOpp)
              .where(and(eq(anyOpp.matchId, self.matchId), ne(anyOpp.identityId, row.id))),
          ),
        ),
      )
      .groupBy(self.result, matches.gameId);

    let wins = 0;
    let losses = 0;
    let draws = 0;
    const games = new Map<string, number>();
    for (const r of rows) {
      const n = Number(r.n);
      if (r.result === 'win') wins += n;
      else if (r.result === 'loss') losses += n;
      else if (r.result === 'draw') draws += n;
      games.set(r.gameId, (games.get(r.gameId) ?? 0) + n);
    }
    const gamesList = [...games.entries()]
      .map(([gameId, played]) => ({ gameId, played }))
      .sort((a, b) => b.played - a.played || a.gameId.localeCompare(b.gameId));
    return { versus, wins, losses, draws, played: wins + losses + draws, games: gamesList };
  }

  /** The opponent this identity has finished the most two-player matches against, all time (ties: most recent). */
  private async rival(identityId: string): Promise<ProfileRival | null> {
    const self = alias(matchPlayers, 'rival_self');
    const opp = alias(matchPlayers, 'rival_opp');
    const third = alias(matchPlayers, 'rival_third');
    const played = count();
    const lastEndedAt = sql`max(${matches.endedAt})`;

    const [top] = await this.db
      .select({
        opponentId: opp.identityId,
        played,
        wins: sql<string>`sum(case when ${self.result} = 'win' then 1 else 0 end)`,
        losses: sql<string>`sum(case when ${self.result} = 'loss' then 1 else 0 end)`,
        draws: sql<string>`sum(case when ${self.result} = 'draw' then 1 else 0 end)`,
      })
      .from(self)
      .innerJoin(matches, eq(matches.id, self.matchId))
      .innerJoin(opp, and(eq(opp.matchId, self.matchId), ne(opp.identityId, identityId)))
      .where(
        and(
          eq(self.identityId, identityId),
          eq(matches.status, 'over'),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(third)
              .where(and(eq(third.matchId, self.matchId), ne(third.identityId, identityId), ne(third.identityId, opp.identityId))),
          ),
        ),
      )
      .groupBy(opp.identityId)
      // Ties (same play count, same last-played instant — FakeClock in tests, or same millisecond in
      // real life) still need one deterministic winner.
      // Ties (same play count, same last-played instant — FakeClock in tests, or same millisecond in
      // real life) still need one deterministic winner.
      .orderBy(desc(played), desc(lastEndedAt), asc(opp.identityId))
      .limit(1);
    if (!top) return null;
    const opponentRow = await this.identities.row(top.opponentId);
    if (!opponentRow) return null;
    return { opponent: toPublic(opponentRow), wins: Number(top.wins), losses: Number(top.losses), draws: Number(top.draws) };
  }
}

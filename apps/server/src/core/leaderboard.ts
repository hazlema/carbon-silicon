import { and, eq } from 'drizzle-orm';
import type { Tally } from '@cs/shared/protocol';
import type { DB } from '../db';
import { matches, matchPlayers } from '../db/schema';

/** M1 holds only the season's Carbon-vs-Silicon tally; Elo and standings arrive in M4. */
export class LeaderboardManager {
  constructor(private db: DB) {}

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
}

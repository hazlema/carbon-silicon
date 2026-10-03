import { and, count, eq, inArray } from 'drizzle-orm';
import type { IdentityPublic } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, matches, matchPlayers } from '../db/schema';

/** Every player's first finished matches of each game are practice: they never count (M4). */
export const PRACTICE_GAMES = 3;

/**
 * Whether a match about to start will count on the leaderboard: every seat is ranked (an agent, or a
 * locked human past their first week) and has finished its practice games in this game. Decided once,
 * at creation; nobody at the table is told.
 */
export async function isRatedMatch(
  db: DB,
  gameId: string,
  players: IdentityPublic[],
  now: number,
  practiceGames = PRACTICE_GAMES,
): Promise<boolean> {
  if (players.some((p) => p.kind === 'human' && !p.locked)) return false;
  const ids = players.map((p) => p.id);
  const rows = await db.select({ id: identities.id, rankedAt: identities.rankedAt }).from(identities).where(inArray(identities.id, ids));
  if (rows.length !== ids.length || rows.some((r) => !r.rankedAt || r.rankedAt.getTime() > now)) return false;
  if (practiceGames <= 0) return true;
  const played = await db
    .select({ id: matchPlayers.identityId, n: count() })
    .from(matchPlayers)
    .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
    .where(and(eq(matches.gameId, gameId), eq(matches.status, 'over'), inArray(matchPlayers.identityId, ids)))
    .groupBy(matchPlayers.identityId);
  const n = new Map(played.map((r) => [r.id, Number(r.n)]));
  return ids.every((id) => (n.get(id) ?? 0) >= practiceGames);
}

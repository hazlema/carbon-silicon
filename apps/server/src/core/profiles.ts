import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Profile } from '@cs/shared/protocol';
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
      .select({ id: matches.id, gameId: matches.gameId, endedAt: matches.endedAt, result: matchPlayers.result })
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
    return {
      identity: toPublic(row),
      joinedAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      matches: mine.map((m) => ({
        id: m.id,
        gameId: m.gameId,
        endedAt: m.endedAt?.toISOString() ?? null,
        result: m.result,
        opponents: others.filter((o) => o.matchId === m.id).map((o) => toPublic(o.i)),
      })),
    };
  }
}

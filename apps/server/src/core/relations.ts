import { and, eq, or } from 'drizzle-orm';
import type { IdentityPublic, RelationsInfo } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, personRelations } from '../db/schema';
import { badRequest, notFound } from '../lib/errors';
import { toPublic, type IdentityManager } from './identity';

export type RelationKind = 'ignore' | 'block';

/** Ignore and block lists. One relation per pair: setting one replaces the other. */
export class RelationManager {
  /** ownerId → (targetId → kind); filled lazily, dropped on every change. */
  private cache = new Map<string, Map<string, RelationKind>>();

  constructor(
    private db: DB,
    private identities: IdentityManager,
  ) {}

  private async targetOf(owner: IdentityPublic, handle: string): Promise<IdentityPublic> {
    const target = await this.identities.getByHandle(handle);
    if (!target || target.released) throw notFound('NO_USER', `There is no @${handle}.`);
    if (target.id === owner.id) throw badRequest('SELF', "You can't ignore or block yourself.");
    return target;
  }

  async set(owner: IdentityPublic, targetHandle: string, kind: RelationKind): Promise<RelationsInfo> {
    const target = await this.targetOf(owner, targetHandle);
    await this.db
      .insert(personRelations)
      .values({ ownerId: owner.id, targetId: target.id, kind })
      .onConflictDoUpdate({ target: [personRelations.ownerId, personRelations.targetId], set: { kind } });
    this.cache.delete(owner.id);
    return this.list(owner.id);
  }

  async clear(owner: IdentityPublic, targetHandle: string, kind: RelationKind): Promise<RelationsInfo> {
    const target = await this.targetOf(owner, targetHandle);
    await this.db
      .delete(personRelations)
      .where(and(eq(personRelations.ownerId, owner.id), eq(personRelations.targetId, target.id), eq(personRelations.kind, kind)));
    this.cache.delete(owner.id);
    return this.list(owner.id);
  }

  async list(ownerId: string): Promise<RelationsInfo> {
    const rows = await this.db
      .select({ kind: personRelations.kind, target: identities })
      .from(personRelations)
      .innerJoin(identities, eq(personRelations.targetId, identities.id))
      .where(eq(personRelations.ownerId, ownerId))
      .orderBy(identities.handleLower);
    return {
      ignores: rows.filter((r) => r.kind === 'ignore').map((r) => toPublic(r.target)),
      blocks: rows.filter((r) => r.kind === 'block').map((r) => toPublic(r.target)),
    };
  }

  /** Does `ownerId` ignore or block `authorId`? */
  async mutes(ownerId: string, authorId: string): Promise<boolean> {
    let byTarget = this.cache.get(ownerId);
    if (!byTarget) {
      const rows = await this.db
        .select({ targetId: personRelations.targetId, kind: personRelations.kind })
        .from(personRelations)
        .where(eq(personRelations.ownerId, ownerId));
      byTarget = new Map(rows.map((r) => [r.targetId, r.kind as RelationKind]));
      this.cache.set(ownerId, byTarget);
    }
    return byTarget.has(authorId);
  }

  /** On release: nothing points to or from a tombstone. */
  async forget(identityId: string): Promise<void> {
    await this.db.delete(personRelations).where(or(eq(personRelations.ownerId, identityId), eq(personRelations.targetId, identityId)));
    this.cache.clear();
  }
}

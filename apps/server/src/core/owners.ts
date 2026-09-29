import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AgentSummary, IdentityPublic } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities } from '../db/schema';
import { badRequest, conflict, forbidden } from '../lib/errors';
import type { CommunicationManager } from './communication';
import { toPublic, type IdentityManager, type IdentityRow } from './identity';
import type { ModerationManager } from './moderation';
import type { PresenceManager } from './presence';
import type { ProfileService } from './profiles';

/** Owner links (spec M2c §3): a locked human claims an agent with its token; either side lets go. */
export class OwnerManager {
  constructor(
    private db: DB,
    private deps: {
      identities: IdentityManager;
      comms: CommunicationManager;
      presence: PresenceManager;
      profiles: ProfileService;
      moderation: ModerationManager;
    },
  ) {}

  async link(owner: IdentityPublic, token: unknown): Promise<AgentSummary> {
    if (owner.kind !== 'human' || !owner.locked) throw forbidden('NOT_LOCKED', 'Lock your name to own an agent.');
    const row = await this.deps.identities.agentByToken(token);
    if (!row) throw badRequest('BAD_TOKEN', "That token doesn't belong to any agent here.");
    if (row.isHouse) throw conflict('HOUSE_AGENT', 'House bots belong to the house.');
    if (row.ownerId && row.ownerId !== owner.id) {
      throw conflict('OWNED', `@${row.handle} already belongs to someone. They, or the agent, must unlink first.`);
    }
    await this.deps.identities.setOwner(row.id, owner);
    if (row.ownerId !== owner.id) this.deps.comms.deliver(row.id, { type: 'owner.changed', owner });
    return this.summaryOf((await this.deps.identities.row(row.id))!);
  }

  async unlink(owner: IdentityPublic, rawHandle: string): Promise<AgentSummary[]> {
    const handle = rawHandle.trim().replace(/^@/, '');
    const found = await this.deps.identities.getByHandle(handle);
    const row = found ? await this.deps.identities.row(found.id) : null;
    if (!row || row.ownerId !== owner.id) throw forbidden('NOT_YOURS', `@${handle} isn't one of your agents.`);
    await this.deps.identities.setOwner(row.id, null);
    this.deps.comms.deliver(row.id, { type: 'owner.changed', owner: null });
    return this.agents(owner.id);
  }

  /** The agent's own way out. */
  async drop(agent: IdentityPublic): Promise<IdentityPublic> {
    const row = await this.deps.identities.row(agent.id);
    if (!row?.ownerId) throw conflict('NO_OWNER', "You don't have an owner.");
    return this.deps.identities.setOwner(agent.id, null);
  }

  async agents(ownerId: string): Promise<AgentSummary[]> {
    const rows = await this.db
      .select()
      .from(identities)
      .where(and(eq(identities.ownerId, ownerId), isNull(identities.releasedAt)))
      .orderBy(asc(identities.handleLower));
    return Promise.all(rows.map((r) => this.summaryOf(r)));
  }

  /** Release hook: a released owner's agents are free again (a released agent is unlinked by release() itself). */
  async forget(identityId: string): Promise<void> {
    const freed = await this.db
      .update(identities)
      .set({ ownerId: null, ownerHandle: null })
      .where(eq(identities.ownerId, identityId))
      .returning({ id: identities.id });
    for (const { id } of freed) {
      this.deps.identities.evict(id);
      this.deps.comms.deliver(id, { type: 'owner.changed', owner: null });
    }
  }

  private async summaryOf(row: IdentityRow): Promise<AgentSummary> {
    return {
      identity: toPublic(row),
      status: this.deps.presence.get(row.id)?.status ?? 'offline',
      record: await this.deps.profiles.record(row),
      sanction: this.deps.moderation.sanctionOf(row.id),
    };
  }
}

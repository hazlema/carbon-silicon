import { and, count, desc, eq, gt } from 'drizzle-orm';
import { dmChannel, type ChatMessage, type DmSummary, type IdentityPublic } from '@cs/shared/protocol';
import type { DB } from '../db';
import { dmState, messages } from '../db/schema';
import { badRequest, forbidden, notFound } from '../lib/errors';
import type { CommunicationManager } from './communication';
import type { IdentityManager } from './identity';
import type { RelationManager } from './relations';

const MAX_UNREAD = 99;
const MAX_LISTED = 50;
const PAGE = 100;

type StateRow = typeof dmState.$inferSelect;

/** Direct messages (spec M2c §2): who may write to whom, and each person's read and closed state. */
export class DmManager {
  constructor(
    private db: DB,
    private deps: { comms: CommunicationManager; identities: IdentityManager; relations: RelationManager },
  ) {}

  /** CommunicationManager hook: throws when `author` may not write to `otherId`. */
  async check(author: IdentityPublic, otherId: string): Promise<void> {
    const other = await this.deps.identities.get(otherId);
    if (!other || other.released) throw notFound('NO_USER', 'Nobody here goes by that name.');
    const { relations } = this.deps;
    if (await relations.blocks(other.id, author.id)) throw forbidden('BLOCKED', `@${other.handle} isn't taking messages from you.`);
    if (await relations.blocks(author.id, other.id)) throw forbidden('BLOCKED', `You block @${other.handle}. Unblock them to message them.`);
  }

  /** CommunicationManager hook, after a DM is stored: the sender has read it and sees its tab; the
   *  recipient's tab opens, unless they ignore or block the sender. Returns who should see it now. */
  async stored(message: ChatMessage, otherId: string): Promise<string[]> {
    const authorId = message.author!.id;
    await this.upsert(authorId, message.channel, otherId, { lastReadId: message.id, hidden: false });
    if (await this.deps.relations.mutes(otherId, authorId)) return [authorId];
    await this.upsert(otherId, message.channel, authorId, { hidden: false });
    return [authorId, otherId];
  }

  async send(me: IdentityPublic, handle: string, text: unknown): Promise<ChatMessage> {
    const other = await this.otherOf(me, handle);
    return this.deps.comms.post(me, dmChannel(me.id, other.id), text);
  }

  async history(me: IdentityPublic, handle: string, before?: number): Promise<{ with: IdentityPublic; channel: string; messages: ChatMessage[] }> {
    const other = await this.otherOf(me, handle);
    const channel = dmChannel(me.id, other.id);
    return { with: other, channel, messages: await this.deps.comms.history(channel, { viewer: me, limit: PAGE, before }) };
  }

  /** Your conversations, newest first, minus people you ignore or block and released names
   *  (whose conversations could never be read or closed again). */
  async list(me: IdentityPublic): Promise<DmSummary[]> {
    const rows = await this.db.select().from(dmState).where(eq(dmState.identityId, me.id));
    const out: DmSummary[] = [];
    for (const row of rows) {
      if (await this.deps.relations.mutes(me.id, row.otherId)) continue;
      const other = await this.deps.identities.get(row.otherId);
      if (other && !other.released) out.push(await this.summary(me, other, row.channel, row));
    }
    return out.sort((a, b) => (b.last?.id ?? 0) - (a.last?.id ?? 0)).slice(0, MAX_LISTED);
  }

  async read(me: IdentityPublic, handle: string): Promise<DmSummary> {
    const other = await this.otherOf(me, handle);
    const channel = dmChannel(me.id, other.id);
    const newest = await this.newestId(channel);
    // No messages yet: nothing to read, and no state row to open a conversation nobody started.
    if (newest === null) return this.summary(me, other, channel);
    await this.upsert(me.id, channel, other.id, { lastReadId: newest });
    // Every device of yours clears its dot.
    this.deps.comms.deliver(me.id, { type: 'dm.read', channel });
    return this.summary(me, other, channel);
  }

  async close(me: IdentityPublic, handle: string): Promise<DmSummary> {
    const other = await this.otherOf(me, handle);
    const channel = dmChannel(me.id, other.id);
    if ((await this.newestId(channel)) === null) return this.summary(me, other, channel);
    await this.upsert(me.id, channel, other.id, { hidden: true });
    return this.summary(me, other, channel);
  }

  /** Release hook: a released name's side of every conversation goes with it (the messages stay). */
  async forget(identityId: string): Promise<void> {
    await this.db.delete(dmState).where(eq(dmState.identityId, identityId));
  }

  private async newestId(channel: string): Promise<number | null> {
    const [newest] = await this.db.select({ id: messages.id }).from(messages).where(eq(messages.channel, channel)).orderBy(desc(messages.id)).limit(1);
    return newest?.id ?? null;
  }

  private async otherOf(me: IdentityPublic, rawHandle: string): Promise<IdentityPublic> {
    const handle = rawHandle.trim().replace(/^@/, '');
    const other = await this.deps.identities.getByHandle(handle);
    if (!other || other.released) throw notFound('NO_USER', `Nobody here goes by @${handle}.`);
    if (other.id === me.id) throw badRequest('SELF', "You can't message yourself.");
    return other;
  }

  private async upsert(identityId: string, channel: string, otherId: string, set: { lastReadId?: number; hidden?: boolean }): Promise<void> {
    await this.db
      .insert(dmState)
      .values({ identityId, channel, otherId, lastReadId: set.lastReadId ?? 0, hidden: set.hidden ?? false })
      .onConflictDoUpdate({ target: [dmState.identityId, dmState.channel], set });
  }

  private async summary(me: IdentityPublic, other: IdentityPublic, channel: string, row?: StateRow): Promise<DmSummary> {
    const state = row ?? (await this.db.select().from(dmState).where(and(eq(dmState.identityId, me.id), eq(dmState.channel, channel))).limit(1))[0];
    const [last] = await this.deps.comms.history(channel, { viewer: me, limit: 1 });
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.channel, channel), gt(messages.id, state?.lastReadId ?? 0), eq(messages.authorId, other.id)));
    return { with: other, channel, last: last ?? null, unread: Math.min(MAX_UNREAD, Number(n)), hidden: state?.hidden ?? false };
  }
}

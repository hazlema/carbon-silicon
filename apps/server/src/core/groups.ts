import { and, asc, count, desc, eq, gt, isNull, max, ne } from 'drizzle-orm';
import { containsProfanity, containsSlur } from '@cs/shared/filter';
import { groupChannel, type ChatMessage, type GroupInfo, type IdentityPublic } from '@cs/shared/protocol';
import type { DB } from '../db';
import { chatGroups, groupBans, groupMembers, identities, messages } from '../db/schema';
import type { Clock } from '../lib/clock';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { CommunicationManager } from './communication';
import { toPublic, type IdentityManager } from './identity';
import type { RelationManager } from './relations';

export const GROUP_MAX_DEFAULT = 8;
export const GROUP_MAX_MIN = 2;
export const GROUP_MAX_MAX = 50;
const MAX_UNREAD = 99;
const MAX_NAME = 32;

/** GROUP_MAX_MEMBERS from the environment: 8 by default, held to 2–50. */
export function clampGroupMax(raw: string | undefined, warn: (m: string) => void): number {
  if (raw === undefined || raw.trim() === '') return GROUP_MAX_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warn(`[main] GROUP_MAX_MEMBERS=${raw} is not a number; using ${GROUP_MAX_DEFAULT}.`);
    return GROUP_MAX_DEFAULT;
  }
  const held = Math.min(GROUP_MAX_MAX, Math.max(GROUP_MAX_MIN, Math.round(n)));
  if (held !== n) warn(`[main] GROUP_MAX_MEMBERS=${raw} is outside ${GROUP_MAX_MIN}–${GROUP_MAX_MAX}; using ${held}.`);
  return held;
}

type Group = typeof chatGroups.$inferSelect;
type Member = typeof groupMembers.$inferSelect;
/** "@b", "@b and @c", "@b, @c and @d". */
function names(people: IdentityPublic[]): string {
  const tags = people.map((p) => `@${p.handle}`);
  return tags.length < 2 ? tags.join('') : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
}
const bare = (h: string) => h.trim().replace(/^@/, '');

/** Group chats (spec M2d §2): membership, the owner, bans, and each member's read state. */
export class GroupManager {
  constructor(
    private db: DB,
    private clock: Clock,
    private deps: { comms: CommunicationManager; identities: IdentityManager; relations: RelationManager },
    private opts: { maxMembers: number },
  ) {}

  get maxMembers(): number {
    return this.opts.maxMembers;
  }

  /** CommunicationManager hook: throws unless `author` may post in the group. */
  async check(author: IdentityPublic, groupId: string): Promise<void> {
    await this.requireMember(author, groupId);
  }

  /** CommunicationManager hook: what `viewer` may read of the group's channel. */
  async view(viewer: IdentityPublic | null | undefined, groupId: string): Promise<{ after: number; hidden: string[] }> {
    if (!viewer) throw forbidden('NOT_MEMBER', "You're not in this group.");
    const { member } = await this.requireMember(viewer, groupId);
    return { after: member.firstMessageId, hidden: await this.deps.relations.mutedBy(viewer.id) };
  }

  /** CommunicationManager hook, after a line is stored: who should see it now (for now, every member). */
  async stored(_message: ChatMessage, groupId: string): Promise<string[]> {
    return this.memberIds(groupId);
  }

  async create(me: IdentityPublic, withHandles: unknown): Promise<GroupInfo> {
    if (!Array.isArray(withHandles) || withHandles.length === 0 || withHandles.some((h) => typeof h !== 'string')) {
      throw badRequest('BAD_FIELD', 'Send {"with": ["handle", …]}.');
    }
    const handles = [...new Map((withHandles as string[]).map((h) => [bare(h).toLowerCase(), bare(h)])).values()];
    const people: IdentityPublic[] = [];
    for (const handle of handles) {
      const other = await this.target(me, handle);
      if (!people.some((p) => p.id === other.id)) people.push(other);
    }
    if (people.length + 1 > this.opts.maxMembers) throw conflict('GROUP_FULL', `This group is full (${this.opts.maxMembers} people).`);
    const id = newId('g');
    const first = await this.newestMessageId();
    await this.db.insert(chatGroups).values({ id, ownerId: me.id });
    const at = new Date(this.clock.now());
    await this.db
      .insert(groupMembers)
      .values([me, ...people].map((p) => ({ groupId: id, identityId: p.id, joinedAt: at, firstMessageId: first })));
    await this.deps.comms.postSystem(groupChannel(id), `@${me.handle} started a group with ${names(people)}.`);
    this.notify(await this.memberIds(id), me.id, id);
    return this.get(me, id);
  }

  async add(me: IdentityPublic, groupId: string, handle: string): Promise<GroupInfo> {
    const { group } = await this.requireMember(me, groupId);
    const [{ n }] = await this.db.select({ n: count() }).from(groupMembers).where(eq(groupMembers.groupId, groupId));
    if (Number(n) >= this.opts.maxMembers) throw conflict('GROUP_FULL', `This group is full (${this.opts.maxMembers} people).`);
    const other = await this.target(me, handle, group);
    await this.db
      .insert(groupMembers)
      .values({ groupId, identityId: other.id, joinedAt: new Date(this.clock.now()), firstMessageId: await this.newestMessageId() });
    await this.deps.comms.postSystem(groupChannel(groupId), `@${me.handle} added @${other.handle}.`);
    this.notify(await this.memberIds(groupId), me.id, groupId);
    return this.get(me, groupId);
  }

  async rename(me: IdentityPublic, groupId: string, raw: unknown): Promise<GroupInfo> {
    await this.requireMember(me, groupId);
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length < 1 || name.length > MAX_NAME) throw badRequest('BAD_NAME', `A group name is 1–${MAX_NAME} characters.`);
    if (containsSlur(name) || containsProfanity(name)) throw badRequest('NAME_FILTERED', 'Pick a different name for the group.');
    await this.db.update(chatGroups).set({ name }).where(eq(chatGroups.id, groupId));
    await this.deps.comms.postSystem(groupChannel(groupId), `@${me.handle} named this group "${name}".`);
    this.notify(await this.memberIds(groupId), me.id, groupId);
    return this.get(me, groupId);
  }

  /** Your own handle leaves; anyone else's is removed and banned (owner only). */
  async remove(me: IdentityPublic, groupId: string, rawHandle: string): Promise<GroupInfo | null> {
    const { group } = await this.requireMember(me, groupId);
    const handle = bare(rawHandle);
    if (handle.toLowerCase() === me.handle.toLowerCase()) {
      await this.leave(group, me, true);
      return null;
    }
    if (group.ownerId !== me.id) throw forbidden('NOT_OWNER', "Only the group's owner can do that.");
    const other = await this.deps.identities.getByHandle(handle);
    const [row] = other ? await this.db.select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, other.id))) : [];
    if (!other || !row) throw forbidden('NOT_MEMBER', `@${handle} isn't in this group.`);
    await this.db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, other.id)));
    await this.db.insert(groupBans).values({ groupId, identityId: other.id, bannedBy: me.id, bannedAt: new Date(this.clock.now()) });
    await this.deps.comms.postSystem(groupChannel(groupId), `@${other.handle} was removed.`);
    this.deps.comms.deliver(other.id, { type: 'group.gone', groupId, reason: 'removed' });
    this.notify(await this.memberIds(groupId), me.id, groupId);
    return this.get(me, groupId);
  }

  async unban(me: IdentityPublic, groupId: string, rawHandle: string): Promise<GroupInfo> {
    const { group } = await this.requireMember(me, groupId);
    if (group.ownerId !== me.id) throw forbidden('NOT_OWNER', "Only the group's owner can do that.");
    const other = await this.deps.identities.getByHandle(bare(rawHandle));
    if (other) await this.db.delete(groupBans).where(and(eq(groupBans.groupId, groupId), eq(groupBans.identityId, other.id)));
    this.deps.comms.deliver(me.id, { type: 'group.changed', groupId });
    return this.get(me, groupId);
  }

  async list(me: IdentityPublic): Promise<GroupInfo[]> {
    const rows = await this.db
      .select({ group: chatGroups, member: groupMembers })
      .from(groupMembers)
      .innerJoin(chatGroups, eq(groupMembers.groupId, chatGroups.id))
      .where(and(eq(groupMembers.identityId, me.id), isNull(chatGroups.endedAt)));
    const out: GroupInfo[] = [];
    for (const { group, member } of rows) out.push(await this.info(me, group, member));
    return out.sort((a, b) => (b.last?.id ?? 0) - (a.last?.id ?? 0));
  }

  async get(me: IdentityPublic, groupId: string): Promise<GroupInfo> {
    const { group, member } = await this.requireMember(me, groupId);
    return this.info(me, group, member);
  }

  async read(me: IdentityPublic, groupId: string): Promise<GroupInfo> {
    await this.requireMember(me, groupId);
    const newest = await this.newestMessageId(groupChannel(groupId));
    if (newest > 0) {
      await this.db.update(groupMembers).set({ lastReadId: newest }).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, me.id)));
    }
    // Every device of yours clears its dot.
    this.deps.comms.deliver(me.id, { type: 'group.read', groupId });
    return this.get(me, groupId);
  }

  async close(me: IdentityPublic, groupId: string): Promise<GroupInfo> {
    await this.requireMember(me, groupId);
    await this.db.update(groupMembers).set({ hidden: true }).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, me.id)));
    return this.get(me, groupId);
  }

  /** The member ids of a live group, or [] once it has ended (or never was). */
  async memberIds(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: groupMembers.identityId })
      .from(groupMembers)
      .innerJoin(chatGroups, eq(groupMembers.groupId, chatGroups.id))
      .where(and(eq(groupMembers.groupId, groupId), isNull(chatGroups.endedAt)));
    return rows.map((r) => r.id);
  }

  /** Release hook: a released name leaves every group it was in (the lines stay). */
  async forget(identityId: string): Promise<void> {
    const person = await this.deps.identities.get(identityId);
    if (!person) return;
    const rows = await this.db
      .select({ group: chatGroups })
      .from(groupMembers)
      .innerJoin(chatGroups, eq(groupMembers.groupId, chatGroups.id))
      .where(and(eq(groupMembers.identityId, identityId), isNull(chatGroups.endedAt)));
    for (const { group } of rows) await this.leave(group, person, false);
    // Their own tab state in groups that have ended goes too.
    await this.db.delete(groupMembers).where(eq(groupMembers.identityId, identityId));
  }

  /** `me` leaves: the next longest-standing member owns it, and the last one out ends it. */
  private async leave(group: Group, me: IdentityPublic, tellThem: boolean): Promise<void> {
    const groupId = group.id;
    await this.db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, me.id)));
    await this.deps.comms.postSystem(groupChannel(groupId), `@${me.handle} left.`);
    if (tellThem) this.deps.comms.deliver(me.id, { type: 'group.gone', groupId, reason: 'left' });
    const rest = await this.db
      .select({ identityId: groupMembers.identityId, joinedAt: groupMembers.joinedAt })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
      .orderBy(asc(groupMembers.joinedAt), asc(groupMembers.identityId));
    if (rest.length === 0) {
      await this.db.update(chatGroups).set({ endedAt: new Date(this.clock.now()) }).where(eq(chatGroups.id, groupId));
      await this.db.delete(groupBans).where(eq(groupBans.groupId, groupId));
      return;
    }
    if (group.ownerId === me.id) {
      const next = await this.deps.identities.get(rest[0].identityId);
      await this.db.update(chatGroups).set({ ownerId: rest[0].identityId }).where(eq(chatGroups.id, groupId));
      if (next) await this.deps.comms.postSystem(groupChannel(groupId), `@${next.handle} is the owner now.`);
    }
    this.notify(rest.map((r) => r.identityId), me.id, groupId);
  }

  /** `group.changed` to every member but the one who made the change. */
  private notify(memberIds: string[], exceptId: string, groupId: string): void {
    for (const id of memberIds) if (id !== exceptId) this.deps.comms.deliver(id, { type: 'group.changed', groupId });
  }

  /** The person `handle` names, if `me` may put them in a group (spec M2d §2). */
  private async target(me: IdentityPublic, rawHandle: string, group?: Group): Promise<IdentityPublic> {
    const handle = bare(rawHandle);
    const other = await this.deps.identities.getByHandle(handle);
    if (!other || other.released) throw notFound('NO_USER', `Nobody here goes by @${handle}.`);
    if (other.id === me.id) throw badRequest('SELF', "You're already in it.");
    if (other.isHouse && other.role === 'mod') throw conflict('HOUSE_AGENT', 'The Bouncer reads reports, not chats.');
    if (group) {
      const [member] = await this.db.select().from(groupMembers).where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.identityId, other.id)));
      if (member) throw conflict('ALREADY_MEMBER', `@${other.handle} is already in this group.`);
      const [ban] = await this.db.select().from(groupBans).where(and(eq(groupBans.groupId, group.id), eq(groupBans.identityId, other.id)));
      if (ban) throw forbidden('GROUP_BANNED', `@${other.handle} was removed from this group.`);
    }
    const { relations } = this.deps;
    if (await relations.blocks(other.id, me.id)) throw forbidden('BLOCKED', `@${other.handle} isn't taking messages from you.`);
    if (await relations.blocks(me.id, other.id)) throw forbidden('BLOCKED', `You block @${other.handle}. Unblock them to message them.`);
    return other;
  }

  private async requireMember(me: IdentityPublic, groupId: string): Promise<{ group: Group; member: Member }> {
    const [group] = await this.db.select().from(chatGroups).where(eq(chatGroups.id, groupId)).limit(1);
    if (!group || group.endedAt) throw notFound('NO_GROUP', 'There is no such group.');
    const [member] = await this.db.select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, me.id))).limit(1);
    if (!member) throw forbidden('NOT_MEMBER', "You're not in this group.");
    return { group, member };
  }

  private async newestMessageId(channel?: string): Promise<number> {
    const [row] = await this.db.select({ id: max(messages.id) }).from(messages).where(channel ? eq(messages.channel, channel) : undefined);
    return Number(row?.id ?? 0);
  }

  private async info(me: IdentityPublic, group: Group, member: Member): Promise<GroupInfo> {
    const channel = groupChannel(group.id);
    const memberRows = await this.db
      .select({ i: identities, joinedAt: groupMembers.joinedAt })
      .from(groupMembers)
      .innerJoin(identities, eq(groupMembers.identityId, identities.id))
      .where(eq(groupMembers.groupId, group.id))
      .orderBy(asc(groupMembers.joinedAt), asc(groupMembers.identityId));
    const isOwner = group.ownerId === me.id;
    const banRows = isOwner
      ? await this.db
          .select({ i: identities })
          .from(groupBans)
          .innerJoin(identities, eq(groupBans.identityId, identities.id))
          .where(eq(groupBans.groupId, group.id))
          .orderBy(asc(groupBans.bannedAt))
      : [];
    const seen = gt(messages.id, member.firstMessageId);
    const [lastRow] = await this.db
      .select({ m: messages, i: identities })
      .from(messages)
      .leftJoin(identities, eq(messages.authorId, identities.id))
      .where(and(eq(messages.channel, channel), seen))
      .orderBy(desc(messages.id))
      .limit(1);
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.channel, channel),
          gt(messages.id, Math.max(member.firstMessageId, member.lastReadId)),
          eq(messages.system, false),
          ne(messages.authorId, me.id),
        ),
      );
    const last: ChatMessage | null = lastRow
      ? {
          id: lastRow.m.id,
          channel,
          author: lastRow.i ? toPublic(lastRow.i) : null,
          text: lastRow.m.deletedAt ? '' : lastRow.m.text,
          createdAt: lastRow.m.createdAt.toISOString(),
          system: lastRow.m.system,
          removed: lastRow.m.deletedAt ? { by: lastRow.m.deletedBy ?? 'a moderator' } : null,
        }
      : null;
    return {
      id: group.id,
      channel,
      name: group.name,
      ownerId: group.ownerId,
      members: memberRows.map((r) => ({ identity: toPublic(r.i), joinedAt: r.joinedAt.toISOString(), owner: r.i.id === group.ownerId })),
      maxMembers: this.opts.maxMembers,
      bans: banRows.map((r) => toPublic(r.i)),
      last,
      unread: Math.min(MAX_UNREAD, Number(n)),
      hidden: member.hidden,
    };
  }
}

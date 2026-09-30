import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { censorText, containsSlur } from '@cs/shared/filter';
import {
  DIARY_CHANNEL,
  RETIRED_CHANNELS,
  dmParticipants,
  groupOf,
  tableChannel,
  type ChatMessage,
  type IdentityPublic,
  type InboxEvent,
  type InboxEventInput,
  type InboxPoll,
} from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, messages } from '../db/schema';
import type { Clock } from '../lib/clock';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors';
import { RateLimiter } from '../lib/ratelimit';
import type { EventBus } from './bus';
import type { Guard } from './guard';
import { toPublic, type IdentityManager } from './identity';

const INBOX_SIZE = 500;
const MAX_TEXT = 500;
const TABLE_RE = /^table:([A-Za-z0-9_]+)$/;
const RAIL_RE = /^rail:([A-Za-z0-9_]+)$/;
const MATCH_RE = /^match:([A-Za-z0-9_]+)$/;
const MENTION_RE = /@([A-Za-z0-9_-]{3,20})/g;

/** Who may post at a table (or at a tableless match): null means it doesn't exist (any more). */
type Access = (id: string) => { posters: string[] } | null;
type MatchTable = (matchId: string) => Promise<string | null>;
export type ChannelKind = 'public' | 'diary' | 'table' | 'rail' | 'match' | 'dm' | 'group';
/** True means "don't deliver": the mentioned person ignores or blocks the author. */
type MentionFilter = (ownerId: string, authorId: string) => Promise<boolean>;

/** DmManager's side of a direct message (spec M2c §2). */
export interface DmHooks {
  /** Throws when `author` may not write to `otherId` (NO_USER, BLOCKED). */
  check(author: IdentityPublic, otherId: string): Promise<void>;
  /** After a DM is stored: records it for both people and returns who should see it now. */
  stored(message: ChatMessage, otherId: string): Promise<string[]>;
}
/** GroupManager's side of a group line (spec M2d §2). */
export interface GroupHooks {
  /** Throws unless `author` may post in the group (NO_GROUP, NOT_MEMBER). */
  check(author: IdentityPublic, groupId: string): Promise<void>;
  /** What `viewer` may read: messages after `after`, minus lines by `hidden` authors. Throws NOT_MEMBER / NO_GROUP. */
  view(viewer: IdentityPublic | null | undefined, groupId: string): Promise<{ after: number; hidden: string[] }>;
  /** After a line is stored: records it, and returns who should see it now. */
  stored(message: ChatMessage, groupId: string): Promise<string[]>;
}
type Row = { m: typeof messages.$inferSelect; i: typeof identities.$inferSelect | null };

/**
 * A stored row as the wire sees it: a removed message keeps its place but loses its words —
 * unless `viewer` is a mod or admin, who gets the original text back (S145-146: it stays visible
 * to mods). `viewer` is undefined or null for an anonymous or non-staff reader.
 */
function toMessage({ m, i }: Row, viewer?: IdentityPublic | null): ChatMessage {
  const removed = m.deletedAt ? { by: m.deletedBy ?? 'a moderator' } : null;
  const staff = viewer?.role === 'mod' || viewer?.role === 'admin';
  return {
    id: m.id,
    channel: m.channel,
    author: i ? toPublic(i) : null,
    text: removed && !staff ? '' : m.text,
    createdAt: m.createdAt.toISOString(),
    system: m.system,
    removed,
  };
}

export class CommunicationManager {
  private inboxes = new Map<string, { cursor: number; events: InboxEvent[] }>();
  private waiters = new Map<string, Set<() => void>>();
  private closed = false;
  private flood: RateLimiter;
  private tableAccess: Access = () => null;
  private matchAccess: Access = () => null;
  private matchTable: MatchTable = async () => null;
  private mentionFilter: MentionFilter = async () => false;
  private dmHooks: DmHooks = { check: async () => {}, stored: async (m, other) => [m.author!.id, other] };

  private groupHooks: GroupHooks = {
    check: async () => {
      throw forbidden('NOT_MEMBER', "You're not in this group.");
    },
    view: async () => {
      throw forbidden('NOT_MEMBER', "You're not in this group.");
    },
    stored: async () => [],
  };

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private identities: IdentityManager,
    private opts: { publicChannels: readonly string[]; guard: Guard },
  ) {
    this.flood = new RateLimiter(clock, 5, 1 / 2000);
  }

  /** TableManager: who may post at `table:<id>` (and whether `rail:<id>` still exists). */
  setTableAccess(fn: Access): void {
    this.tableAccess = fn;
  }

  /** GameManager: who may post at a tableless match's `match:<id>`. */
  setMatchAccess(fn: Access): void {
    this.matchAccess = fn;
  }

  /** The table a match was played at, so `match:<id>` can stand for `table:<id>`. */
  setMatchTable(fn: MatchTable): void {
    this.matchTable = fn;
  }

  setMentionFilter(fn: MentionFilter): void {
    this.mentionFilter = fn;
  }

  setDmHooks(hooks: DmHooks): void {
    this.dmHooks = hooks;
  }

  setGroupHooks(hooks: GroupHooks): void {
    this.groupHooks = hooks;
  }

  channelKind(channel: string): ChannelKind | null {
    if (channel === DIARY_CHANNEL) return 'diary';
    if (this.opts.publicChannels.includes(channel)) return 'public';
    if (TABLE_RE.test(channel)) return 'table';
    if (RAIL_RE.test(channel)) return 'rail';
    if (MATCH_RE.test(channel)) return 'match';
    if (dmParticipants(channel)) return 'dm';
    if (groupOf(channel) !== null) return 'group';
    return null;
  }

  /** `match:<id>` names its match's table channel when the match has one; everything else is itself. */
  async resolve(channel: string): Promise<string> {
    const m = MATCH_RE.exec(channel);
    if (!m) return channel;
    const tableId = await this.matchTable(m[1]);
    return tableId ? tableChannel(tableId) : channel;
  }

  private noChannel(rawChannel: string) {
    return notFound('NO_CHANNEL', (RETIRED_CHANNELS as readonly string[]).includes(rawChannel) ? `#${rawChannel} is retired; talk in #lobby.` : `There is no channel "${rawChannel}".`);
  }

  async post(author: IdentityPublic, rawChannel: string, rawText: unknown): Promise<ChatMessage> {
    const channel = await this.resolve(rawChannel);
    const kind = this.channelKind(channel);
    if (!kind) throw this.noChannel(rawChannel);
    this.opts.guard.assert(author, 'chat');
    if (kind === 'dm') {
      const pair = dmParticipants(channel)!;
      if (!pair.includes(author.id)) throw forbidden('NOT_YOURS', 'That conversation is between two other people.');
      await this.dmHooks.check(author, pair[0] === author.id ? pair[1] : pair[0]);
    }
    if (kind === 'diary' && author.role !== 'admin') throw forbidden('READ_ONLY', "#diary is the Proprietor's channel.");
    if (kind === 'table' || kind === 'match') {
      const id = channel.slice(channel.indexOf(':') + 1);
      const access = kind === 'table' ? this.tableAccess(id) : this.matchAccess(id);
      if (!access || !access.posters.includes(author.id)) {
        throw forbidden('NOT_AT_TABLE', 'Only the players can talk at this table.');
      }
    }
    if (kind === 'rail' && !this.tableAccess(channel.slice('rail:'.length))) {
      throw notFound('NO_TABLE', 'This table has been cleared.');
    }
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw badRequest('EMPTY', 'Say something.');
    if (text.length > MAX_TEXT) throw badRequest('TOO_LONG', `Messages are at most ${MAX_TEXT} characters.`);
    // Slurs are refused everywhere, table chat included; trash talk stays, cruelty does not.
    if (containsSlur(text)) throw badRequest('FILTERED', 'That message contains a slur. Not here, not ever.');
    if (!this.flood.take(author.id)) throw tooMany('SLOW_DOWN', 'Easy there — one message every two seconds.');
    // Players' table talk is uncensored (trash talk is the point); the rail is a public room.
    return this.insert(channel, author, kind === 'public' || kind === 'rail' ? censorText(text) : text, false);
  }

  async postSystem(channel: string, text: string): Promise<ChatMessage> {
    // Author-less lines would fall through to chat.message and the mention fan-out.
    if (dmParticipants(channel)) throw badRequest('NO_SYSTEM_DM', 'System lines cannot be posted to a direct message.');
    return this.insert(channel, null, text, true);
  }

  private async insert(channel: string, author: IdentityPublic | null, text: string, system: boolean): Promise<ChatMessage> {
    const [row] = await this.db
      .insert(messages)
      .values({ channel, authorId: author?.id ?? null, text, system, createdAt: new Date(this.clock.now()) })
      .returning();
    const message: ChatMessage = { id: row.id, channel, author, text, createdAt: row.createdAt.toISOString(), system, removed: null };
    const pair = dmParticipants(channel);
    if (pair && author) {
      // A DM never reaches channel listeners or mention inboxes: only the two, and only those the hooks allow.
      const other = pair[0] === author.id ? pair[1] : pair[0];
      const to = (await this.dmHooks.stored(message, other)).filter((id) => pair.includes(id));
      this.bus.emit('dm.message', { message, to });
      if (to.includes(other)) this.deliver(other, { type: 'chat.dm', message });
      return message;
    }
    this.bus.emit('chat.message', message);
    await this.fanOut(message);
    return message;
  }

  private async fanOut(message: ChatMessage): Promise<void> {
    const notified = new Set<string>();
    if (message.author) notified.add(message.author.id);
    const table = TABLE_RE.exec(message.channel);
    const legacy = MATCH_RE.exec(message.channel);
    const posters = table ? this.tableAccess(table[1])?.posters : legacy ? this.matchAccess(legacy[1])?.posters : undefined;
    for (const id of posters ?? []) {
      if (notified.has(id)) continue;
      this.deliver(id, { type: 'chat.table', message });
      notified.add(id);
    }
    for (const m of message.text.matchAll(MENTION_RE)) {
      const target = await this.identities.getByHandle(m[1]);
      if (!target || notified.has(target.id)) continue;
      notified.add(target.id);
      if (message.author && (await this.mentionFilter(target.id, message.author.id))) continue;
      this.deliver(target.id, { type: 'chat.mention', message });
    }
  }

  private select() {
    return this.db.select({ m: messages, i: identities }).from(messages).leftJoin(identities, eq(messages.authorId, identities.id));
  }

  async history(
    rawChannel: string,
    opts: { since?: number; before?: number; limit?: number; viewer?: IdentityPublic | null } = {},
  ): Promise<ChatMessage[]> {
    const channel = await this.resolve(rawChannel);
    if (!this.channelKind(channel)) throw this.noChannel(rawChannel);
    const pair = dmParticipants(channel);
    if (pair && !(opts.viewer && pair.includes(opts.viewer.id))) {
      throw forbidden('NOT_YOURS', 'Only the two people in a conversation can read it.');
    }
    const groupId = groupOf(channel);
    const view = groupId ? await this.groupHooks.view(opts.viewer, groupId) : null;
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const inChannel = view ? and(eq(messages.channel, channel), gt(messages.id, view.after)) : eq(messages.channel, channel);
    const where =
      opts.since !== undefined
        ? and(inChannel, gt(messages.id, opts.since))
        : opts.before !== undefined
          ? and(inChannel, lt(messages.id, opts.before))
          : inChannel;
    const rows = await this.select()
      .where(where)
      .orderBy(opts.since !== undefined ? asc(messages.id) : desc(messages.id))
      .limit(limit);
    const ordered = opts.since !== undefined ? rows : rows.reverse();
    const hidden = new Set(view?.hidden ?? []);
    return ordered.filter(({ m }) => !(m.authorId && hidden.has(m.authorId))).map((row) => toMessage(row, opts.viewer));
  }

  async message(messageId: number, viewer?: IdentityPublic | null): Promise<ChatMessage | null> {
    const [row] = await this.select().where(eq(messages.id, messageId)).limit(1);
    return row ? toMessage(row, viewer) : null;
  }

  /** Up to `span` lines either side of a message in its channel, plus the message; oldest first. */
  async around(messageId: number, span: number): Promise<ChatMessage[]> {
    const center = await this.message(messageId);
    if (!center) return [];
    const before = await this.select()
      .where(and(eq(messages.channel, center.channel), lt(messages.id, messageId)))
      .orderBy(desc(messages.id))
      .limit(span);
    const after = await this.select()
      .where(and(eq(messages.channel, center.channel), gt(messages.id, messageId)))
      .orderBy(asc(messages.id))
      .limit(span);
    return [...before.reverse().map((row) => toMessage(row)), center, ...after.map((row) => toMessage(row))];
  }

  /** Blanks a message for everyone (the caller has already checked the power). Idempotent. */
  async remove(messageId: number, remover: IdentityPublic | null): Promise<ChatMessage> {
    const found = await this.message(messageId);
    if (!found || found.system) throw notFound('NO_MESSAGE', 'There is no such message.');
    if (found.removed) return found;
    const by = remover ? remover.handle : 'console';
    await this.db
      .update(messages)
      .set({ deletedAt: new Date(this.clock.now()), deletedBy: by })
      .where(eq(messages.id, messageId));
    this.bus.emit('chat.removed', { channel: found.channel, id: messageId, by });
    return { ...found, text: '', removed: { by } };
  }

  deliver(identityId: string, input: InboxEventInput): InboxEvent {
    const box = this.inboxes.get(identityId) ?? { cursor: 0, events: [] };
    box.cursor += 1;
    const event = { ...input, cursor: box.cursor, at: new Date(this.clock.now()).toISOString() } as InboxEvent;
    box.events.push(event);
    if (box.events.length > INBOX_SIZE) box.events.shift();
    this.inboxes.set(identityId, box);
    const waiting = this.waiters.get(identityId);
    if (waiting) {
      this.waiters.delete(identityId);
      for (const wake of waiting) wake();
    }
    this.bus.emit('inbox', { identityId, event });
    return event;
  }

  /** Shutting down: every parked inbox poll answers now, and later ones don't wait. */
  close(): void {
    this.closed = true;
    const waiting = [...this.waiters.values()].flatMap((set) => [...set]);
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  async poll(identityId: string, since: number, waitMs: number): Promise<InboxPoll> {
    const current = this.inboxes.get(identityId)?.cursor ?? 0;
    // A cursor ahead of ours (e.g. from before a server restart) is treated as "now", and flagged.
    const base = Math.min(since, current);
    const ahead = since > current;
    const read = (): InboxPoll => {
      const box = this.inboxes.get(identityId);
      if (!box) return { cursor: 0, events: [], gap: ahead };
      const events = box.events.filter((e) => e.cursor > base);
      const oldest = box.events[0]?.cursor ?? box.cursor + 1;
      return { cursor: box.cursor, events, gap: ahead || base < oldest - 1 };
    };
    const first = read();
    if (first.events.length > 0 || waitMs <= 0 || this.closed) return first;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(identityId) ?? new Set<() => void>();
      let timer: unknown = null;
      const finish = () => {
        this.clock.clearTimeout(timer);
        set.delete(finish);
        resolve();
      };
      set.add(finish);
      this.waiters.set(identityId, set);
      timer = this.clock.setTimeout(finish, waitMs);
    });
    return read();
  }
}

import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { censorText, containsSlur } from '@cs/shared/filter';
import {
  DIARY_CHANNEL,
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
const TABLE_RE = /^match:([A-Za-z0-9_]+)$/;
const MENTION_RE = /@([A-Za-z0-9_-]{3,20})/g;

type TableAccess = (matchId: string) => { playerIds: string[] } | null;
/** True means "don't deliver": the mentioned person ignores or blocks the author. */
type MentionFilter = (ownerId: string, authorId: string) => Promise<boolean>;
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
  private flood: RateLimiter;
  private tableAccess: TableAccess = () => null;
  private mentionFilter: MentionFilter = async () => false;

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private identities: IdentityManager,
    private opts: { publicChannels: readonly string[]; guard: Guard },
  ) {
    this.flood = new RateLimiter(clock, 5, 1 / 2000);
  }

  setTableAccess(fn: TableAccess): void {
    this.tableAccess = fn;
  }

  setMentionFilter(fn: MentionFilter): void {
    this.mentionFilter = fn;
  }

  channelKind(channel: string): 'public' | 'diary' | 'table' | null {
    if (channel === DIARY_CHANNEL) return 'diary';
    if (this.opts.publicChannels.includes(channel)) return 'public';
    if (TABLE_RE.test(channel)) return 'table';
    return null;
  }

  async post(author: IdentityPublic, channel: string, rawText: unknown): Promise<ChatMessage> {
    const kind = this.channelKind(channel);
    if (!kind) throw notFound('NO_CHANNEL', `There is no channel "${channel}".`);
    this.opts.guard.assert(author, 'chat');
    if (kind === 'diary' && author.role !== 'admin') throw forbidden('READ_ONLY', "#diary is the Proprietor's channel.");
    if (kind === 'table') {
      const table = this.tableAccess(channel.slice('match:'.length));
      if (!table || !table.playerIds.includes(author.id)) {
        throw forbidden('NOT_AT_TABLE', 'Only the players can talk at this table.');
      }
    }
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw badRequest('EMPTY', 'Say something.');
    if (text.length > MAX_TEXT) throw badRequest('TOO_LONG', `Messages are at most ${MAX_TEXT} characters.`);
    // Slurs are refused everywhere, table chat included; trash talk stays, cruelty does not.
    if (containsSlur(text)) throw badRequest('FILTERED', 'That message contains a slur. Not here, not ever.');
    if (!this.flood.take(author.id)) throw tooMany('SLOW_DOWN', 'Easy there — one message every two seconds.');
    return this.insert(channel, author, kind === 'public' ? censorText(text) : text, false);
  }

  postSystem(channel: string, text: string): Promise<ChatMessage> {
    return this.insert(channel, null, text, true);
  }

  private async insert(channel: string, author: IdentityPublic | null, text: string, system: boolean): Promise<ChatMessage> {
    const [row] = await this.db
      .insert(messages)
      .values({ channel, authorId: author?.id ?? null, text, system, createdAt: new Date(this.clock.now()) })
      .returning();
    const message: ChatMessage = { id: row.id, channel, author, text, createdAt: row.createdAt.toISOString(), system, removed: null };
    this.bus.emit('chat.message', message);
    await this.fanOut(message);
    return message;
  }

  private async fanOut(message: ChatMessage): Promise<void> {
    const notified = new Set<string>();
    if (message.author) notified.add(message.author.id);
    const table = TABLE_RE.exec(message.channel);
    if (table) {
      for (const id of this.tableAccess(table[1])?.playerIds ?? []) {
        if (notified.has(id)) continue;
        this.deliver(id, { type: 'chat.table', message });
        notified.add(id);
      }
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
    channel: string,
    opts: { since?: number; limit?: number; viewer?: IdentityPublic | null } = {},
  ): Promise<ChatMessage[]> {
    if (!this.channelKind(channel)) throw notFound('NO_CHANNEL', `There is no channel "${channel}".`);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const where =
      opts.since !== undefined ? and(eq(messages.channel, channel), gt(messages.id, opts.since)) : eq(messages.channel, channel);
    const rows = await this.select()
      .where(where)
      .orderBy(opts.since !== undefined ? asc(messages.id) : desc(messages.id))
      .limit(limit);
    const ordered = opts.since !== undefined ? rows : rows.reverse();
    return ordered.map((row) => toMessage(row, opts.viewer));
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
    if (first.events.length > 0 || waitMs <= 0) return first;
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

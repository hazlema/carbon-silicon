import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { censorText } from '@cs/shared/filter';
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
import { toPublic, type IdentityManager } from './identity';

const INBOX_SIZE = 500;
const MAX_TEXT = 500;
const TABLE_RE = /^match:([A-Za-z0-9_]+)$/;
const MENTION_RE = /@([A-Za-z0-9_-]{3,20})/g;

type TableAccess = (matchId: string) => { playerIds: string[] } | null;

export class CommunicationManager {
  private inboxes = new Map<string, { cursor: number; events: InboxEvent[] }>();
  private waiters = new Map<string, Set<() => void>>();
  private flood: RateLimiter;
  private tableAccess: TableAccess = () => null;

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private identities: IdentityManager,
    private opts: { publicChannels: readonly string[] },
  ) {
    this.flood = new RateLimiter(clock, 5, 1 / 2000);
  }

  setTableAccess(fn: TableAccess): void {
    this.tableAccess = fn;
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
    const message: ChatMessage = { id: row.id, channel, author, text, createdAt: row.createdAt.toISOString(), system };
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
      this.deliver(target.id, { type: 'chat.mention', message });
      notified.add(target.id);
    }
  }

  async history(channel: string, opts: { since?: number; limit?: number } = {}): Promise<ChatMessage[]> {
    if (!this.channelKind(channel)) throw notFound('NO_CHANNEL', `There is no channel "${channel}".`);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const where =
      opts.since !== undefined
        ? and(eq(messages.channel, channel), isNull(messages.deletedAt), gt(messages.id, opts.since))
        : and(eq(messages.channel, channel), isNull(messages.deletedAt));
    const rows = await this.db
      .select({ m: messages, i: identities })
      .from(messages)
      .leftJoin(identities, eq(messages.authorId, identities.id))
      .where(where)
      .orderBy(opts.since !== undefined ? asc(messages.id) : desc(messages.id))
      .limit(limit);
    const ordered = opts.since !== undefined ? rows : rows.reverse();
    return ordered.map(({ m, i }) => ({
      id: m.id,
      channel: m.channel,
      author: i ? toPublic(i) : null,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
      system: m.system,
    }));
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

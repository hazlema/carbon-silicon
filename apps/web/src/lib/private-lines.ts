import type { ChatMessage, DmSummary, IdentityPublic } from '@cs/shared/protocol';
import { dmParticipants, groupOf } from '@cs/shared/protocol';

/**
 * Private lines in a table's chat feed: during a match, your own DMs and group lines (and, in Salvo, the
 * whispers you won) show inline in your home feed (Table for players, the Rail for spectators), marked
 * private. They're merged on this page only: the table's channel never hears them.
 */

/** Where a reply from the feed goes: a DM (by the other's handle) or a group (by its channel). */
export type ReplyTarget = { kind: 'dm'; channel: string; handle: string } | { kind: 'group'; channel: string; title: string };

export interface PrivateLine {
  /** Unique across kinds: `m<message id>` or `w<n>`. */
  key: string;
  /** The message id (a DM or group line) or the whisper's index: the tie-break between lines said at the same time. */
  seq: number;
  /** Epoch ms, for its place among the table's lines. */
  at: number;
  kind: 'dm' | 'group' | 'whisper';
  /** Your own line (a DM or group line you sent). */
  mine: boolean;
  /** Who's talking to whom, before the colon: "@Fable → you", "you → @Fable", "#name · @Fable", "@GAME_OVER whispers to you". */
  head: string;
  text: string;
  /** Clicking the line replies here; null for a whisper. */
  reply: ReplyTarget | null;
  /** The line's author, for its colour and kind (null for a whisper). */
  author: IdentityPublic | null;
}

/** The pieces a DM or group line needs to be told: who you are and who the conversations are with. */
export interface ConvLookup {
  meId: string;
  /** The other person in a DM channel, if known. */
  dmWith: (channel: string) => IdentityPublic | null;
  /** A group channel's title (its name, or its people), if known. */
  groupTitle: (channel: string) => string | null;
}

/** A DM or group line as a private line; null when it can't be told (a system line, a conversation not yet known). */
export function convLine(m: ChatMessage, c: ConvLookup): PrivateLine | null {
  if (m.system || m.removed || !m.author) return null;
  const mine = m.author.id === c.meId;
  const at = Date.parse(m.createdAt);
  if (dmParticipants(m.channel)) {
    const other = mine ? c.dmWith(m.channel) : m.author;
    if (!other) return null;
    return {
      key: `m${m.id}`,
      seq: m.id,
      at,
      kind: 'dm',
      mine,
      head: mine ? `you → @${other.handle}` : `@${other.handle} → you`,
      text: m.text,
      reply: { kind: 'dm', channel: m.channel, handle: other.handle },
      author: m.author,
    };
  }
  if (groupOf(m.channel)) {
    const title = c.groupTitle(m.channel);
    if (title === null) return null;
    return {
      key: `m${m.id}`,
      seq: m.id,
      at,
      kind: 'group',
      mine,
      head: `#${title} · ${mine ? 'you' : `@${m.author.handle}`}`,
      text: m.text,
      reply: { kind: 'group', channel: m.channel, title },
      author: m.author,
    };
  }
  return null;
}

/** A Salvo whisper you won, as the view gives it. */
export interface WhisperWon {
  ghost: string;
  sea: string;
  cells: string[];
  said: number;
  paid?: number;
  at?: number | null;
}

/** "c3–e5": a 3×3 by its corners. */
const areaName = (cells: string[]) => `${cells[0]}–${cells.at(-1)}`;

/**
 * `👻 @GAME_OVER whispers to you: 3 ship cells in @OLD_IRON's c3–e5 (you paid 4 scrap)`. `handleOf` names a seat;
 * `fallbackAt` places a whisper whose close time the view doesn't carry (a match saved before it did).
 */
export function whisperLine(w: WhisperWon, n: number, handleOf: (seat: string) => string, fallbackAt: number): PrivateLine {
  const cells = `${w.said} ship ${w.said === 1 ? 'cell' : 'cells'}`;
  const paid = typeof w.paid === 'number' ? ` (you paid ${w.paid} scrap)` : '';
  return {
    key: `w${n}`,
    seq: n,
    at: typeof w.at === 'number' ? w.at : fallbackAt,
    kind: 'whisper',
    mine: false,
    head: `@${handleOf(w.ghost)} whispers to you`,
    text: `${cells} in @${handleOf(w.sea)}'s ${areaName(w.cells)}${paid}`,
    reply: null,
    author: null,
  };
}

export type Merged<T> = { kind: 'feed'; item: T } | { kind: 'private'; line: PrivateLine };

/**
 * The feed's own items (already in order) with the private lines slotted in by time: each private line goes
 * before the first item said after it (ties stay after the table's line). Private lines are ordered by time, then
 * conversation lines before whispers, then by number (message id or whisper index).
 */
export function mergeByTime<T>(items: T[], timeOf: (item: T) => number, lines: PrivateLine[]): Merged<T>[] {
  const whisper = (l: PrivateLine) => (l.kind === 'whisper' ? 1 : 0);
  const priv = [...lines].sort((a, b) => a.at - b.at || whisper(a) - whisper(b) || a.seq - b.seq);
  const out: Merged<T>[] = [];
  let i = 0;
  for (const item of items) {
    const t = timeOf(item);
    while (i < priv.length && priv[i].at < t) out.push({ kind: 'private', line: priv[i++] });
    out.push({ kind: 'feed', item });
  }
  while (i < priv.length) out.push({ kind: 'private', line: priv[i++] });
  return out;
}

/**
 * `/w @bob hi`, `/msg @bob hi` (or `/w@bob hi`) → { handle: 'bob', text: 'hi' } (handle or text may be empty: the
 * composer then says how to use it); null when the line is neither command.
 */
export function parsePrivateCommand(text: string): { handle: string; text: string } | null {
  const m = /^\/(?:w|msg)(?:(?:\s+@?|@)(\S+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  return { handle: m[1] ?? '', text: (m[2] ?? '').trim() };
}

/** A line that reads as a slash command (`/wisper @bob hi`): in a table's feed one the composer doesn't know is refused, never posted. */
export const looksLikeCommand = (text: string): boolean => /^\/[a-z]/i.test(text.trim());

/**
 * During a live match, conversations with residents (house bots) stay inline only: the DMs with a house identity
 * that have spoken since `since` (the match's start, epoch ms) keep out of the tab row, unless it's the one on
 * screen (`open`, e.g. opened from a name menu on purpose). Other people's DMs and groups keep their tabs.
 */
export function quietChannels(dms: DmSummary[], since: number, open: string | null): Set<string> {
  return new Set(
    dms.filter((d) => d.with.isHouse && d.channel !== open && !!d.last && Date.parse(d.last.createdAt) >= since).map((d) => d.channel),
  );
}

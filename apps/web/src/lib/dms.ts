import type { ChatMessage, DmSummary, IdentityPublic } from '@cs/shared/protocol';

/** DM tabs in the row before the rest fold into More (spec M2c §5). */
export const DM_TABS = 4;
const MAX_UNREAD = 99;

/** `/msg @bob hello there` → { handle: 'bob', text: 'hello there' }. Handle or text may come back
 *  empty (the composer then says how to use it); null when the line isn't a /msg command at all. */
export function parseMsgCommand(text: string): { handle: string; text: string } | null {
  const m = /^\/msg(?:\s+@?(\S+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  return { handle: m[1] ?? '', text: (m[2] ?? '').trim() };
}

/** Newest first; a conversation opened but not yet written to counts as the newest. */
const newest = (d: DmSummary) => d.last?.id ?? Number.MAX_SAFE_INTEGER;

/** The tab row: open conversations newest first, `max` of them, the rest under More. The one on
 *  screen (`open`) always has a tab, even if it was closed or is old. */
export function dmTabs(list: DmSummary[], open: string | null, max = DM_TABS): { shown: DmSummary[]; more: DmSummary[] } {
  const visible = list.filter((d) => !d.hidden || d.channel === open).sort((a, b) => newest(b) - newest(a));
  let shown = visible.slice(0, max);
  const current = visible.find((d) => d.channel === open);
  if (current && !shown.includes(current)) shown = [...shown.slice(0, max - 1), current];
  return { shown, more: visible.filter((d) => !shown.includes(d)) };
}

/** The Lobby count: unread across visible conversations only (closing doesn't mark read). */
export const unreadTotal = (list: DmSummary[]): number => list.reduce((n, d) => n + (d.hidden ? 0 : d.unread), 0);

/** The list after a DM arrives or is sent: that conversation moves to the front and opens; theirs
 *  counts as unread, yours means you've read it. The same message twice changes nothing. */
export function withMessage(list: DmSummary[], message: ChatMessage, other: IdentityPublic, meId: string): DmSummary[] {
  const prev = list.find((d) => d.channel === message.channel);
  if (prev?.last && prev.last.id >= message.id) return list;
  const fromThem = message.author?.id !== meId;
  const next: DmSummary = {
    with: prev?.with ?? other,
    channel: message.channel,
    last: message,
    unread: fromThem ? Math.min(MAX_UNREAD, (prev?.unread ?? 0) + 1) : 0,
    hidden: false,
  };
  return [next, ...list.filter((d) => d.channel !== message.channel)];
}

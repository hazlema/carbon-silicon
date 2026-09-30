import type { ChatMessage, DmSummary, GroupInfo } from '@cs/shared/protocol';
import { DM_TABS } from './dms';

const MAX_UNREAD = 99;

/** A group's tab title: its name, or its people, you first and then in the order they joined (ties by handle). */
export function groupTitle(g: GroupInfo, meId: string): string {
  if (g.name) return g.name;
  const others = g.members
    .filter((m) => m.identity.id !== meId)
    // People who joined in the same instant (a group's first members) fall back to handle order, so the title never flickers.
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt, undefined, { numeric: true }) || a.identity.handle.localeCompare(b.identity.handle))
    .map((m) => m.identity.handle);
  return ['you', ...others].join(', ');
}

/** The list after a line lands in a group: it moves to the front and its tab reopens. Theirs counts
 *  as unread, yours means you've read it; a system line ("@x left.") does neither, and never reopens
 *  a closed tab. The same line twice changes nothing. */
export function withGroupMessage(list: GroupInfo[], message: ChatMessage, meId: string): GroupInfo[] {
  const prev = list.find((g) => g.channel === message.channel);
  if (!prev || (prev.last && prev.last.id >= message.id)) return list;
  const person = !message.system;
  const next: GroupInfo = {
    ...prev,
    last: message,
    unread: !person ? prev.unread : message.author?.id === meId ? 0 : Math.min(MAX_UNREAD, prev.unread + 1),
    hidden: person ? false : prev.hidden,
  };
  return [next, ...list.filter((g) => g !== prev)];
}

export type Conv = { kind: 'dm'; channel: string; dm: DmSummary } | { kind: 'group'; channel: string; group: GroupInfo };

export const convUnread = (c: Conv): number => (c.kind === 'dm' ? c.dm.unread : c.group.unread);
const newest = (c: Conv) => (c.kind === 'dm' ? c.dm.last : c.group.last)?.id ?? Number.MAX_SAFE_INTEGER;
const hidden = (c: Conv) => (c.kind === 'dm' ? c.dm.hidden : c.group.hidden);

/** The one tab row: DMs and groups together, newest first, `max` shown and the rest under More.
 *  The one on screen (`open`) always has a tab. */
export function convTabs(dms: DmSummary[], groups: GroupInfo[], open: string | null, max = DM_TABS): { shown: Conv[]; more: Conv[] } {
  const all: Conv[] = [
    ...dms.map((dm): Conv => ({ kind: 'dm', channel: dm.channel, dm })),
    ...groups.map((group): Conv => ({ kind: 'group', channel: group.channel, group })),
  ];
  const visible = all.filter((c) => !hidden(c) || c.channel === open).sort((a, b) => newest(b) - newest(a));
  let shown = visible.slice(0, max);
  const current = visible.find((c) => c.channel === open);
  if (current && !shown.includes(current)) shown = [...shown.slice(0, max - 1), current];
  return { shown, more: visible.filter((c) => !shown.includes(c)) };
}

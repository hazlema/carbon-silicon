import { dmParticipants, groupOf, type ChatMessage } from '@cs/shared/protocol';

/** How long the "new message" balloon stays, from the latest line it tells of. */
export const BUBBLE_MS = 10_000;

/** A line that earns the balloon: where it was said, and how to name that conversation. */
export interface Arrival {
  id: number;
  channel: string;
  kind: 'dm' | 'group';
  /** `@fable` for a DM, `#crew` for a group. */
  label: string;
}

export interface ArrivalContext {
  meId: string | null;
  /** Authors you ignore or block. */
  hidden: ReadonlySet<string>;
  /** The conversation on screen right now, if any (null when the chat itself is out of sight). */
  open: string | null;
  /** Conversations kept off the tab row (a table's residents during a match): their lines are inline already. */
  hide?: ReadonlySet<string>;
  /** A group's label (`#name`), or null if this page doesn't know the group yet. */
  groupLabel: (channel: string) => string | null;
}

/** Whether a DM or group line that just arrived earns the balloon: someone else's (not ignored or blocked),
 *  in a conversation you aren't looking at, whose tab is on the row. */
export function bubbleArrival(m: ChatMessage, ctx: ArrivalContext): Arrival | null {
  if (m.system || m.removed || !m.author || !ctx.meId) return null;
  if (m.author.id === ctx.meId || ctx.hidden.has(m.author.id)) return null;
  if (m.channel === ctx.open || ctx.hide?.has(m.channel)) return null;
  if (dmParticipants(m.channel)) return { id: m.id, channel: m.channel, kind: 'dm', label: `@${m.author.handle}` };
  if (groupOf(m.channel)) {
    // A group the page hasn't loaded yet: name who spoke instead.
    const label = ctx.groupLabel(m.channel);
    return label ? { id: m.id, channel: m.channel, kind: 'group', label } : { id: m.id, channel: m.channel, kind: 'dm', label: `@${m.author.handle}` };
  }
  return null;
}

/** The arrivals after one more (the same line twice counts once). */
export function withArrival(list: Arrival[], a: Arrival): Arrival[] {
  return list.some((x) => x.id === a.id) ? list : [...list, a];
}

/** The balloon's words: one line names its conversation; several in one conversation count and name it; several across conversations just count. */
export function bubbleText(list: Arrival[]): string {
  const last = list.at(-1);
  if (!last) return '';
  const where = (a: Arrival) => (a.kind === 'group' ? `in ${a.label}` : `from ${a.label}`);
  if (list.length === 1) return `💬 New message ${where(last)}!`;
  const one = list.every((a) => a.channel === last.channel);
  return one ? `💬 ${list.length} new messages ${where(last)}` : `💬 ${list.length} new messages`;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the balloon sits around what it points at. `side` is the balloon's edge the tail grows from; `tail` is how far
 *  along that edge (px from its start) the tail's tip lines up with the anchor's middle. */
export interface Spot {
  left: number;
  top: number;
  side: 'top' | 'bottom' | 'right';
  tail: number;
}

const GAP = 12;
const MARGIN = 8;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Places a `w`×`h` balloon by an anchor in a `vw`×`vh` viewport. `below`: under it (over it when there's no room
 *  under), centred and kept on screen; `left`: to its left, middles level (the phone's chat button in the corner). */
export function bubbleSpot(a: Rect, w: number, h: number, vw: number, vh: number, place: 'below' | 'left'): Spot {
  const cx = (a.left + a.right) / 2;
  const cy = (a.top + a.bottom) / 2;
  if (place === 'left') {
    const top = clamp(cy - h / 2, MARGIN, Math.max(MARGIN, vh - h - MARGIN));
    return { left: Math.max(MARGIN, a.left - GAP - w), top, side: 'right', tail: clamp(cy - top, 14, h - 14) };
  }
  const left = clamp(cx - w / 2, MARGIN, Math.max(MARGIN, vw - w - MARGIN));
  const tail = clamp(cx - left, 18, w - 18);
  const under = a.bottom + GAP;
  if (under + h <= vh - MARGIN || a.top - GAP - h < MARGIN) return { left, top: under, side: 'top', tail };
  return { left, top: a.top - GAP - h, side: 'bottom', tail };
}

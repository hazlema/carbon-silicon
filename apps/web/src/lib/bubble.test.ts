import { describe, expect, test } from 'bun:test';
import type { ChatMessage, IdentityPublic } from '@cs/shared/protocol';
import { bubbleArrival, bubbleSpot, bubbleText, withArrival, type Arrival, type ArrivalContext } from './bubble';

const person = (id: string): IdentityPublic => ({
  id, handle: id, kind: 'human', tagline: null, color: '#fff', model: null, isHouse: false, locked: false, role: 'user', ownerHandle: null, released: false,
});
const DM = 'dm:fable:me';
const GRP = 'grp:g_0123456789abcdef';
const msg = (id: number, channel: string, author: IdentityPublic | null, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, channel, author, text: `m${id}`, createdAt: '2026-10-09T12:00:00.000Z', system: false, removed: null, ...over,
});
const me = person('me');
const fable = person('Fable');
const ctx = (over: Partial<ArrivalContext> = {}): ArrivalContext => ({
  meId: me.id, hidden: new Set(), open: null, groupLabel: (ch) => (ch === GRP ? '#crew' : null), ...over,
});

describe('bubbleArrival', () => {
  test('a DM or group line from someone else, in a conversation not on screen, earns the balloon', () => {
    expect(bubbleArrival(msg(1, DM, fable), ctx())).toEqual({ id: 1, channel: DM, kind: 'dm', label: '@Fable' });
    expect(bubbleArrival(msg(2, GRP, fable), ctx({ open: DM }))).toEqual({ id: 2, channel: GRP, kind: 'group', label: '#crew' });
  });
  test('never your own line, an ignored or blocked author, a system or removed line', () => {
    expect(bubbleArrival(msg(1, DM, me), ctx())).toBeNull();
    expect(bubbleArrival(msg(1, DM, fable), ctx({ hidden: new Set([fable.id]) }))).toBeNull();
    expect(bubbleArrival(msg(1, GRP, null, { system: true }), ctx())).toBeNull();
    expect(bubbleArrival(msg(1, GRP, fable, { system: true }), ctx())).toBeNull();
    expect(bubbleArrival(msg(1, DM, fable, { removed: { by: 'mod' } }), ctx())).toBeNull();
  });
  test('not for the conversation on screen, one kept off the tab row, or a table channel; nothing signed out', () => {
    expect(bubbleArrival(msg(1, DM, fable), ctx({ open: DM }))).toBeNull();
    expect(bubbleArrival(msg(1, DM, fable), ctx({ hide: new Set([DM]) }))).toBeNull();
    expect(bubbleArrival(msg(1, 'table:t_1', fable), ctx())).toBeNull();
    expect(bubbleArrival(msg(1, DM, fable), ctx({ meId: null }))).toBeNull();
  });
  test('a group the page has not loaded yet names who spoke', () => {
    expect(bubbleArrival(msg(1, 'grp:g_ffffffffffffffff', fable), ctx())).toMatchObject({ kind: 'dm', label: '@Fable' });
  });
});

describe('bubbleText', () => {
  const a = (id: number, channel = DM, kind: Arrival['kind'] = 'dm', label = '@Fable'): Arrival => ({ id, channel, kind, label });
  test('one line names its conversation', () => {
    expect(bubbleText([a(1)])).toBe('💬 New message from @Fable!');
    expect(bubbleText([a(1, GRP, 'group', '#crew')])).toBe('💬 New message in #crew!');
  });
  test('several in one conversation count and name it; across conversations, just count', () => {
    expect(bubbleText([a(1), a(2), a(3)])).toBe('💬 3 new messages from @Fable');
    expect(bubbleText([a(1, GRP, 'group', '#crew'), a(2, GRP, 'group', '#crew')])).toBe('💬 2 new messages in #crew');
    expect(bubbleText([a(1), a(2, GRP, 'group', '#crew'), a(3)])).toBe('💬 3 new messages');
  });
  test('nothing to tell, no words; the same line twice counts once', () => {
    expect(bubbleText([])).toBe('');
    expect(withArrival(withArrival([], a(1)), a(1))).toHaveLength(1);
    expect(withArrival([a(1)], a(2)).map((x) => x.id)).toEqual([1, 2]);
  });
});

describe('bubbleSpot', () => {
  const tab = { left: 300, top: 50, right: 380, bottom: 80 };
  test('below the tab, centred on it, the tail on top at the tab’s middle', () => {
    expect(bubbleSpot(tab, 200, 40, 1400, 900, 'below')).toEqual({ left: 240, top: 92, side: 'top', tail: 100 });
  });
  test('kept on screen near an edge, the tail still at the anchor (within the rounded corners)', () => {
    const s = bubbleSpot({ left: 0, top: 50, right: 30, bottom: 80 }, 200, 40, 1400, 900, 'below');
    expect(s.left).toBe(8);
    expect(s.tail).toBe(18);
    expect(bubbleSpot({ left: 1380, top: 50, right: 1400, bottom: 80 }, 200, 40, 1400, 900, 'below')).toMatchObject({ left: 1192, tail: 182 });
  });
  test('no room under it: over it, the tail at the bottom', () => {
    expect(bubbleSpot({ left: 300, top: 860, right: 380, bottom: 890 }, 200, 40, 1400, 900, 'below')).toMatchObject({ top: 808, side: 'bottom' });
  });
  test('left of the phone’s chat button, middles level, the tail on the right', () => {
    const fab = { left: 340, top: 740, right: 388, bottom: 788 };
    expect(bubbleSpot(fab, 220, 44, 400, 800, 'left')).toEqual({ left: 108, top: 742, side: 'right', tail: 22 });
  });
});

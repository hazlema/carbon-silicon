import { expect, test } from 'bun:test';
import type { GroupInfo, ChatMessage, DmSummary } from '@cs/shared/protocol';
import { convTabs, groupTitle, withGroupMessage } from './groups';

const id = (x: string) => ({ id: x, handle: x.toUpperCase(), kind: 'human', color: '#fff', isHouse: false, locked: false, role: 'user', ownerHandle: null, released: false, tagline: null, model: null }) as never;
const group = (over: Partial<GroupInfo> = {}): GroupInfo => ({
  id: 'g_1', channel: 'grp:g_1', name: null, ownerId: 'a', maxMembers: 8, bans: [], last: null, unread: 0, hidden: false,
  members: [{ identity: id('b'), joinedAt: '1', owner: false }, { identity: id('a'), joinedAt: '0', owner: true }, { identity: id('c'), joinedAt: '2', owner: false }],
  ...over,
});
const msg = (i: number, author: string | null, channel = 'grp:g_1'): ChatMessage =>
  ({ id: i, channel, author: author ? id(author) : null, text: 't', createdAt: '', system: author === null, removed: null }) as ChatMessage;

test('a group is titled by its name, or by its people with you first', () => {
  expect(groupTitle(group(), 'b')).toBe('you, A, C');
  expect(groupTitle(group({ name: 'crew' }), 'b')).toBe('crew');
});

test('a line moves its group to the front and counts unread unless it is yours or a system line', () => {
  const list = [group(), group({ id: 'g_2', channel: 'grp:g_2' })];
  const next = withGroupMessage(list, msg(5, 'a', 'grp:g_2'), 'b');
  expect(next[0]).toMatchObject({ id: 'g_2', unread: 1, hidden: false, last: { id: 5 } });
  expect(withGroupMessage(next, msg(6, 'b', 'grp:g_2'), 'b')[0].unread).toBe(0);
  expect(withGroupMessage(next, msg(7, null, 'grp:g_2'), 'b')[0].unread).toBe(1);
  expect(withGroupMessage(next, msg(5, 'a', 'grp:g_2'), 'b')).toBe(next); // the same line twice changes nothing
});

test('one tab line: DMs and groups together, newest first, four shown, the open one always shown', () => {
  const dm = (i: number): DmSummary => ({ with: id(`d${i}`), channel: `dm:x${i}:y${i}`, last: msg(i, `d${i}`, `dm:x${i}:y${i}`), unread: 0, hidden: false });
  const groups = [group({ last: msg(10, 'a') }), group({ id: 'g_2', channel: 'grp:g_2', last: msg(1, 'a', 'grp:g_2') })];
  const { shown, more } = convTabs([dm(9), dm(8), dm(7)], groups, 'grp:g_2');
  expect(shown.map((c) => c.channel)).toEqual(['grp:g_1', 'dm:x9:y9', 'dm:x8:y8', 'grp:g_2']);
  expect(more.map((c) => c.channel)).toEqual(['dm:x7:y7']);
});

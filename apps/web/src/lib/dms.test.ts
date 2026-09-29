import { describe, expect, test } from 'bun:test';
import type { ChatMessage, DmSummary, IdentityPublic } from '@cs/shared/protocol';
import { dmTabs, parseMsgCommand, unreadTotal, withMessage } from './dms';

const person = (id: string): IdentityPublic => ({
  id, handle: id, kind: 'human', tagline: null, color: '#fff', model: null, isHouse: false, locked: false, role: 'user', ownerHandle: null, released: false,
});
const msg = (id: number, channel: string, author: IdentityPublic): ChatMessage => ({ id, channel, author, text: `m${id}`, createdAt: '2026-09-29T12:00:00Z', system: false, removed: null });
const convo = (other: string, lastId: number | null, over: Partial<DmSummary> = {}): DmSummary => ({
  with: person(other), channel: `dm:${other}:zz`, last: lastId === null ? null : msg(lastId, `dm:${other}:zz`, person(other)), unread: 0, hidden: false, ...over,
});

describe('parseMsgCommand', () => {
  test('reads a handle and the text; says nothing about other lines', () => {
    expect(parseMsgCommand('/msg @bob hello there')).toEqual({ handle: 'bob', text: 'hello there' });
    expect(parseMsgCommand('  /MSG bob hi ')).toEqual({ handle: 'bob', text: 'hi' });
    expect(parseMsgCommand('/msg @bob')).toEqual({ handle: 'bob', text: '' });
    expect(parseMsgCommand('/msg')).toEqual({ handle: '', text: '' });
    expect(parseMsgCommand('/msgbob hi')).toBeNull();
    expect(parseMsgCommand('hello /msg @bob')).toBeNull();
    expect(parseMsgCommand('/invite @bob')).toBeNull();
  });
});

describe('dmTabs', () => {
  test('newest first, four in the row, the rest under More; closed ones are left out', () => {
    const list = [convo('a', 1), convo('b', 5), convo('c', 3), convo('d', 4), convo('e', 2), convo('f', 9, { hidden: true })];
    const { shown, more } = dmTabs(list, null);
    expect(shown.map((d) => d.with.id)).toEqual(['b', 'd', 'c', 'e']);
    expect(more.map((d) => d.with.id)).toEqual(['a']);
  });
  test('the open conversation always has a tab, even when closed or old; a just-opened one comes first', () => {
    const list = [convo('a', 1), convo('b', 5), convo('c', 3), convo('d', 4), convo('e', 2), convo('new', null)];
    expect(dmTabs(list, 'dm:a:zz').shown.map((d) => d.with.id)).toEqual(['new', 'b', 'd', 'a']);
    expect(dmTabs([convo('h', 1, { hidden: true })], 'dm:h:zz').shown).toHaveLength(1);
  });
});

describe('unread and arrivals', () => {
  test('unreadTotal adds up every open conversation; a closed one cannot hold the count up', () => {
    expect(unreadTotal([convo('a', 1, { unread: 2 }), convo('b', 2, { unread: 3 })])).toBe(5);
    expect(unreadTotal([convo('a', 1, { unread: 2 }), convo('b', 2, { unread: 3, hidden: true })])).toBe(2);
  });
  test('a message from them moves the conversation to the front, reopens it and counts; mine is read', () => {
    const me = person('me');
    const bob = person('bob');
    const ch = 'dm:bob:me';
    const list: DmSummary[] = [{ with: bob, channel: ch, last: null, unread: 0, hidden: true }, convo('x', 9)];
    const after = withMessage(list, msg(10, ch, bob), bob, me.id);
    expect(after[0]).toMatchObject({ channel: ch, unread: 1, hidden: false, last: { id: 10 } });
    expect(withMessage(after, msg(11, ch, me), bob, me.id)[0].unread).toBe(0);
  });
  test('the same message twice counts once; a new conversation starts from the message', () => {
    const me = person('me');
    const bob = person('bob');
    const once = withMessage([], msg(3, 'dm:bob:me', bob), bob, me.id);
    expect(withMessage(once, msg(3, 'dm:bob:me', bob), bob, me.id)).toEqual(once);
    expect(once).toEqual([{ with: bob, channel: 'dm:bob:me', last: msg(3, 'dm:bob:me', bob), unread: 1, hidden: false }]);
  });
});

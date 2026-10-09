import { describe, expect, test } from 'bun:test';
import type { ChatMessage, DmSummary, IdentityPublic } from '@cs/shared/protocol';
import { convLine, mergeByTime, parsePrivateCommand, quietChannels, whisperLine, type ConvLookup } from './private-lines';

const person = (id: string, over: Partial<IdentityPublic> = {}): IdentityPublic => ({
  id, handle: id, kind: 'human', tagline: null, color: '#fff', model: null, isHouse: false, locked: false, role: 'user', ownerHandle: null, released: false, ...over,
});
const T = Date.parse('2026-10-09T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const msg = (id: number, channel: string, author: IdentityPublic | null, at = T, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, channel, author, text: `m${id}`, createdAt: iso(at), system: false, removed: null, ...over,
});
const me = person('me');
const fable = person('fable');
const look: ConvLookup = {
  meId: me.id,
  dmWith: (ch) => (ch === 'dm:fable:me' ? fable : null),
  groupTitle: (ch) => (ch === 'grp:g_0123456789abcdef' ? 'crew' : null),
};

describe('convLine', () => {
  test('a DM from them, mine to them, and a group line, each marked and replying to its conversation', () => {
    expect(convLine(msg(1, 'dm:fable:me', fable), look)).toMatchObject({
      key: 'm1', at: T, kind: 'dm', mine: false, head: '@fable → you', text: 'm1', reply: { kind: 'dm', channel: 'dm:fable:me', handle: 'fable' },
    });
    expect(convLine(msg(2, 'dm:fable:me', me), look)).toMatchObject({ mine: true, head: 'you → @fable', reply: { kind: 'dm', handle: 'fable' } });
    expect(convLine(msg(3, 'grp:g_0123456789abcdef', fable), look)).toMatchObject({ kind: 'group', head: '#crew · @fable', reply: { kind: 'group', channel: 'grp:g_0123456789abcdef', title: 'crew' } });
    expect(convLine(msg(4, 'grp:g_0123456789abcdef', me), look)?.head).toBe('#crew · you');
  });
  test('no line for a system line, a removed one, an unknown conversation, or a table channel', () => {
    expect(convLine(msg(1, 'grp:g_0123456789abcdef', null, T, { system: true, text: '@x left.' }), look)).toBeNull();
    expect(convLine(msg(1, 'dm:fable:me', fable, T, { removed: { by: 'mod' } }), look)).toBeNull();
    expect(convLine(msg(1, 'dm:other:zz', me), look)).toBeNull();
    expect(convLine(msg(1, 'grp:g_ffffffffffffffff', fable), look)).toBeNull();
    expect(convLine(msg(1, 'table:t_1', fable), look)).toBeNull();
  });
});

describe('whisperLine', () => {
  const handles: Record<string, string> = { west: 'GAME_OVER', east: 'OLD_IRON' };
  const cells = ['c3', 'd3', 'e3', 'c4', 'd4', 'e4', 'c5', 'd5', 'e5'];
  test('says who whispered, what, where and what you paid, at its close time', () => {
    const l = whisperLine({ ghost: 'west', sea: 'east', cells, said: 3, paid: 4, at: T + 5 }, 0, (s) => handles[s], T);
    expect(l).toMatchObject({ key: 'w0', at: T + 5, kind: 'whisper', reply: null, head: '@GAME_OVER whispers to you' });
    expect(`${l.head}: ${l.text}`).toBe("@GAME_OVER whispers to you: 3 ship cells in @OLD_IRON's c3–e5 (you paid 4 scrap)");
  });
  test('one cell is a cell; no close time takes the fallback; no price says nothing about it', () => {
    const l = whisperLine({ ghost: 'west', sea: 'east', cells, said: 1, at: null }, 2, (s) => handles[s], T + 9);
    expect(l.text).toBe("1 ship cell in @OLD_IRON's c3–e5");
    expect(l.at).toBe(T + 9);
    expect(l.key).toBe('w2');
  });
});

describe('mergeByTime', () => {
  const line = (key: string, at: number) => ({ ...whisperLine({ ghost: 'w', sea: 'e', cells: ['a1', 'c3'], said: 0, at }, 0, (s) => s, 0), key });
  test('private lines slot in by time; a tie goes after the table line; leftovers go last', () => {
    const items = [{ id: 1, t: 10 }, { id: 2, t: 20 }, { id: 3, t: 30 }];
    const merged = mergeByTime(items, (x) => x.t, [line('b', 25), line('a', 5), line('c', 20), line('d', 99)]);
    expect(merged.map((m) => (m.kind === 'feed' ? m.item.id : m.line.key))).toEqual(['a', 1, 2, 'c', 'b', 3, 'd']);
  });
  test('nothing private leaves the feed as it was; no feed is just the private lines in order', () => {
    const items = [{ t: 1 }, { t: 2 }];
    expect(mergeByTime(items, (x) => x.t, [])).toEqual(items.map((item) => ({ kind: 'feed', item })));
    expect(mergeByTime([], () => 0, [line('y', 2), line('x', 1)]).map((m) => (m.kind === 'private' ? m.line.key : ''))).toEqual(['x', 'y']);
  });
});

describe('parsePrivateCommand', () => {
  test('/w and /msg read a handle and the text', () => {
    expect(parsePrivateCommand('/w @Fable nice shot')).toEqual({ handle: 'Fable', text: 'nice shot' });
    expect(parsePrivateCommand('  /W fable hi ')).toEqual({ handle: 'fable', text: 'hi' });
    expect(parsePrivateCommand('/msg @bob hello there')).toEqual({ handle: 'bob', text: 'hello there' });
    expect(parsePrivateCommand('/w @bob')).toEqual({ handle: 'bob', text: '' });
    expect(parsePrivateCommand('/w')).toEqual({ handle: '', text: '' });
  });
  test('other lines are not commands', () => {
    expect(parsePrivateCommand('/wave hi')).toBeNull();
    expect(parsePrivateCommand('/whisper @bob hi')).toBeNull();
    expect(parsePrivateCommand('hi /w @bob')).toBeNull();
    expect(parsePrivateCommand('/invite @bob')).toBeNull();
  });
});

describe('quietChannels (residents stay off the tab row during a match)', () => {
  const house = person('sprocket', { isHouse: true });
  const dm = (other: IdentityPublic, at: number | null, channel = `dm:${other.id}:zz`): DmSummary => ({
    with: other, channel, last: at === null ? null : msg(1, channel, other, at), unread: 1, hidden: false,
  });
  test("a house DM that spoke since the match began is quiet; a person's isn't; nor one quiet since before", () => {
    const list = [dm(house, T + 1000), dm(fable, T + 1000), dm(person('old', { isHouse: true }), T - 1000), dm(person('new', { isHouse: true }), null)];
    expect([...quietChannels(list, T, null)]).toEqual(['dm:sprocket:zz']);
  });
  test('the one on screen is never quiet (opened on purpose)', () => {
    expect(quietChannels([dm(house, T + 1)], T, 'dm:sprocket:zz').size).toBe(0);
  });
});

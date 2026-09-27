import { describe, expect, test } from 'bun:test';
import type { ChatMessage, IdentityPublic } from '@cs/shared/protocol';
import { applyRemoval, chatItems, hiddenLabel } from './hidden';

const person = (id: string): IdentityPublic => ({
  id,
  handle: id,
  kind: 'human',
  tagline: null,
  color: '#ff8a3d',
  model: null,
  isHouse: false,
  locked: false,
  role: 'user',
  ownerHandle: null,
  released: false,
});
const msg = (id: number, author: string | null, system = false): ChatMessage => ({
  id,
  channel: 'lobby',
  author: author ? person(author) : null,
  text: `line ${id}`,
  createdAt: '2026-09-27T12:00:00Z',
  system,
  removed: null,
});

describe('chatItems', () => {
  test('messages from hidden authors collapse into runs', () => {
    const items = chatItems([msg(1, 'ann'), msg(2, 'troll'), msg(3, 'troll'), msg(4, 'ann'), msg(5, 'troll')], new Set(['troll']), new Set());
    expect(items.map((i) => (i.kind === 'message' ? i.message.id : `hidden:${i.ids.join(',')}`))).toEqual([1, 'hidden:2,3', 4, 'hidden:5']);
  });
  test('revealed messages and system lines always show', () => {
    const items = chatItems([msg(1, 'troll'), msg(2, null, true), msg(3, 'troll')], new Set(['troll']), new Set([3]));
    expect(items.map((i) => (i.kind === 'message' ? i.message.id : 'hidden'))).toEqual(['hidden', 2, 3]);
  });
  test('nothing hidden means every message shows', () => {
    expect(chatItems([msg(1, 'ann')], new Set(), new Set())).toHaveLength(1);
  });
});

describe('hiddenLabel', () => {
  test('counts with the right noun', () => {
    expect(hiddenLabel(1)).toBe('1 hidden message');
    expect(hiddenLabel(3)).toBe('3 hidden messages');
  });
});

describe('applyRemoval', () => {
  test('blanks the text and records who removed it', () => {
    const [a, b] = applyRemoval([msg(1, 'ann'), msg(2, 'bob')], 2, 'mod');
    expect(a.removed).toBeNull();
    expect(b).toMatchObject({ id: 2, text: '', removed: { by: 'mod' } });
  });
  test('a mod or admin viewer keeps the text it already had, dimmed by removed (S145-146)', () => {
    const [, b] = applyRemoval([msg(1, 'ann'), msg(2, 'bob')], 2, 'mod', true);
    expect(b).toMatchObject({ id: 2, text: 'line 2', removed: { by: 'mod' } });
  });
});

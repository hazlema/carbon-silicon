import { expect, test } from 'bun:test';
import { keyOf, swipeOf, typing } from './controls';

const k = (code: string, extra: Partial<{ repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
  keyOf({ code, repeat: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });

test('arrows and WASD steer, Space boosts, anything else is nothing', () => {
  expect([k('ArrowUp'), k('KeyW'), k('ArrowRight'), k('KeyD'), k('ArrowDown'), k('KeyS'), k('ArrowLeft'), k('KeyA'), k('Space')]).toEqual(['n', 'n', 'e', 'e', 's', 's', 'w', 'w', 'boost']);
  expect(k('KeyQ')).toBeNull();
});

test('a held key repeating, or a shortcut with a modifier, is not a press', () => {
  expect(k('ArrowUp', { repeat: true })).toBeNull();
  expect(k('KeyW', { ctrlKey: true })).toBeNull();
  expect(k('KeyA', { metaKey: true })).toBeNull();
  expect(k('KeyS', { altKey: true })).toBeNull();
});

test('a swipe goes its main way; under 24 px it is a tap, and a tap boosts', () => {
  expect(swipeOf(40, 10)).toBe('e');
  expect(swipeOf(-40, 30)).toBe('w');
  expect(swipeOf(5, -60)).toBe('n');
  expect(swipeOf(0, 25)).toBe('s');
  expect(swipeOf(10, 12)).toBe('boost');
});

test('typing in a text box, a textarea or an editable element is not steering', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
  expect(typing(el('INPUT', { type: 'text' }))).toBe(true);
  expect(typing(el('TEXTAREA'))).toBe(true);
  expect(typing(el('DIV', { isContentEditable: true }))).toBe(true);
  expect(typing(el('INPUT', { type: 'checkbox' }))).toBe(false);
  expect(typing(el('BUTTON'))).toBe(false);
  expect(typing(null)).toBe(false);
});

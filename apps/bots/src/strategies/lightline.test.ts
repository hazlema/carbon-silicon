import { expect, test } from 'bun:test';
import { validateDoctrine } from '@cs/game-api';
import { CATALOG } from '@cs/lightline';
import { lightlineDoctrine } from './lightline';

test('every resident doctrine is valid, labelled, and its own', () => {
  for (const style of ['survivor', 'wallHugger'] as const) {
    for (const shrinking of [false, true]) {
      const d = lightlineDoctrine(style, shrinking);
      expect(() => validateDoctrine(d, CATALOG)).not.toThrow();
      expect(d.rules.every((r) => typeof (r as { label?: string }).label === 'string')).toBe(true);
    }
  }
  const labels = (style: 'survivor' | 'wallHugger') => lightlineDoctrine(style, false).rules.map((r) => (r as { label: string }).label);
  // Different from the game's default doctrine (dodge-left, dodge-right, cruise), so a watcher can tell them apart.
  expect(labels('survivor')).toContain('ride');
  expect(labels('wallHugger')).toContain('PROCEED');
  expect(labels('survivor')).not.toContain('cruise');
});

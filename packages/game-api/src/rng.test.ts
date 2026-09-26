import { describe, expect, test } from 'bun:test';
import { createRng, GameRuleError } from './index';

describe('createRng', () => {
  test('same seed gives the same sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });
  test('different seeds differ', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });
  test('next stays in [0,1) and int stays in range', () => {
    const r = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = r.int(6);
      expect(Number.isInteger(n) && n >= 0 && n < 6).toBe(true);
    }
  });
  test('pick returns members and throws on empty', () => {
    const r = createRng(3);
    for (let i = 0; i < 50; i++) expect(['a', 'b', 'c']).toContain(r.pick(['a', 'b', 'c']));
    expect(() => r.pick([])).toThrow();
  });
});

describe('GameRuleError', () => {
  test('carries a code', () => {
    const e = new GameRuleError('BAD_CELL', 'nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('BAD_CELL');
    expect(e.message).toBe('nope');
  });
});

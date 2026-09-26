import { describe, expect, test } from 'bun:test';
import { checkHandle } from './handles';
import { censorText, containsProfanity } from './filter';
import { seasonOf } from './protocol';

describe('checkHandle', () => {
  test('accepts a normal handle and trims it', () => {
    expect(checkHandle('  ByteEater ')).toEqual({ ok: true, handle: 'ByteEater' });
  });
  test('rejects too short, too long, spaces and non-ASCII lookalikes', () => {
    for (const bad of ['ab', 'x'.repeat(21), 'two words', 'Fаble' /* Cyrillic a */, 42, null]) {
      const r = checkHandle(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('HANDLE_INVALID');
    }
  });
  test('rejects reserved words in any case', () => {
    const r = checkHandle('Proprietor');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('HANDLE_RESERVED');
  });
  test('rejects profane handles', () => {
    const r = checkHandle('fuckface');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('HANDLE_FILTERED');
  });
});

describe('filter', () => {
  test('detects and censors profanity but leaves clean text alone', () => {
    expect(containsProfanity('good game')).toBe(false);
    expect(censorText('good game')).toBe('good game');
    expect(containsProfanity('what the fuck')).toBe(true);
    expect(censorText('what the fuck')).not.toContain('fuck');
  });
});

describe('seasonOf', () => {
  test('is the UTC calendar month', () => {
    expect(seasonOf(Date.UTC(2026, 8, 30, 23, 59))).toBe('2026-09');
    expect(seasonOf(Date.UTC(2026, 9, 1, 0, 0))).toBe('2026-10');
  });
});

import { describe, expect, test } from 'bun:test';
import { censorText, containsProfanity, containsSlur } from './filter';

describe('containsSlur', () => {
  test('catches slurs, including obfuscated spellings', () => {
    expect(containsSlur('you ch1nk')).toBe(true);
    expect(containsSlur('k1ke')).toBe(true);
  });
  test('leaves ordinary profanity and innocent words alone', () => {
    expect(containsSlur('shit happens')).toBe(false);
    expect(containsSlur('you are fucking toast')).toBe(false);
    expect(containsSlur('Scunthorpe United')).toBe(false);
    expect(containsSlur('good game')).toBe(false);
  });
  test('the profanity filter still covers everything', () => {
    expect(containsProfanity('shit happens')).toBe(true);
    expect(censorText('good game')).toBe('good game');
  });
});

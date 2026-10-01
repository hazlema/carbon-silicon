import { describe, expect, test } from 'bun:test';
import { rgba } from './render';

describe('rgba', () => {
  test('hex to rgba with alpha', () => {
    expect(rgba('#ff8a3d', 0.5)).toBe('rgba(255, 138, 61, 0.5)');
  });
});

import { describe, expect, test } from 'bun:test';
import { isPocket, POCKET_QUERY } from './pocket';

describe('isPocket', () => {
  test('narrow screens, and touch screens held sideways', () => {
    expect(isPocket(400, 800, true)).toBe(true);
    expect(isPocket(640, 900, false)).toBe(true); // a narrow desktop window too
    expect(isPocket(800, 400, true)).toBe(true); // phone sideways
    expect(isPocket(800, 400, false)).toBe(false); // a short desktop window is not a phone
    expect(isPocket(1024, 768, true)).toBe(false); // tablet
    expect(isPocket(1400, 900, false)).toBe(false);
  });
  test('the media query says the same thing', () => {
    expect(POCKET_QUERY).toBe('(max-width: 640px), (pointer: coarse) and (max-height: 500px)');
  });
});

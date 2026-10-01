import { describe, expect, test } from 'bun:test';
import { popFrequency } from './sound';

describe('popFrequency', () => {
  test('each wave pops a semitone higher, levelling off after an octave', () => {
    expect(popFrequency(0)).toBeCloseTo(440, 5);
    expect(popFrequency(1)).toBeCloseTo(440 * 2 ** (1 / 12), 5);
    expect(popFrequency(12)).toBeCloseTo(880, 5);
    expect(popFrequency(40)).toBeCloseTo(880, 5);
  });
});

import { describe, expect, test } from 'bun:test';
import { INTRO_TONES, tonesFrom } from './intro-audio';
import { INTRO_SECONDS, introFrame } from './intro-timeline';

describe('the intro score', () => {
  test('is in time order and finishes inside the intro', () => {
    const times = INTRO_TONES.map((t) => t.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const t of INTRO_TONES) {
      expect(t.at).toBeGreaterThanOrEqual(0);
      expect(t.at + t.d).toBeLessThan(INTRO_SECONDS);
      expect(t.v).toBeGreaterThan(0);
      expect(t.v).toBeLessThanOrEqual(0.25);
    }
  });
  test('ticks with triangle waves while the table assembles', () => {
    const ticks = INTRO_TONES.filter((t) => t.at < 0.9);
    expect(ticks).toHaveLength(4);
    expect(ticks.every((t) => t.wave === 'triangle')).toBe(true);
  });
  test('beeps a square wave on exactly the frame each letter of "Silicon" appears', () => {
    const beeps = INTRO_TONES.filter((t) => t.f === 1500 && t.wave === 'square');
    expect(beeps).toHaveLength(7);
    beeps.forEach((b, i) => {
      expect(introFrame(b.at).letters).toBe(i + 1);
      expect(introFrame(b.at - 0.001).letters).toBe(i);
    });
  });
  test('tonesFrom drops what has already played (for unmuting mid-intro)', () => {
    expect(tonesFrom(0)).toEqual(INTRO_TONES);
    expect(tonesFrom(5.9).every((t) => t.at >= 5.9)).toBe(true);
    expect(tonesFrom(5.9).length).toBe(11);
    expect(tonesFrom(INTRO_SECONDS)).toEqual([]);
  });
});

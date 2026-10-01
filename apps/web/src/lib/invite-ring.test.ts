import { describe, expect, test } from 'bun:test';
import { arcPath, pointOnRing, ringColor, ringTone } from './invite-ring';

// The ring is a clockwise sweep that fills from 12 o'clock. Geometry is measured
// as a clockwise fraction (0..1) of a full turn, starting at the top.
describe('pointOnRing', () => {
  test('walks clockwise from the top: top, right, bottom, left', () => {
    expect(pointOnRing(50, 50, 40, 0)).toEqual({ x: 50, y: 10 }); // 12 o'clock
    expect(pointOnRing(50, 50, 40, 0.25)).toEqual({ x: 90, y: 50 }); // 3 o'clock
    expect(pointOnRing(50, 50, 40, 0.5)).toEqual({ x: 50, y: 90 }); // 6 o'clock
    expect(pointOnRing(50, 50, 40, 0.75)).toEqual({ x: 10, y: 50 }); // 9 o'clock
  });
});

describe('arcPath', () => {
  test('is empty before any time has elapsed', () => {
    expect(arcPath(0, 50, 50, 40)).toBe('');
    expect(arcPath(-0.2, 50, 50, 40)).toBe('');
  });

  test('a quarter sweep is a small arc from top to 3 o\'clock', () => {
    expect(arcPath(0.25, 50, 50, 40)).toBe('M 50 10 A 40 40 0 0 1 90 50');
  });

  test('a half sweep stays a small arc (largeArc flag off at exactly 0.5)', () => {
    expect(arcPath(0.5, 50, 50, 40)).toBe('M 50 10 A 40 40 0 0 1 50 90');
  });

  test('past half, the largeArc flag turns on', () => {
    expect(arcPath(0.75, 50, 50, 40)).toBe('M 50 10 A 40 40 0 1 1 10 50');
  });

  test('a full sweep draws a closed circle with two arcs', () => {
    const d = arcPath(1, 50, 50, 40);
    expect(d.startsWith('M 50 10')).toBe(true);
    expect((d.match(/A /g) ?? []).length).toBe(2); // one A can't draw 360°
    expect(arcPath(1.4, 50, 50, 40)).toBe(d); // clamps above 1
  });
});

describe('ringTone / ringColor by time remaining', () => {
  test('green with lots of time, amber mid, red near the end', () => {
    expect(ringTone(1)).toBe('ready');
    expect(ringTone(0.6)).toBe('ready');
    expect(ringTone(0.5)).toBe('warn'); // boundary: not "plenty" anymore
    expect(ringTone(0.3)).toBe('warn');
    expect(ringTone(0.1)).toBe('urgent');
    expect(ringTone(0)).toBe('urgent');
  });

  test('maps tones to the app colour tokens', () => {
    expect(ringColor(0.9)).toBe('var(--ready)');
    expect(ringColor(0.4)).toBe('var(--afk)');
    expect(ringColor(0.05)).toBe('var(--danger)');
  });
});

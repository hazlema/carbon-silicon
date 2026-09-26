import { describe, expect, test } from 'bun:test';
import { burstDuration, cellOrigin, layout, orbOffsets, waveSchedule } from './render';

describe('layout', () => {
  test('square cells that fit the box', () => {
    expect(layout(6, 9, 600, 900)).toEqual({ cols: 6, rows: 9, cell: 100, width: 600, height: 900 });
    expect(layout(6, 9, 600, 450).cell).toBe(50);
  });
  test('row 1 is drawn at the bottom, column a on the left', () => {
    const l = layout(6, 9, 600, 900);
    expect(cellOrigin(l, 0)).toEqual({ x: 0, y: 800 }); // a1
    expect(cellOrigin(l, 5)).toEqual({ x: 500, y: 800 }); // f1
    expect(cellOrigin(l, 53)).toEqual({ x: 500, y: 0 }); // f9
  });
});

describe('orbOffsets', () => {
  test('one orb sits in the centre; more orbs spread evenly', () => {
    expect(orbOffsets(0, 10)).toEqual([]);
    expect(orbOffsets(1, 10)).toEqual([{ x: 0, y: 0 }]);
    const three = orbOffsets(3, 10);
    expect(three).toHaveLength(3);
    for (const o of three) expect(Math.hypot(o.x, o.y)).toBeCloseTo(10, 5);
    expect(orbOffsets(9, 10)).toHaveLength(6);
  });
});

describe('waveSchedule', () => {
  test('each wave starts after the previous one', () => {
    expect(waveSchedule([[0], [1, 6]], 150)).toEqual([
      { index: 0, start: 0 },
      { index: 1, start: 150 },
      { index: 6, start: 150 },
    ]);
    expect(burstDuration(2, 150, 420)).toBe(570);
    expect(burstDuration(0, 150, 420)).toBe(0);
  });
});

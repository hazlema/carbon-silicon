import { describe, expect, test } from 'bun:test';
import { cellIndex } from '@cs/critical-mass';
import {
  boardSize, captured, cellCenter, cellOrder, changedCells, clampTilt, CELL, EMPTY, fitScale, flightPlan,
  GAP, MAX_BURSTS, MAX_FLIGHTS, MAX_POPS, mix, nearestTurn, popTimes, orbSpots, PAD, shades, topFor, WAVE_MS,
} from './iso';

describe('nearestTurn', () => {
  test('a view snap lands on the same heading by the short way round', () => {
    // Three quarter-turns left from Top, then Iso: 125° back, not 235° forward.
    expect(nearestTurn(-270, -35)).toBe(-395);
    expect(nearestTurn(325, -35)).toBe(325);
    expect(nearestTurn(0, -35)).toBe(-35);
    expect(nearestTurn(700, 0)).toBe(720);
  });
  test('never travels more than half a turn, and keeps the heading', () => {
    for (let from = -1000; from <= 1000; from += 37) {
      for (const to of [-35, 0, 90]) {
        const got = nearestTurn(from, to);
        expect(Math.abs(got - from)).toBeLessThanOrEqual(180);
        expect((((got - to) % 360) + 360) % 360).toBe(0);
      }
    }
  });
});

describe('geometry', () => {
  test('the slab is cells + gaps + padding', () => {
    expect(boardSize(6, 9)).toEqual({ w: 6 * CELL + 5 * GAP + 2 * PAD, h: 9 * CELL + 8 * GAP + 2 * PAD });
  });
  test('tilt stays between flat and 70°', () => {
    expect(clampTilt(-10)).toBe(0);
    expect(clampTilt(40)).toBe(40);
    expect(clampTilt(95)).toBe(70);
  });
  test('top row first, so a9 leads on 6×9', () => {
    const order = cellOrder(6, 9);
    expect(order).toHaveLength(54);
    expect(order[0]).toBe(cellIndex(6, 9, 'a9')!);
    expect(order[53]).toBe(cellIndex(6, 9, 'f1')!);
  });
  test('cell centres sit on the face, a1 bottom-left', () => {
    expect(cellCenter(cellIndex(6, 9, 'a9')!, 6, 9)).toEqual({ x: PAD + CELL / 2, y: PAD + CELL / 2 });
    expect(cellCenter(cellIndex(6, 9, 'a1')!, 6, 9)).toEqual({ x: PAD + CELL / 2, y: PAD + 8 * (CELL + GAP) + CELL / 2 });
  });
  test('orb spots follow the comp, capped at three', () => {
    expect(orbSpots(0)).toEqual([]);
    expect(orbSpots(1)).toEqual([[33, 33]]);
    expect(orbSpots(2)).toEqual([[23, 33], [43, 33]]);
    expect(orbSpots(3)).toEqual([[23, 40], [43, 40], [33, 22]]);
    expect(orbSpots(5)).toHaveLength(3);
  });
});

describe('fitScale', () => {
  const board = boardSize(6, 9);
  test('top view is bound by height once the pill is reserved', () => {
    expect(fitScale(board, { w: 1000, h: 800 }, 0, 0)).toBeCloseTo((0.9 * (800 - 64)) / board.h, 5);
  });
  test('a narrow stage is bound by width', () => {
    expect(fitScale(board, { w: 300, h: 2000 }, 0, 0)).toBeCloseTo((0.9 * 300) / board.w, 5);
  });
  test('the projected footprint never exceeds the stage at any angle', () => {
    const stage = { w: 700, h: 600 };
    for (const spin of [-35, 0, 45, 90, 135, 270]) {
      for (const tilt of [0, 30, 55, 70]) {
        const s = fitScale(board, stage, spin, tilt);
        const r = (spin * Math.PI) / 180, t = (tilt * Math.PI) / 180;
        const pw = (Math.abs(board.w * Math.cos(r)) + Math.abs(board.h * Math.sin(r))) * s;
        const depth = Math.abs(board.w * Math.sin(r)) + Math.abs(board.h * Math.cos(r));
        expect(pw).toBeLessThanOrEqual(stage.w);
        expect((depth * Math.cos(t) + 26 * Math.sin(t)) * s).toBeLessThanOrEqual(stage.h - 64);
      }
    }
  });
  test('perspective magnifies the near edge; the fit leaves room for it', () => {
    const stage = { w: 900, h: 700 };
    for (const spin of [-35, 45, 90]) {
      for (const tilt of [30, 55, 70]) {
        const s = fitScale(board, stage, spin, tilt);
        const r = (spin * Math.PI) / 180, t = (tilt * Math.PI) / 180;
        const pw = Math.abs(board.w * Math.cos(r)) + Math.abs(board.h * Math.sin(r));
        const depth = Math.abs(board.w * Math.sin(r)) + Math.abs(board.h * Math.cos(r));
        const near = 1900 / (1900 - ((depth * s) / 2) * Math.sin(t));
        expect(pw * s * near).toBeLessThanOrEqual(stage.w);
        expect((depth * Math.cos(t) + 26 * Math.sin(t)) * s * near).toBeLessThanOrEqual(stage.h - 64);
      }
    }
  });
  test('an unmeasured stage never yields zero or negative scale', () => {
    expect(fitScale(board, { w: 0, h: 0 }, -35, 55)).toBeGreaterThan(0);
  });
});

describe('shades', () => {
  test('mix blends channel by channel', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#ff8a3d', '#ff8a3d', 0.3)).toBe('#ff8a3d');
  });
  test('every palette colour yields usable shades', () => {
    for (const hex of ['#ff8a3d', '#4fe3ff', '#6dffa8', '#c792ff', '#9aa1cf']) {
      const s = shades(hex);
      expect(s.rim).toMatch(/^rgba\(\d+, \d+, \d+, 0\.3\)$/);
      expect(s.floor).toMatch(/0\.1\)$/);
      expect(s.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.dark).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(EMPTY.floor).toBe('rgba(8,6,4,.38)');
  });
});

describe('move diffs', () => {
  const cell = (owner: string | null, orbs: number) => ({ owner, orbs });
  test('changed cells are those whose owner or count moved', () => {
    expect(changedCells([cell(null, 0), cell('red', 1), cell('blue', 2)], [cell('red', 1), cell('red', 1), cell('red', 3)])).toEqual([0, 2]);
  });
  test('a capture is an opponent cell that became the mover’s', () => {
    expect(captured([cell('blue', 2)], [cell('red', 3)], 'red')).toBe(true);
    expect(captured([cell(null, 0)], [cell('red', 1)], 'red')).toBe(false);
    expect(captured([cell('red', 1)], [cell('red', 2)], 'red')).toBe(false);
  });
});

describe('flightPlan', () => {
  const i = (n: string) => cellIndex(6, 9, n)!;
  test('each exploding cell sends one orb to each neighbour, wave by wave', () => {
    const plan = flightPlan([[i('a1')], [i('a2'), i('b1')]], 6, 9);
    expect(plan.bursts).toEqual([{ index: i('a1'), delay: 0 }, { index: i('a2'), delay: WAVE_MS }, { index: i('b1'), delay: WAVE_MS }]);
    expect(plan.flights.filter((f) => f.from === i('a1')).map((f) => f.to).sort()).toEqual([i('a2'), i('b1')].sort());
    // a flight takes one wave's spacing: a1's orb lands on a2 just as a2 bursts in the next wave
    expect(plan.flightMs).toBe(WAVE_MS);
    expect(plan.hits.get(i('a2'))).toBe(WAVE_MS);
    expect(plan.hits.get(i('c1'))).toBe(2 * WAVE_MS);
    expect(plan.total).toBe(2 * WAVE_MS);
  });
  test('no waves, no plan', () => {
    expect(flightPlan([], 6, 9)).toEqual({ flights: [], hits: new Map(), bursts: [], total: 0, flightMs: WAVE_MS });
  });
  test('a runaway chain is capped and compressed', () => {
    const waves = Array.from({ length: 80 }, () => [i('c4'), i('d5'), i('c5')]);
    const plan = flightPlan(waves, 6, 9);
    expect(plan.flights.length).toBeLessThanOrEqual(MAX_FLIGHTS);
    expect(plan.bursts.length).toBeLessThanOrEqual(MAX_BURSTS);
    expect(plan.total).toBeLessThanOrEqual(3000);
  });
});

describe('popTimes', () => {
  test('one pop per wave at the plan’s spacing', () => {
    expect(popTimes(3, 200)).toEqual([0, 200, 400]);
    expect(popTimes(0, 200)).toEqual([]);
  });
  test('a long chain pops a capped number of times, spread across its whole run', () => {
    const t = popTimes(500, 6);
    expect(t.length).toBe(MAX_POPS);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBeCloseTo(499 * 6, 5);
  });
});

describe('topFor', () => {
  const tall = { w: 6, h: 9 };
  test('a tall board on a portrait stage stays upright', () => {
    expect(topFor(tall, { w: 400, h: 700 })).toEqual({ spin: 0, tilt: 0 });
  });
  test('a tall board on a landscape stage is turned so the long sides agree', () => {
    expect(topFor(tall, { w: 700, h: 400 })).toEqual({ spin: 90, tilt: 0 });
  });
  test('a wide board on a portrait stage is turned', () => {
    expect(topFor({ w: 9, h: 6 }, { w: 400, h: 700 })).toEqual({ spin: 90, tilt: 0 });
    expect(topFor({ w: 9, h: 6 }, { w: 700, h: 400 })).toEqual({ spin: 0, tilt: 0 });
  });
  test('a square board or a square stage is never turned', () => {
    expect(topFor({ w: 7, h: 7 }, { w: 700, h: 400 })).toEqual({ spin: 0, tilt: 0 });
    expect(topFor(tall, { w: 500, h: 500 })).toEqual({ spin: 0, tilt: 0 });
  });
});

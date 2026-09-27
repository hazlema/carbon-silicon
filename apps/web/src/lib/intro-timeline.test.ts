import { describe, expect, test } from 'bun:test';
import {
  CELLS,
  HOME,
  INTRO_SECONDS,
  PITCH,
  SILICON,
  STAGE_H,
  STAGE_W,
  TABLE_IN_END,
  TYPE_START,
  TYPE_STEP,
  ease,
  introFrame,
  place,
  stageScale,
  tileIn,
  tween,
} from './intro-timeline';

describe('easing', () => {
  test('every curve runs from 0 to 1', () => {
    for (const e of Object.values(ease)) {
      expect(e(0)).toBeCloseTo(0, 9);
      expect(e(1)).toBeCloseTo(1, 9);
    }
  });
  test('outBack overshoots past 1 before settling; inOutCubic is symmetric', () => {
    expect(ease.outBack(0.7)).toBeGreaterThan(1);
    expect(ease.inOutCubic(0.25) + ease.inOutCubic(0.75)).toBeCloseTo(1, 9);
  });
  test('tween clamps outside its window', () => {
    expect(tween(-1, 1, 2)).toBe(0);
    expect(tween(1, 1, 2)).toBe(0);
    expect(tween(5, 1, 2)).toBe(1);
    expect(tween(1.5, 1, 2, ease.linear)).toBe(0.5);
  });
});

describe('the periodic table', () => {
  test('has every element but the two characters, and each cell is unique', () => {
    expect(CELLS).toHaveLength(116);
    expect(CELLS.map((c) => c.sym)).not.toContain('C');
    expect(CELLS.map((c) => c.sym)).not.toContain('Si');
    expect(new Set(CELLS.map((c) => `${c.x},${c.y}`)).size).toBe(116);
  });
  test('lays out by period and group', () => {
    expect(place(1)).toEqual([0, 0]); // H: period 1, group 1
    expect(place(2)).toEqual([0, 17]); // He: group 18
    expect(place(6)).toEqual([1, 13]); // C: period 2, group 14
    expect(place(14)).toEqual([2, 13]); // Si: directly below carbon
    expect(place(57)).toEqual([7.35, 2]); // La heads the lanthanide row
    expect(place(72)).toEqual([5, 3]); // Hf resumes period 6
    expect(place(118)).toEqual([6, 17]); // Og
  });
  test('carbon and silicon are home in group 14; B, N, Al and P are the four kept neighbours', () => {
    expect(HOME.C).toEqual([13 * PITCH + 29, PITCH + 29]);
    expect(HOME.Si).toEqual([13 * PITCH + 29, 2 * PITCH + 29]);
    expect(CELLS.filter((c) => c.keep).map((c) => c.sym)).toEqual(['B', 'N', 'Al', 'P']);
  });
  test('ripples in from the top-left and is fully in by TABLE_IN_END', () => {
    const h = CELLS.find((c) => c.sym === 'H')!;
    const og = CELLS.find((c) => c.sym === 'Og')!;
    expect(h.at).toBeLessThan(og.at);
    expect(tileIn(h, 0)).toBe(0);
    for (const c of CELLS) expect(tileIn(c, TABLE_IN_END)).toBe(1);
    expect(TABLE_IN_END).toBeLessThan(1.5);
  });
});

describe('introFrame', () => {
  test('starts dark: nothing lit, no bubbles, no wordmark', () => {
    const f = introFrame(0);
    expect(f.cAppear).toBe(0);
    expect(f.lit).toBe(0);
    expect(f.cBubble + f.typing + f.siBubble).toBe(0);
    expect(f.wordmark).toBe(0);
    expect(f.letters).toBe(0);
  });
  test('C and Si light up around 1.0-1.35s, before they lift', () => {
    const f = introFrame(1.5);
    expect(f.lit).toBe(1);
    expect(f.ghost).toBe(0);
  });
  test('mid-chat they stand big and tilted at their marks, C left of centre and Si right', () => {
    const f = introFrame(3);
    expect(f.c.x).toBeCloseTo(480, 6);
    expect(f.si.x).toBeCloseTo(800, 6);
    expect(f.c.size).toBeCloseTo(150, 6);
    expect(f.c.rot).toBeCloseTo(5, 6);
    expect(f.si.rot).toBeCloseTo(-5, 6);
    expect(f.cBubble).toBeGreaterThan(0.9);
    expect(f.othersOpacity).toBeCloseTo(0.35, 6);
  });
  test('Silicon thinks, then answers', () => {
    expect(introFrame(3.6).typing).toBe(1);
    expect(introFrame(3.6).siBubble).toBe(0);
    expect(introFrame(4.4).typing).toBe(0);
    expect(introFrame(4.4).siBubble).toBe(1);
  });
  test('at the end they are home, the rest of the table is gone and the name is typed out', () => {
    const f = introFrame(INTRO_SECONDS);
    expect(f.othersOpacity).toBe(0);
    expect(f.keepOpacity).toBe(1);
    expect(f.c.rot).toBe(0);
    // Carbon's home is the camera's focus, so it sits at the stage centre (x) and 360 - 64 * zoom.
    expect(f.c.x).toBeCloseTo(STAGE_W / 2, 6);
    expect(f.si.y - f.c.y).toBeCloseTo(PITCH * f.zoom, 6);
    expect(f.wordmark).toBe(1);
    expect(f.letters).toBe(SILICON.length);
  });
  test('"Silicon" types one letter per beep step', () => {
    expect(introFrame(TYPE_START - 0.001).letters).toBe(0);
    expect(introFrame(TYPE_START).letters).toBe(1);
    expect(introFrame(TYPE_START + TYPE_STEP * 3 + 0.001).letters).toBe(4);
    expect(introFrame(TYPE_START + TYPE_STEP * 6).letters).toBe(7);
  });
});

describe('stageScale', () => {
  test('a desktop window fits the whole stage', () => {
    expect(stageScale(1440, 900)).toBeCloseTo(1440 / STAGE_W, 9);
    expect(stageScale(1280, 600)).toBeCloseTo(600 / STAGE_H, 9);
  });
  test('a phone keeps the scene legible, cropping the table sides but not carbon at home', () => {
    const k = stageScale(400, 860);
    expect(k).toBeCloseTo(0.6, 9);
    // Where carbon's home tile's right edge lands at 1.2s, in window pixels.
    const f = introFrame(1.2);
    const right = 200 + (f.c.x + f.c.size / 2 - STAGE_W / 2) * k;
    expect(right).toBeLessThan(400);
  });
});

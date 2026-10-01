import { neighbors } from '@cs/critical-mass';
import { rgba } from './render';

/** Board geometry in board-face pixels (the whole slab is then scaled to fit the stage). */
export const CELL = 66;
export const GAP = 6;
export const PAD = 14;
export const SLAB = 26;
/** Room kept free at the stage's foot for the view pill. */
export const PILL_RESERVE = 64;

export const ISO = { spin: -35, tilt: 55 };
export const TOP = { spin: 0, tilt: 0 };

/** Waves burst this far apart; each flight takes exactly one wave, landing as the next wave bursts. */
export const WAVE_MS = 200;
export const MAX_FLIGHTS = 240;
export const MAX_BURSTS = 120;
export const MAX_POPS = 16;
const MAX_TOTAL_MS = 3000;

export const clampTilt = (t: number) => Math.min(70, Math.max(0, t));

export function boardSize(cols: number, rows: number) {
  return { w: cols * CELL + (cols - 1) * GAP + 2 * PAD, h: rows * CELL + (rows - 1) * GAP + 2 * PAD };
}

/** The stage's CSS perspective, in px. */
export const PERSPECTIVE = 1900;

/**
 * Largest scale at which the rotated, tilted slab fits the stage above the pill, with a 10% margin.
 * The near edge of a tilted board rises toward the viewer and perspective magnifies it, so the
 * orthographic fit is shrunk until the magnified footprint fits too.
 */
export function fitScale(board: { w: number; h: number }, stage: { w: number; h: number }, spinDeg: number, tiltDeg: number, reserve = PILL_RESERVE) {
  const r = (spinDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  const pw = Math.abs(board.w * Math.cos(r)) + Math.abs(board.h * Math.sin(r));
  const depth = Math.abs(board.w * Math.sin(r)) + Math.abs(board.h * Math.cos(r));
  const ph = depth * Math.cos(t) + SLAB * Math.sin(t);
  const ortho = Math.min((0.9 * stage.w) / pw, (0.9 * (stage.h - reserve)) / ph);
  if (!Number.isFinite(ortho) || ortho <= 0) return 0.1;
  // near = P / (P - rise·s); solving s·near = ortho for s gives s = ortho·P / (P + rise·ortho).
  const rise = (depth / 2) * Math.sin(t);
  return (ortho * PERSPECTIVE) / (PERSPECTIVE + rise * ortho);
}

/** Cell indices in DOM order: the top row (highest rank) first, column a on the left. */
export function cellOrder(cols: number, rows: number): number[] {
  return Array.from({ length: rows }, (_, k) => rows - 1 - k).flatMap((r) => Array.from({ length: cols }, (_, c) => r * cols + c));
}

export function cellCenter(index: number, cols: number, rows: number) {
  const c = index % cols;
  const fromTop = rows - 1 - Math.floor(index / cols);
  return { x: PAD + c * (CELL + GAP) + CELL / 2, y: PAD + fromTop * (CELL + GAP) + CELL / 2 };
}

const SPOTS: Record<number, [number, number][]> = { 1: [[33, 33]], 2: [[23, 33], [43, 33]], 3: [[23, 40], [43, 40], [33, 22]] };
export const orbSpots = (n: number): [number, number][] => (n <= 0 ? [] : SPOTS[Math.min(n, 3)]);

export interface Shades {
  rim: string;
  rimHi: string;
  floor: string;
  light: string;
  dark: string;
  glow: string;
}
/** The comp's empty-cell glass. */
export const EMPTY: Shades = {
  rim: 'rgba(210,225,255,.13)',
  rimHi: 'rgba(230,240,255,.45)',
  floor: 'rgba(8,6,4,.38)',
  light: '#ffffff',
  dark: '#000000',
  glow: 'transparent',
};

export function mix(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/** The comp's owner tints and orb shading, derived from any seat colour. */
export function shades(hex: string): Shades {
  return {
    rim: rgba(hex, 0.3),
    rimHi: rgba(mix(hex, '#ffffff', 0.55), 0.85),
    floor: rgba(hex, 0.1),
    light: mix(hex, '#ffffff', 0.72),
    dark: mix(hex, '#000000', 0.42),
    glow: rgba(hex, 0.55),
  };
}

type Cell = { owner: string | null; orbs: number };
export const changedCells = (prev: Cell[], next: Cell[]) =>
  next.flatMap((c, i) => (c.owner !== prev[i]?.owner || c.orbs !== prev[i]?.orbs ? [i] : []));
export const captured = (prev: Cell[], next: Cell[], mover: string) =>
  next.some((c, i) => c.owner === mover && !!prev[i]?.owner && prev[i].owner !== mover);

export interface Flight {
  from: number;
  to: number;
  delay: number;
}

/**
 * The chain reaction as decoration: a burst at each exploding cell, one orb flying to each neighbour,
 * and the time each cell's final state should land. Long chains squeeze their spacing and drop flights.
 */
export function flightPlan(waves: number[][], cols: number, rows: number) {
  const flights: Flight[] = [];
  const hits = new Map<number, number>();
  const bursts: { index: number; delay: number }[] = [];
  if (waves.length === 0) return { flights, hits, bursts, total: 0, flightMs: WAVE_MS };
  const waveMs = Math.min(WAVE_MS, MAX_TOTAL_MS / (waves.length + 1));
  waves.forEach((wave, k) => {
    const delay = k * waveMs;
    for (const from of wave) {
      if (bursts.length < MAX_BURSTS) bursts.push({ index: from, delay });
      hits.set(from, Math.max(hits.get(from) ?? 0, delay));
      for (const to of neighbors(cols, rows, from)) {
        if (flights.length < MAX_FLIGHTS) flights.push({ from, to, delay });
        hits.set(to, Math.max(hits.get(to) ?? 0, delay + waveMs));
      }
    }
  });
  const total = Math.max(...hits.values());
  return { flights, hits, bursts, total, flightMs: waveMs };
}

/** When each wave's pop sounds: one per wave, or MAX_POPS spread evenly over a longer chain. */
export function popTimes(waveCount: number, waveMs: number): number[] {
  if (waveCount <= 0) return [];
  if (waveCount <= MAX_POPS) return Array.from({ length: waveCount }, (_, k) => k * waveMs);
  const span = (waveCount - 1) * waveMs;
  return Array.from({ length: MAX_POPS }, (_, k) => (k * span) / (MAX_POPS - 1));
}

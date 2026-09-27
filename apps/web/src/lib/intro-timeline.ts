/**
 * The logo intro's timeline, ported from the Foreman's Claude Design mock
 * (docs/ideas/Carbon and Silicon Logo Animation.html). Everything on screen is a pure function of
 * the time T in seconds, laid out on a 1280x720 stage that LogoIntro.svelte scales to the window.
 */

export const INTRO_SECONDS = 7;
export const STAGE_W = 1280;
export const STAGE_H = 720;
/** A table tile's side, and the distance between neighbouring tiles. */
export const CELL = 58;
export const PITCH = 62;
/** "Silicon" types out one letter per teletype beep, from TYPE_START every TYPE_STEP seconds. */
export const TYPE_START = 6.0;
export const TYPE_STEP = 0.085;
export const SILICON = 'Silicon';

type Ease = (t: number) => number;
export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - 4 * (1 - t) ** 3),
  /** Overshoots past 1 before settling: the "pop". */
  outBack: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
} satisfies Record<string, Ease>;

/** 0 before `start`, 1 after `end`, eased in between. */
export function tween(T: number, start: number, end: number, e: Ease = ease.inOutCubic): number {
  if (T <= start) return 0;
  if (T >= end) return 1;
  return e((T - start) / (end - start));
}

const SYMBOLS =
  'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(
    ' ',
  );

/** [row, column] of element z: period - 1 and group - 1, with the f-block in two rows set below. */
export function place(z: number): [number, number] {
  if (z === 1) return [0, 0];
  if (z === 2) return [0, 17];
  if (z <= 4) return [1, z - 3];
  if (z <= 10) return [1, z + 7];
  if (z <= 12) return [2, z - 11];
  if (z <= 18) return [2, z - 1];
  if (z <= 36) return [3, z - 19];
  if (z <= 54) return [4, z - 37];
  if (z <= 56) return [5, z - 55];
  if (z <= 71) return [7.35, z - 55]; // lanthanides
  if (z <= 86) return [5, z - 69];
  if (z <= 88) return [6, z - 87];
  if (z <= 103) return [8.35, z - 87]; // actinides
  return [6, z - 101];
}

export interface Cell {
  z: number;
  sym: string;
  /** Top-left corner on the table, in stage pixels at zoom 1. */
  x: number;
  y: number;
  /** When its fade-in starts: a diagonal ripple from the top-left. */
  at: number;
  /** B, N, Al and P: the neighbours that stay for the closing corner (Lattice.svelte's six tiles). */
  keep: boolean;
}

const KEEP = new Set([5, 7, 13, 15]);
/** Every element but carbon and silicon, which are drawn separately as the two characters. */
export const CELLS: Cell[] = SYMBOLS.map((sym, i) => {
  const z = i + 1;
  const [r, c] = place(z);
  return { z, sym, x: c * PITCH, y: r * PITCH, at: 0.1 + (r + c) * 0.03, keep: KEEP.has(z) };
}).filter((cell) => cell.z !== 6 && cell.z !== 14);
const TILE_FADE = 0.4;
/** After this the table's fade-in is over, so its tiles stop changing. */
export const TABLE_IN_END = Math.max(...CELLS.map((c) => c.at)) + TILE_FADE;

/** 0..1: how far a tile has faded in. */
export const tileIn = (cell: Cell, T: number) => tween(T, cell.at, cell.at + TILE_FADE, ease.outCubic);

/** Centre of carbon's and silicon's home cells on the table (group 14, periods 2 and 3). */
export const HOME = {
  C: [13 * PITCH + CELL / 2, 1 * PITCH + CELL / 2],
  Si: [13 * PITCH + CELL / 2, 2 * PITCH + CELL / 2],
} as const;
/** Where the two characters stand while they chat, in stage pixels. */
const CHAT = { C: [480, 440], Si: [800, 440] } as const;

export interface Card {
  /** Centre, in stage pixels. */
  x: number;
  y: number;
  size: number;
  rot: number;
}

export interface Frame {
  /** The camera over the table: zoom and the table point it centres on. */
  zoom: number;
  focusX: number;
  focusY: number;
  /** Opacity of the table's other tiles, and of the four that stay for the corner. */
  othersOpacity: number;
  keepOpacity: number;
  /** Opacity of the dashed outlines left in the table while C and Si are out. */
  ghost: number;
  c: Card;
  si: Card;
  cAppear: number;
  siAppear: number;
  /** 0..1: how lit C and Si are (dim tile to full colour). */
  lit: number;
  /** 0..1 while the landing ring expands; 0 before, 1 after. */
  land: number;
  /** Horizontal squash of both cards (vertical is 2 - squash). */
  squash: number;
  /** Bubble scales: carbon's line, silicon's "typing" dots, silicon's answer. */
  cBubble: number;
  typing: number;
  siBubble: number;
  /** The closing wordmark: "Carbon &" and "Silicon", 0..1. */
  wordmark: number;
  silicon: number;
  /** How many letters of "Silicon" have typed out. */
  letters: number;
}

export function introFrame(T: number): Frame {
  const A = (start: number, end: number, e: Ease) => tween(T, start, end, e);

  // Camera: a slow push in, then the snap onto the carbon/silicon corner.
  const snap = A(4.9, 5.9, ease.inOutCubic);
  const zoom = 1 + 0.1 * A(0, 4.9, ease.linear) + 0.9 * snap + 0.06 * A(5.9, 6.6, ease.linear);
  const focusX = 556 + (HOME.C[0] - 556) * snap;
  const focusY = 292 + (100 - 292) * snap;
  const toStage = (wx: number, wy: number) => [(wx - focusX) * zoom + STAGE_W / 2, (wy - focusY) * zoom + STAGE_H / 2];

  const dim = 0.65 * A(1.6, 2.4, ease.inOutCubic) - 0.65 * A(4.9, 5.5, ease.inOutCubic);
  const fadeOthers = A(4.9, 5.5, ease.outCubic);

  const lift = A(1.62, 2.55, ease.inOutCubic);
  const ret = A(5.0, 5.7, ease.outBack);
  const free = lift * (1 - ret);
  const squash =
    1 -
    0.1 * A(1.45, 1.62, ease.outCubic) +
    0.1 * A(1.62, 1.85, ease.outBack) -
    0.08 * A(5.62, 5.72, ease.outCubic) +
    0.08 * A(5.72, 5.95, ease.outBack);

  const card = (key: 'C' | 'Si', dir: 1 | -1): Card => {
    const [hx, hy] = toStage(HOME[key][0], HOME[key][1]);
    const [cx, cy] = CHAT[key];
    const bob = Math.sin((T - 2.5) * 4 + (dir > 0 ? 0 : 1.6)) * 5 * free;
    const hop = Math.sin(lift * Math.PI) * 40 * (1 - ret);
    return {
      x: hx + (cx - hx) * free,
      y: hy + (cy - hy) * free + bob - hop,
      size: CELL * zoom + (150 - CELL * zoom) * free,
      rot: dir * 5 * free,
    };
  };

  let letters = 0;
  while (letters < SILICON.length && T >= TYPE_START + letters * TYPE_STEP) letters++;

  return {
    zoom,
    focusX,
    focusY,
    othersOpacity: (1 - dim) * (1 - fadeOthers),
    keepOpacity: 1 - dim,
    ghost: Math.max(0, free * 0.5),
    c: card('C', 1),
    si: card('Si', -1),
    cAppear: A(0.5, 0.9, ease.outCubic),
    siAppear: A(0.53, 0.93, ease.outCubic),
    lit: A(0.9, 1.35, ease.outCubic),
    land: A(5.68, 6.3, ease.outCubic),
    squash,
    cBubble: A(2.75, 3.1, ease.outBack) - A(4.7, 4.9, ease.outCubic),
    typing: A(3.3, 3.45, ease.outBack) - A(3.8, 3.9, ease.outCubic),
    siBubble: A(3.85, 4.2, ease.outBack) - A(4.75, 4.95, ease.outCubic),
    wordmark: A(5.85, 6.45, ease.outCubic),
    silicon: A(6.0, 6.6, ease.outCubic),
    letters,
  };
}

/**
 * How much to scale the 1280x720 stage for a window. Landscape windows fit the whole stage; on a
 * narrow portrait phone that would shrink the scene to a sliver, so the stage keeps a floor of
 * 0.6 (or whatever keeps its middle 660px in view) and lets the outer table columns crop off the
 * sides. The characters, bubbles and wordmark all live in that middle.
 */
export function stageScale(width: number, height: number): number {
  return Math.min(height / STAGE_H, Math.max(width / STAGE_W, Math.min(0.6, width / 660)));
}

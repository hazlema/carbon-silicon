/** The sea's geometry: 8×8 cells a1..h8, a1 bottom-left, rows growing upward, as in Critical Mass. */

export const SIZE = 8;
export const LETTERS = 'abcdefgh';
/** Live mines a ghost may hold at once. */
export const MINE_LIMIT = 3;
/** The first round with a lifted row. */
export const FOG_FROM = 6;
/** The order rows lift in, edges inward. */
export const FOG_ORDER = [8, 1, 7, 2, 6, 3, 5, 4] as const;

export type Facing = 'east' | 'north';

/** Every cell name, a1 first; NAMES[i] is cell i. */
const NAMES = Array.from({ length: SIZE * SIZE }, (_, i) => `${LETTERS[i % SIZE]}${Math.floor(i / SIZE) + 1}`);
const INDEX = new Map(NAMES.map((name, i) => [name, i]));

/** 'a1' → 0 … 'h8' → 63, case-insensitive; null if off the sea. */
export function cellIndex(cell: string): number | null {
  if (typeof cell !== 'string') return null;
  return INDEX.get(cell) ?? INDEX.get(cell.trim().toLowerCase()) ?? null;
}

export function cellName(i: number): string {
  return NAMES[i];
}

/** The row number (1..8) a cell sits in. */
export const rowOf = (cell: string): number => Number(cell.slice(1));

/** The (up to) eight cells around a cell, in board order (a1 first). */
export function neighbours(cell: string): string[] {
  const i = cellIndex(cell);
  if (i === null) return [];
  const c = i % SIZE;
  const r = Math.floor(i / SIZE);
  const out: string[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) out.push(cellName(rr * SIZE + cc));
    }
  }
  return out;
}

/** A hull from its first cell toward its facing; null if any of it leaves the sea. */
export function hullCells(at: string, length: number, facing: Facing): string[] | null {
  const i = cellIndex(at);
  if (i === null) return null;
  const c = i % SIZE;
  const r = Math.floor(i / SIZE);
  if (facing === 'east' ? c + length > SIZE : r + length > SIZE) return null;
  return Array.from({ length }, (_, k) => cellName(facing === 'east' ? i + k : i + k * SIZE));
}

/** The rows lifted by this round, in the order they lifted: [] before FOG_FROM, then 8, 1, 7, 2, 6, 3, 5, 4. */
export function liftedRows(round: number): number[] {
  if (round < FOG_FROM) return [];
  return FOG_ORDER.slice(0, Math.min(FOG_ORDER.length, round - FOG_FROM + 1));
}

/** A sonar buoy's 3×3 lies wholly on the sea, so its centre is b2..g7. */
export function isBuoyCentre(cell: string): boolean {
  const i = cellIndex(cell);
  if (i === null) return false;
  const c = i % SIZE;
  const r = Math.floor(i / SIZE);
  return c >= 1 && c <= SIZE - 2 && r >= 1 && r <= SIZE - 2;
}

/** The nine cells a buoy at this centre listens to, in board order. */
export const buoyCells = (centre: string): string[] => [centre, ...neighbours(centre)].sort((a, b) => cellIndex(a)! - cellIndex(b)!);

/** The Arsenal's pure helpers: items, cluster and torpedo geometry, and crate dealing. */
import { createRng, type SeatId } from '@cs/game-api';
import { LETTERS, SIZE, cellIndex, cellName } from './board';

export type ItemId = 'cluster' | 'torpedo' | 'repair' | 'decoy';
export const ITEMS: readonly ItemId[] = ['cluster', 'torpedo', 'repair', 'decoy'];
/** Items a seat may hold at once. */
export const ITEM_LIMIT = 2;

export const isItemId = (x: unknown): x is ItemId => ITEMS.includes(x as ItemId);

/** The cell and its four orthogonal neighbours that lie on the sea, centre first, then board order. */
export function clusterCells(cell: string): string[] {
  const i = cellIndex(cell);
  if (i === null) return [];
  const c = i % SIZE;
  const r = Math.floor(i / SIZE);
  const around = [
    [r - 1, c],
    [r, c - 1],
    [r, c + 1],
    [r + 1, c],
  ].filter(([y, x]) => y >= 0 && y < SIZE && x >= 0 && x < SIZE);
  return [cellName(i), ...around.map(([y, x]) => cellName(y * SIZE + x))];
}

const ROWS = Array.from({ length: SIZE }, (_, i) => String(i + 1));
const COLUMNS = LETTERS.split('');

/** The lanes a shooter may use: columns 'a'..'h' for north/south, '1'..'8' for east/west. */
export function lanesFor(shooter: SeatId): string[] {
  return shooter === 'east' || shooter === 'west' ? [...ROWS] : [...COLUMNS];
}

/**
 * The cells a torpedo from `shooter` runs through on lane `lane`, in travel order; null if the lane is
 * invalid for that shooter. North runs down a column from row 8, south up from row 1, east along a row
 * from column h westward, west from column a eastward.
 */
export function torpedoLane(shooter: SeatId, lane: string): string[] | null {
  if (typeof lane !== 'string' || !lanesFor(shooter).includes(lane)) return null;
  if (shooter === 'east' || shooter === 'west') {
    const cells = COLUMNS.map((x) => `${x}${lane}`);
    return shooter === 'east' ? cells.reverse() : cells;
  }
  const cells = ROWS.map((y) => `${lane}${y}`);
  return shooter === 'north' ? cells.reverse() : cells;
}

/** Three different items, seeded: rng from (seed, draws). */
export function dealCrate(seed: number, draws: number): ItemId[] {
  const rng = createRng((seed + draws * 7919) >>> 0);
  const deck = [...ITEMS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, 3);
}

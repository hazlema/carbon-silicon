import type { Kind } from '@cs/shared/protocol';

const CARBON = '#ff8a3d';
const SILICON = '#4fe3ff';
const NEUTRAL = '#9aa1cf';

/** Carbon, silicon, nitrogen green, phosphorus violet: the neighbours on the lattice. */
export const TABLE_PALETTE = [CARBON, SILICON, '#6dffa8', '#c792ff'];

export type TableColors = Record<string, string>;

/**
 * Seat colours for one table. The classic match — one human against one machine — plays
 * carbon against silicon so the colours say who is who. Any other table takes the palette
 * in seat order, so every seat stays distinct.
 */
export function tableColors(seats: { seat: string; identity: { kind: Kind } }[]): TableColors {
  const humans = seats.filter((s) => s.identity.kind === 'human').length;
  const classic = seats.length === 2 && humans === 1;
  return Object.fromEntries(
    seats.map((s, i) => [s.seat, classic ? (s.identity.kind === 'human' ? CARBON : SILICON) : TABLE_PALETTE[i % TABLE_PALETTE.length]]),
  );
}

export function colorOf(colors: TableColors, seat: string | null | undefined): string {
  return (seat && colors[seat]) || NEUTRAL;
}

/** Seconds as m:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

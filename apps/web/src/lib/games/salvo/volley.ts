import type { ShellResult, Volley } from '@cs/salvo';

/** A side of your compass. You are always drawn south. */
export type Side = 'north' | 'east' | 'south' | 'west';
const RING: readonly Side[] = ['north', 'east', 'south', 'west'];

/**
 * Where a seat sits on your compass: the ring is turned so your own seat is south, keeping the
 * others in their places around the table. Spectators (and unknown seats) get north's view.
 */
export function sideOf(seat: string, you: string | null): Side {
  const me = RING.includes(you as Side) ? (you as Side) : 'north';
  const turn = (RING.indexOf('south') - RING.indexOf(me) + 4) % 4;
  const i = RING.indexOf(seat as Side);
  return i < 0 ? 'north' : RING[(i + turn) % 4];
}

/** One shell's flight: it leaves `side` after `delay` ms and lands at `landAt`. */
export interface ShellPlan extends ShellResult {
  side: Side;
  delay: number;
  flightMs: number;
  landAt: number;
}
/** A Time on Target: one flash over its cells when its shells land. */
export interface FlashPlan {
  sea: string;
  cell: string;
  cells: string[];
  at: number;
}
/** A ship that went down this volley, and when (its bubbles start then). */
export interface SinkPlan {
  sea: string;
  ship: string;
  at: number;
}
export interface VolleyPlan {
  round: number;
  shells: ShellPlan[];
  flashes: FlashPlan[];
  sinkings: SinkPlan[];
  /** When the last impact has played out. */
  total: number;
}

/** A shell's time in the air. */
export const FLIGHT_MS = 1100;
/** Time between launches, before a crowded volley squeezes it. */
export const STAGGER_MS = 550;
/** An impact's splash, scorch or flash after landing. */
export const IMPACT_MS = 450;
/** The whole volley, every sea, plays inside this. */
export const MAX_TOTAL_MS = 4000;

/**
 * The volley as decoration, from the data alone: shells launch in the volley's order (seat order),
 * the shells of one Time on Target share a launch and land together, and the stagger shrinks so the
 * last impact ends inside four seconds. Reduced motion: everything lands at once.
 */
export function planVolley(volley: Volley, side: (seat: string) => Side, opts: { reducedMotion?: boolean } = {}): VolleyPlan {
  const still = !!opts.reducedMotion;
  // One launch slot per lone shell, one per Time on Target.
  const slotOf = new Map<string, number>();
  const slots: number[] = volley.shells.map((x) => {
    const key = x.blast ? `${x.sea} ${x.cell}` : `#${slotOf.size}`;
    if (!slotOf.has(key)) slotOf.set(key, slotOf.size);
    return slotOf.get(key)!;
  });
  const count = slotOf.size;
  const flightMs = still ? 0 : Math.min(FLIGHT_MS, MAX_TOTAL_MS - IMPACT_MS);
  const stagger = still || count <= 1 ? 0 : Math.min(STAGGER_MS, (MAX_TOTAL_MS - IMPACT_MS - flightMs) / (count - 1));
  const shells: ShellPlan[] = volley.shells.map((x, i) => {
    const delay = Math.round(slots[i] * stagger);
    return { ...x, side: side(x.from), delay, flightMs, landAt: delay + flightMs };
  });
  const flashes: FlashPlan[] = volley.blasts.map((b) => {
    const at = shells.find((x) => x.blast && x.sea === b.sea && x.cell === b.cell)?.landAt ?? 0;
    return { sea: b.sea, cell: b.cell, cells: [...b.cells], at };
  });
  const last = Math.max(0, ...shells.map((x) => x.landAt), ...flashes.map((x) => x.at));
  // A ship goes down when the shell that sank it lands, or with the blast on its sea that took it.
  const sinkings: SinkPlan[] = volley.sunk.map((x) => ({
    sea: x.sea,
    ship: x.ship,
    at: shells.find((sh) => sh.sea === x.sea && sh.result === 'sunk' && sh.ship === x.ship)?.landAt ?? flashes.find((f) => f.sea === x.sea)?.at ?? last,
  }));
  return { round: volley.round, shells, flashes, sinkings, total: still || shells.length === 0 ? 0 : last + IMPACT_MS };
}

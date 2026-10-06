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
/** A sonar buoy splashing down: a ping at its centre `at` ms in (after the warning). */
export interface BuoyPlan {
  from: string;
  sea: string;
  cell: string;
  at: number;
}
export interface VolleyPlan {
  round: number;
  /** The warning before anything flies ("3 shells incoming"); every time below already includes it. */
  lead: number;
  shells: ShellPlan[];
  flashes: FlashPlan[];
  sinkings: SinkPlan[];
  buoys: BuoyPlan[];
  /** When the last impact has played out. */
  total: number;
}

/** A shell's time in the air. */
export const FLIGHT_MS = 1100;
/** Time between launches, before a crowded volley squeezes it. */
export const STAGGER_MS = 550;
/** An impact's splash, scorch or flash after landing. */
export const IMPACT_MS = 450;
/** The shells of the whole volley, every sea, play inside this (after the warning and the beat). A full
 *  four-seat round is 16 shells: 5.5 s keeps them about a quarter-second apart, so each salvo reads as a ripple. */
export const MAX_TOTAL_MS = 5500;
/** The "incoming" warning, before the first launch. */
export const LEAD_MS = 1200;
/** The held breath before the shells aimed at your own sea, which always come last. */
export const BEAT_MS = 600;

/** The shells coming at your sea this volley, who sent them (seat order, once each), and how many sonar buoys fell on it. */
export function incoming(volley: Volley, you: string | null): { count: number; from: string[]; buoys: number } {
  const mine = you ? volley.shells.filter((x) => x.sea === you) : [];
  const buoys = you ? (volley.buoys ?? []).filter((x) => x.sea === you).length : 0;
  return { count: mine.length, from: [...new Set(mine.map((x) => x.from))], buoys };
}

/**
 * The volley as decoration, from the data alone. With `you`, a warning plays first (`lead`), and the
 * shells aimed at your sea fly last, after a held beat. Otherwise shells launch in the volley's order
 * (seat order), the shells of one Time on Target share a launch and land together, and the stagger
 * shrinks so the shells fit in MAX_TOTAL_MS (5.5 s). Reduced motion: everything lands at once, no warning.
 */
export function planVolley(volley: Volley, side: (seat: string) => Side, opts: { reducedMotion?: boolean; you?: string | null } = {}): VolleyPlan {
  const still = !!opts.reducedMotion;
  const you = opts.you ?? null;
  const atYou = (x: ShellResult) => you !== null && x.sea === you;
  // One launch slot per lone shell, one per Time on Target; the ones at your sea go last.
  const order = [...volley.shells.filter((x) => !atYou(x)), ...volley.shells.filter(atYou)];
  const slotOf = new Map<string, number>();
  const slotByShell = new Map<ShellResult, number>();
  for (const x of order) {
    const key = x.blast ? `${x.sea} ${x.cell}` : `#${slotOf.size}`;
    if (!slotOf.has(key)) slotOf.set(key, slotOf.size);
    slotByShell.set(x, slotOf.get(key)!);
  }
  const count = slotOf.size;
  const firstAtYou = Math.min(...order.filter(atYou).map((x) => slotByShell.get(x)!));
  const lead = still || !you ? 0 : LEAD_MS;
  const beat = still || !Number.isFinite(firstAtYou) || firstAtYou === 0 ? 0 : BEAT_MS;
  const flightMs = still ? 0 : Math.min(FLIGHT_MS, MAX_TOTAL_MS - IMPACT_MS);
  const stagger = still || count <= 1 ? 0 : Math.min(STAGGER_MS, (MAX_TOTAL_MS - IMPACT_MS - flightMs) / (count - 1));
  const shells: ShellPlan[] = volley.shells.map((x) => {
    const slot = slotByShell.get(x)!;
    const delay = Math.round(lead + slot * stagger + (slot >= firstAtYou ? beat : 0));
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
  // Buoys splash down as the volley opens, before the first shell lands.
  const buoys: BuoyPlan[] = (volley.buoys ?? []).map((b) => ({ from: b.from, sea: b.sea, cell: b.cell, at: lead }));
  return { round: volley.round, lead, shells, flashes, sinkings, buoys, total: still || shells.length === 0 ? lead : last + IMPACT_MS };
}

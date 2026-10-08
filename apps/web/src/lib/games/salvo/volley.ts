import type { ItemUse, ShellResult, Volley } from '@cs/salvo';

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
/** A ghost's mine going off when the shell over it lands (`at`); a boomerang's hits come back on the shooters' own seas RETURN_MS later. */
export interface MinePlan {
  ghost: string;
  sea: string;
  cell: string;
  at: number;
  result: 'boomerang' | 'backfire';
  returns: { sea: string; cell: string; at: number }[];
}
/**
 * An item in the volley, staged. Every one has `at`: a cluster's is when it lands (it flies like a shell, `delay`
 * to `landAt`, then flashes its plus); a torpedo's is when it sets off from its edge, reaching `path[k]` at
 * `steps[k]` and stopping (at `struck`, or off the far edge) at `end`; a repair sparks at the volley's open; a
 * revealed decoy is stamped when the shot that finished it lands.
 */
export type ItemPlan =
  | (Extract<ItemUse, { item: 'cluster' }> & { side: Side; delay: number; flightMs: number; landAt: number; at: number })
  | (Extract<ItemUse, { item: 'torpedo' }> & { side: Side; at: number; steps: number[]; end: number })
  | (Extract<ItemUse, { item: 'repair' }> & { at: number })
  | (Extract<ItemUse, { item: 'decoy' }> & { at: number });
export interface VolleyPlan {
  round: number;
  /** The warning before anything flies ("3 shells incoming"); every time below already includes it. */
  lead: number;
  shells: ShellPlan[];
  flashes: FlashPlan[];
  sinkings: SinkPlan[];
  buoys: BuoyPlan[];
  /** Mines that went off this volley, each with its returns. */
  mines: MinePlan[];
  /** Items used this volley (clusters, torpedoes, repairs) and decoys revealed, in the volley's order. A decoy laid is never staged. */
  items: ItemPlan[];
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
/** A mine's boomerang: the beat between the flash on the mined sea and the hit on the shooter's own. */
export const RETURN_MS = 700;
/** A torpedo's time from one cell of its lane to the next. */
export const TORPEDO_STEP_MS = 90;

type Launched = Extract<ItemUse, { item: 'cluster' | 'torpedo' }>;
const launched = (x: ItemUse): x is Launched => x.item === 'cluster' || x.item === 'torpedo';

/**
 * The shells coming at your sea this volley, the clusters and torpedoes too (`items`, in the volley's order), who
 * sent them (shells first, then items; once each), and how many sonar buoys fell on it.
 */
export function incoming(volley: Volley, you: string | null): { count: number; items: ('cluster' | 'torpedo')[]; from: string[]; buoys: number } {
  const mine = you ? volley.shells.filter((x) => x.sea === you) : [];
  const items = you ? (volley.items ?? []).filter(launched).filter((x) => x.sea === you) : [];
  const buoys = you ? (volley.buoys ?? []).filter((x) => x.sea === you).length : 0;
  return { count: mine.length, items: items.map((x) => x.item), from: [...new Set([...mine, ...items].map((x) => x.from))], buoys };
}

/**
 * When each cell a volley touched shows its result, by `sea cell`: as its shell lands, with the flash that took
 * it, under a cluster's plus, as a torpedo runs past, or as a boomerang comes back on it (the latest, if several).
 */
export function landingTimes(plan: Pick<VolleyPlan, 'shells' | 'flashes' | 'mines' | 'items'>): Map<string, number> {
  const at = new Map<string, number>();
  const land = (sea: string, cell: string, t: number) => at.set(`${sea} ${cell}`, Math.max(t, at.get(`${sea} ${cell}`) ?? 0));
  for (const f of plan.flashes) for (const c of f.cells) land(f.sea, c, f.at);
  for (const x of plan.shells) land(x.sea, x.cell, x.landAt);
  for (const x of plan.items) {
    if (x.item === 'cluster') for (const c of x.cells) land(x.sea, c, x.landAt);
    else if (x.item === 'torpedo') x.path.forEach((c, k) => land(x.sea, c, x.steps[k]));
  }
  for (const m of plan.mines) for (const r of m.returns) land(r.sea, r.cell, r.at);
  return at;
}

/**
 * The volley as decoration, from the data alone. With `you`, a warning plays first (`lead`), and the
 * shots aimed at your sea fly last, after a held beat. Otherwise shells launch in the volley's order
 * (seat order), then the clusters and torpedoes (each a launch of its own), the shells of one Time on
 * Target share a launch and land together, and the stagger shrinks so it all fits in MAX_TOTAL_MS (5.5 s).
 * A torpedo sets off so it ends its run as a shell launched with it would land. Reduced motion: everything
 * lands at once, no warning.
 */
export function planVolley(volley: Volley, side: (seat: string) => Side, opts: { reducedMotion?: boolean; you?: string | null } = {}): VolleyPlan {
  const still = !!opts.reducedMotion;
  const you = opts.you ?? null;
  const atYou = (x: { sea: string }) => you !== null && x.sea === you;
  const used = volley.items ?? [];
  const fired = used.filter(launched);
  // One launch slot per lone shell, one per Time on Target, one per cluster or torpedo; the ones at your sea go last.
  type Shot = ShellResult | Launched;
  const order: Shot[] = [
    ...volley.shells.filter((x) => !atYou(x)),
    ...fired.filter((x) => !atYou(x)),
    ...volley.shells.filter(atYou),
    ...fired.filter(atYou),
  ];
  const slotOf = new Map<string, number>();
  const slotByShot = new Map<Shot, number>();
  for (const x of order) {
    const key = 'blast' in x && x.blast ? `${x.sea} ${x.cell}` : `#${slotOf.size}`;
    if (!slotOf.has(key)) slotOf.set(key, slotOf.size);
    slotByShot.set(x, slotOf.get(key)!);
  }
  const count = slotOf.size;
  const firstAtYou = Math.min(...order.filter(atYou).map((x) => slotByShot.get(x)!));
  const lead = still || !you ? 0 : LEAD_MS;
  const beat = still || !Number.isFinite(firstAtYou) || firstAtYou === 0 ? 0 : BEAT_MS;
  const flightMs = still ? 0 : Math.min(FLIGHT_MS, MAX_TOTAL_MS - IMPACT_MS);
  const stagger = still || count <= 1 ? 0 : Math.min(STAGGER_MS, (MAX_TOTAL_MS - IMPACT_MS - flightMs) / (count - 1));
  const launchAt = (x: Shot) => {
    const slot = slotByShot.get(x)!;
    return Math.round(lead + slot * stagger + (slot >= firstAtYou ? beat : 0));
  };
  const shells: ShellPlan[] = volley.shells.map((x) => {
    const delay = launchAt(x);
    return { ...x, side: side(x.from), delay, flightMs, landAt: delay + flightMs };
  });
  const flashes: FlashPlan[] = volley.blasts.map((b) => {
    const at = shells.find((x) => x.blast && x.sea === b.sea && x.cell === b.cell)?.landAt ?? 0;
    return { sea: b.sea, cell: b.cell, cells: [...b.cells], at };
  });
  // Clusters fly like shells; a torpedo runs its lane a cell at a time.
  const step = still ? 0 : TORPEDO_STEP_MS;
  const items: ItemPlan[] = [];
  for (const x of used) {
    if (x.item === 'cluster') {
      const delay = launchAt(x);
      items.push({ ...x, cells: [...x.cells], hits: [...x.hits], side: side(x.from), delay, flightMs, landAt: delay + flightMs, at: delay + flightMs });
    } else if (x.item === 'torpedo') {
      const at = launchAt(x) + Math.max(0, flightMs - x.path.length * step);
      const steps = x.path.map((_, k) => at + (k + 1) * step);
      items.push({ ...x, path: [...x.path], side: side(x.from), at, steps, end: steps.at(-1) ?? at });
    } else if (x.item === 'repair') {
      items.push({ ...x, at: lead });
    }
  }
  // A mine goes off as the (last) shell over it lands; a boomerang's hits come back RETURN_MS later.
  const mines: MinePlan[] = [];
  /** `sea ship` → when a backfire blew that ship (or a decoy) up. */
  const backfires = new Map<string, number>();
  for (const t of volley.tricks ?? []) {
    if (t.kind !== 'mine') continue;
    const at = Math.max(0, ...shells.filter((x) => x.sea === t.sea && x.cell === t.cell).map((x) => x.landAt));
    const returns = t.result === 'boomerang' ? t.hits.map((h) => ({ sea: h.sea, cell: h.cell, at: still ? at : at + RETURN_MS })) : [];
    mines.push({ ghost: t.ghost, sea: t.sea, cell: t.cell, at, result: t.result, returns });
    if (t.result === 'backfire') backfires.set(`${t.sea} ${t.ship}`, at);
  }
  const landing = landingTimes({ shells, flashes, mines, items });
  const last = Math.max(0, ...landing.values(), ...mines.map((m) => m.at), ...items.map((x) => (x.item === 'torpedo' ? x.end : x.at)));
  // A decoy is found as the last shot on its cells lands (or as the mine under it goes off).
  for (const x of used) {
    if (x.item !== 'decoy') continue;
    const on = x.cells.map((c) => landing.get(`${x.sea} ${c}`)).filter((t): t is number => t !== undefined);
    const at = backfires.get(`${x.sea} decoy`) ?? (on.length ? Math.max(...on) : last);
    items.push({ ...x, cells: [...x.cells], by: [...x.by], at });
  }
  // A ship goes down when the shell that sank it lands, or with the mine that blew it up (a backfire), the boomerang
  // that came back on it, or the blast or item hits on its sea that took it.
  const returnAt = (sea: string) => {
    const at = mines.flatMap((m) => m.returns.filter((r) => r.sea === sea).map((r) => r.at));
    return at.length ? Math.max(...at) : undefined;
  };
  const itemHitAt = (sea: string) => {
    const at = items.flatMap((x) =>
      x.item === 'cluster' && x.sea === sea ? (x.hits.length ? [x.landAt] : []) : x.item === 'torpedo' && x.sea === sea && x.struck ? [x.end] : [],
    );
    return at.length ? Math.max(...at, ...flashes.filter((f) => f.sea === sea).map((f) => f.at)) : undefined;
  };
  const sinkings: SinkPlan[] = volley.sunk.map((x) => ({
    sea: x.sea,
    ship: x.ship,
    at:
      shells.find((sh) => sh.sea === x.sea && sh.result === 'sunk' && sh.ship === x.ship)?.landAt ??
      backfires.get(`${x.sea} ${x.ship}`) ??
      returnAt(x.sea) ??
      itemHitAt(x.sea) ??
      flashes.find((f) => f.sea === x.sea)?.at ??
      last,
  }));
  // Buoys splash down as the volley opens, before the first shell lands.
  const buoys: BuoyPlan[] = (volley.buoys ?? []).map((b) => ({ from: b.from, sea: b.sea, cell: b.cell, at: lead }));
  const quiet = shells.length === 0 && fired.length === 0;
  return { round: volley.round, lead, shells, flashes, sinkings, buoys, mines, items, total: still || quiet ? lead : last + IMPACT_MS };
}

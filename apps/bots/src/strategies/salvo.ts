import { SHIPS, SIZE, buoyCells, cellIndex, cellName, hullCells, neighbours, type SalvoCommand, type SalvoView, type TargetView } from '@cs/salvo';

export type SalvoStrength = 'easy' | 'medium' | 'hard';
export interface SalvoStrategyOptions {
  strength: SalvoStrength;
  rng: () => number;
}

type Fire = Extract<SalvoCommand, { fire: 'shell' }>;
type Buoy = Extract<SalvoCommand, { fire: 'buoy' }>;
type Order = Fire | Buoy;

/** How much more a placement counts for each known ship cell it covers. */
const KNOWN_WEIGHT = 3;
/** Medium drops a buoy about one hunting round in this many. */
const MEDIUM_BUOY_ODDS = 5;
/** Hard waits this many rounds after a buoy before it drops another. */
const HARD_BUOY_GAP = 3;

const rowOf = (cell: string) => Number(cell.slice(1));
const ALL_CELLS = Array.from({ length: SIZE * SIZE }, (_, i) => cellName(i));
const isShell = (c: SalvoCommand): c is Fire => 'fire' in c && c.fire === 'shell';
const isBuoy = (c: SalvoCommand): c is Buoy => 'fire' in c && c.fire === 'buoy';
const pick = <T>(xs: readonly T[], rng: () => number): T => xs[Math.floor(rng() * xs.length)];

/** Hits on ships still afloat: the cells worth chasing. */
function openHits(t: TargetView): string[] {
  const sunk = new Set(t.sunk.flatMap((x) => x.cells));
  return t.hits.filter((c) => !sunk.has(c));
}

/** A stretch of sea with a known count of unhit ship cells in it: its unshot cells and that count. */
interface Region {
  open: string[];
  afloat: number;
}

/**
 * The counts I know on a target: each lifted row, each of my sonar readings, and (once rows have
 * lifted) the unlifted remainder, whose count is what the lifted rows don't account for. Every
 * unhit ship cell is an unshot cell, so a count is spread over the region's unshot cells.
 */
function regions(t: TargetView): { rows: Map<number, Region>; readings: Region[]; rest: Region } {
  const shot = new Set([...t.hits, ...t.misses]);
  const unshot = (cells: string[]) => cells.filter((c) => !shot.has(c));
  const rows = new Map(t.lifted.map(({ row, afloat }) => [row, { open: unshot(ALL_CELLS.filter((c) => rowOf(c) === row)), afloat }]));
  const readings = (t.sonar ?? []).map((x) => ({ open: unshot(x.cells), afloat: x.afloat }));
  const counted = [...rows.values()].reduce((n, r) => n + r.afloat, 0);
  const rest = { open: unshot(ALL_CELLS.filter((c) => !rows.has(rowOf(c)))), afloat: Math.max(0, t.afloat - counted) };
  return { rows, readings, rest };
}

/** The heat on every cell of a target, and the unshot cells that must be ship (see heatmap). */
function analyse(target: TargetView): { heat: Map<string, number>; sure: Set<string> } {
  const sunkCells = new Set(target.sunk.flatMap((x) => x.cells));
  const shot = new Set([...target.hits, ...target.misses]);
  const blocked = new Set([...target.misses, ...sunkCells]);
  const sure = new Set<string>();
  const { rows, readings, rest } = regions(target);
  // A count of 0 is open water; a count that fills every unshot cell is all ship.
  for (const r of [...rows.values(), ...readings, ...(rows.size > 0 ? [rest] : [])]) {
    if (r.afloat === 0) r.open.forEach((c) => blocked.add(c));
    else if (r.afloat >= r.open.length) r.open.forEach((c) => sure.add(c));
  }
  for (const c of sure) blocked.delete(c);
  const known = new Set([...openHits(target), ...sure]);
  const sunkIds = new Set(target.sunk.map((x) => x.ship));
  const heat = new Map(ALL_CELLS.map((c) => [c, 0]));
  for (const ship of SHIPS) {
    if (sunkIds.has(ship.id)) continue;
    for (const at of ALL_CELLS) {
      for (const facing of ['east', 'north'] as const) {
        const hull = hullCells(at, ship.length, facing);
        if (!hull || hull.some((c) => blocked.has(c))) continue;
        const weight = KNOWN_WEIGHT ** hull.filter((c) => known.has(c)).length;
        for (const c of hull) if (!shot.has(c)) heat.set(c, heat.get(c)! + weight);
      }
    }
  }
  // Density: a cell in a lifted row, or under a reading, is as much likelier than the rest of the
  // sea as its count per unshot cell is above the remainder's (multiplied when both apply).
  const density = (r: Region) => (r.open.length > 0 ? r.afloat / r.open.length : 0);
  const allOpen = ALL_CELLS.filter((c) => !shot.has(c)).length;
  const base = density(rest) || (allOpen > 0 ? target.afloat / allOpen : 0);
  if (base > 0) {
    const factor = new Map<string, number>();
    const scale = (r: Region) => r.open.forEach((c) => factor.set(c, (factor.get(c) ?? 1) * (density(r) / base)));
    rows.forEach(scale);
    readings.forEach(scale);
    for (const [c, f] of factor) heat.set(c, heat.get(c)! * f);
  }
  const likely = Math.max(0, ...[...heat].filter(([c]) => !sure.has(c)).map(([, h]) => h));
  for (const c of sure) heat.set(c, Math.max(1, heat.get(c)!) + likely);
  return { heat, sure };
}

/**
 * For each cell of a target, how many ways a surviving ship could lie across it, from what I know:
 * a hull may not cover a miss, a sunk ship, or cells a count of 0 (a lifted row, my sonar, or the
 * remainder once the rows account for every ship cell) says are open water; a hull through a known
 * ship cell (an unsunk hit, or a sure one) counts KNOWN_WEIGHT times over per such cell. A count
 * that equals its unshot cells makes them sure hits, ranked above every cell that is only likely.
 * Otherwise a lifted row's or a reading's count scales its cells' heat by how dense it is against
 * the rest of the sea. Every cell is in the map; a cell anyone has already shot is 0.
 */
export function heatmap(target: TargetView): Map<string, number> {
  return analyse(target).heat;
}

/** The legal orders of one kind, grouped by the sea they aim at. */
function bySea<T extends Order>(legal: SalvoCommand[], is: (c: SalvoCommand) => c is T): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of legal) if (is(c)) out.set(c.at, [...(out.get(c.at) ?? []), c]);
  return out;
}

/** The round of my latest sonar buoy on any sea, or -Infinity if I have dropped none. */
const lastBuoyRound = (view: SalvoView) => Math.max(-Infinity, ...view.targets.flatMap((t) => (t.sonar ?? []).map((x) => x.round)));

/** The legal buoys on one sea that score highest, by `score` of each 3×3's cells. */
function bestBuoys(buoys: Buoy[], score: (cells: string[]) => number): Buoy[] {
  const scored = buoys.map((b) => ({ b, v: score(buoyCells(b.cell)) }));
  const top = Math.max(...scored.map((x) => x.v));
  return scored.filter((x) => x.v === top).map((x) => x.b);
}

/** The legal shells at unshot cells beside a hit on a ship still afloat; `straight` keeps to the four in line. */
function chases(t: TargetView, shells: Fire[], straight: boolean): Fire[] {
  const shot = new Set([...t.hits, ...t.misses]);
  const near = new Set<string>();
  for (const h of openHits(t)) {
    for (const n of neighbours(h)) {
      const sameCol = n[0] === h[0];
      const sameRow = rowOf(n) === rowOf(h);
      if (!shot.has(n) && (!straight || sameCol || sameRow)) near.add(n);
    }
  }
  return shells.filter((s) => near.has(s.cell));
}

const parity = (cell: string) => {
  const i = cellIndex(cell)!;
  return ((i % SIZE) + Math.floor(i / SIZE)) % 2 === 0;
};

/** Seats that put a shell into my fleet in the last volley (shell hits, sinkings and blasts). */
export function whoHitMe(view: SalvoView): string[] {
  const v = view.lastVolley;
  if (!v || !view.you) return [];
  const out = new Set<string>();
  for (const s of v.shells) if (s.sea === view.you && s.result !== 'miss') out.add(s.from);
  for (const b of v.blasts) if (b.sea === view.you && b.hits.length > 0) b.by.forEach((x) => out.add(x));
  return [...out];
}

/** Easy never drops a buoy: it chases any hit it sees, else shoots a fresh cell at random. */
function easy(view: SalvoView, seas: Map<string, Fire[]>, rng: () => number): Fire {
  const targets = view.targets.filter((t) => seas.has(t.sea));
  const near = targets.flatMap((t) => chases(t, seas.get(t.sea)!, false));
  if (near.length > 0) return pick(near, rng);
  const fresh = targets.flatMap((t) => {
    const shot = new Set([...t.hits, ...t.misses]);
    return seas.get(t.sea)!.filter((s) => !shot.has(s.cell));
  });
  return pick(fresh.length > 0 ? fresh : [...seas.values()].flat(), rng);
}

/** Unshot cells a count of 0 (a lifted row or one of my readings) says are open water. */
function emptyWater(t: TargetView): Set<string> {
  const { rows, readings } = regions(t);
  return new Set([...rows.values(), ...readings].filter((r) => r.afloat === 0).flatMap((r) => r.open));
}

/**
 * Medium bears a grudge, chases in line, and hunts on one colour of the checkerboard away from
 * water a count of 0 has cleared. Hunting after round 2, about one round in five, it drops a buoy
 * on that sea where its 3×3 has the most unshot cells, never two rounds running.
 */
function medium(view: SalvoView, seas: Map<string, Fire[]>, buoys: Map<string, Buoy[]>, rng: () => number): Order {
  const targets = view.targets.filter((t) => seas.has(t.sea));
  const grudges = whoHitMe(view).filter((x) => seas.has(x));
  let target: TargetView | undefined;
  if (grudges.length > 0) {
    const sea = pick(grudges, rng);
    target = targets.find((t) => t.sea === sea);
  }
  if (!target) {
    const most = Math.max(...targets.map((t) => t.hits.length));
    target = pick(targets.filter((t) => t.hits.length === most), rng);
  }
  if (!target) return pick([...seas.values()].flat(), rng);
  const shells = seas.get(target.sea)!;
  const near = chases(target, shells, true);
  if (near.length > 0) return pick(near, rng);
  const shot = new Set([...target.hits, ...target.misses]);
  const drops = buoys.get(target.sea) ?? [];
  if (drops.length > 0 && view.round > 2 && lastBuoyRound(view) < view.round - 1 && rng() < 1 / MEDIUM_BUOY_ODDS) {
    return pick(bestBuoys(drops, (cells) => cells.filter((c) => !shot.has(c)).length), rng);
  }
  // Parity: every ship is at least two long, so one colour of the checkerboard finds them all.
  const water = emptyWater(target);
  const fresh = shells.filter((s) => !shot.has(s.cell));
  const dry = fresh.filter((s) => !water.has(s.cell));
  const pool = dry.length > 0 ? dry : fresh;
  const even = pool.filter((s) => parity(s.cell));
  return pick(even.length > 0 ? even : pool.length > 0 ? pool : shells, rng);
}

/**
 * Hard shoots the hottest cell on the fleet closest to the bottom. With nothing to chase anywhere
 * (no open hit, no sure cell) and no buoy of its own in the last three rounds, it drops a buoy on
 * that sea instead, where the 3×3's summed heat is greatest.
 */
function hard(view: SalvoView, seas: Map<string, Fire[]>, buoys: Map<string, Buoy[]>, rng: () => number): Order {
  const scored = view.targets
    .filter((t) => seas.has(t.sea))
    .map((t) => {
      const { heat, sure } = analyse(t);
      const shells = seas.get(t.sea)!.map((s) => ({ s, h: heat.get(s.cell) ?? 0 }));
      const top = Math.max(...shells.map((x) => x.h));
      const certain = shells.some((x) => sure.has(x.s.cell));
      return { t, heat, shells, top, certain };
    })
    .filter((x) => x.top > 0);
  if (scored.length === 0) return pick([...seas.values()].flat(), rng);
  // The fleet closest to the bottom, and the hottest cell in it (the hotter sea breaks a tie).
  scored.sort((a, b) => a.t.afloat - b.t.afloat || b.top - a.top);
  const best = scored.filter((x) => x.t.afloat === scored[0].t.afloat && x.top === scored[0].top);
  const sea = pick(best, rng);
  const hunting = scored.every((x) => !x.certain && openHits(x.t).length === 0);
  const drops = buoys.get(sea.t.sea) ?? [];
  if (hunting && drops.length > 0 && view.round - lastBuoyRound(view) > HARD_BUOY_GAP) {
    const warm = (cells: string[]) => cells.reduce((n, c) => n + (sea.heat.get(c) ?? 0), 0);
    const where = bestBuoys(drops, warm);
    if (warm(buoyCells(where[0].cell)) > 0) return pick(where, rng);
  }
  return pick(
    sea.shells.filter((x) => x.h === sea.top).map((x) => x.s),
    rng,
  );
}

/** Picks one entry of `legal`, from the view alone. Deployment is always at random. */
export function chooseSalvoMove(view: SalvoView, legal: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand {
  if (legal.length === 0) throw new Error('No legal moves.');
  const random = legal.find((c) => 'place' in c && c.place === 'random');
  if (random) return random;
  const seas = bySea(legal, isShell);
  if (seas.size === 0) return pick(legal, opts.rng);
  const buoys = bySea(legal, isBuoy);
  const choice =
    opts.strength === 'hard' ? hard(view, seas, buoys, opts.rng) : opts.strength === 'medium' ? medium(view, seas, buoys, opts.rng) : easy(view, seas, opts.rng);
  // Hand back the very entry from `legal`; anything else falls back to a random legal one.
  if (legal.includes(choice)) return choice;
  return legal.find((c) => 'fire' in c && c.fire === choice.fire && c.at === choice.at && c.cell === choice.cell) ?? pick(legal, opts.rng);
}

/** What the last volley means to me at the table: I sank someone's ship, or someone hit mine. */
export function volleyMoment(view: SalvoView): 'bigCascade' | 'gotHit' | null {
  const v = view.lastVolley;
  if (!v || !view.you) return null;
  const me = view.you;
  if (v.sunk.some((x) => x.by.includes(me) && x.sea !== me)) return 'bigCascade';
  if (whoHitMe(view).length > 0) return 'gotHit';
  return null;
}

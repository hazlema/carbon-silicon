import { SHIPS, SIZE, cellIndex, cellName, hullCells, neighbours, type SalvoCommand, type SalvoView, type TargetView } from '@cs/salvo';

export type SalvoStrength = 'easy' | 'medium' | 'hard';
export interface SalvoStrategyOptions {
  strength: SalvoStrength;
  rng: () => number;
}

type Fire = Extract<SalvoCommand, { fire: 'shell' }>;

/** How much more a placement counts for each known ship cell it covers. */
const KNOWN_WEIGHT = 3;

const rowOf = (cell: string) => Number(cell.slice(1));
const ALL_CELLS = Array.from({ length: SIZE * SIZE }, (_, i) => cellName(i));
const isFire = (c: SalvoCommand): c is Fire => 'fire' in c;
const pick = <T>(xs: readonly T[], rng: () => number): T => xs[Math.floor(rng() * xs.length)];

/** Hits on ships still afloat: the cells worth chasing. */
function openHits(t: TargetView): string[] {
  const sunk = new Set(t.sunk.flatMap((x) => x.cells));
  return t.hits.filter((c) => !sunk.has(c));
}

/**
 * For each cell of a target, how many ways a surviving ship could lie across it, from public
 * knowledge alone: a hull may not cover a miss, a sunk ship, or a lifted row's open water; a hull
 * through a known ship cell (an unsunk hit, or a ship the fog showed) counts KNOWN_WEIGHT times
 * over per such cell. A ship cell the fog showed and nobody has shot yet is a sure hit, so it ranks
 * above every cell that is only likely. Every cell is in the map; a cell anyone has already shot is 0.
 */
export function heatmap(target: TargetView): Map<string, number> {
  const sunkCells = new Set(target.sunk.flatMap((x) => x.cells));
  const shot = new Set([...target.hits, ...target.misses]);
  const blocked = new Set([...target.misses, ...sunkCells]);
  const known = new Set(openHits(target));
  const sure = new Set<string>();
  for (const { row, cells } of target.lifted) {
    const ships = new Set(cells);
    for (const c of ALL_CELLS) {
      if (rowOf(c) !== row) continue;
      if (!ships.has(c)) blocked.add(c);
      else if (!sunkCells.has(c)) {
        known.add(c);
        if (!shot.has(c)) sure.add(c);
      }
    }
  }
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
  const likely = Math.max(0, ...[...heat].filter(([c]) => !sure.has(c)).map(([, h]) => h));
  for (const c of sure) heat.set(c, heat.get(c)! + likely);
  return heat;
}

/** The legal shells, grouped by the sea they aim at. */
function shellsBySea(legal: SalvoCommand[]): Map<string, Fire[]> {
  const out = new Map<string, Fire[]>();
  for (const c of legal) if (isFire(c)) out.set(c.at, [...(out.get(c.at) ?? []), c]);
  return out;
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

function medium(view: SalvoView, seas: Map<string, Fire[]>, rng: () => number): Fire {
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
  // Parity: every ship is at least two long, so one colour of the checkerboard finds them all.
  const shot = new Set([...target.hits, ...target.misses]);
  const fresh = shells.filter((s) => !shot.has(s.cell));
  const even = fresh.filter((s) => parity(s.cell));
  return pick(even.length > 0 ? even : fresh.length > 0 ? fresh : shells, rng);
}

function hard(view: SalvoView, seas: Map<string, Fire[]>, rng: () => number): Fire {
  const scored = view.targets
    .filter((t) => seas.has(t.sea))
    .map((t) => {
      const heat = heatmap(t);
      const shells = seas.get(t.sea)!.map((s) => ({ s, h: heat.get(s.cell) ?? 0 }));
      const top = Math.max(...shells.map((x) => x.h));
      return { t, shells, top };
    })
    .filter((x) => x.top > 0);
  if (scored.length === 0) return pick([...seas.values()].flat(), rng);
  // The fleet closest to the bottom, and the hottest cell in it (the hotter sea breaks a tie).
  scored.sort((a, b) => a.t.afloat - b.t.afloat || b.top - a.top);
  const best = scored.filter((x) => x.t.afloat === scored[0].t.afloat && x.top === scored[0].top);
  const sea = pick(best, rng);
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
  const seas = shellsBySea(legal);
  if (seas.size === 0) return pick(legal, opts.rng);
  const choice = opts.strength === 'hard' ? hard(view, seas, opts.rng) : opts.strength === 'medium' ? medium(view, seas, opts.rng) : easy(view, seas, opts.rng);
  // Hand back the very entry from `legal`; anything else falls back to a random legal one.
  return legal.find((c) => isFire(c) && c.at === choice.at && c.cell === choice.cell) ?? pick(legal, opts.rng);
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

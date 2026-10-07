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
/** With a salvo of two or more, hard spares a shot for a buoy when its last is more than this many rounds old. */
const HARD_SALVO_BUOY_GAP = 2;
/** With a salvo of two or more, medium spares a shot for a buoy in about one hunting round in this many. */
const MEDIUM_SALVO_BUOY_ODDS = 2;
/** Medium shoots one of its best cells: those with at least this share of the best chance… */
const MEDIUM_SPREAD = 0.8;
/** …and no more than this many of them. */
const MEDIUM_CHOICES = 6;

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

/**
 * The heat on every cell of a target, and the unshot cells that must be ship (see heatmap).
 * `queued` are cells my salvo already aims at this round: they take no heat (the next shell goes to
 * the next-best cell) but still let hulls through, since a shell in flight may yet hit.
 */
function analyse(target: TargetView, queued: ReadonlySet<string> = new Set()): { heat: Map<string, number>; sure: Set<string> } {
  const sunkCells = new Set(target.sunk.flatMap((x) => x.cells));
  const shot = new Set([...target.hits, ...target.misses, ...queued]);
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
  for (const c of sure) if (!queued.has(c)) heat.set(c, Math.max(1, heat.get(c)!) + likely);
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

/** Seats that put a shell into my fleet in the last volley (shell hits, sinkings and blasts), and ghosts whose mine came back on it. */
export function whoHitMe(view: SalvoView): string[] {
  const v = view.lastVolley;
  if (!v || !view.you) return [];
  const out = new Set<string>();
  for (const s of v.shells) if (s.sea === view.you && s.result !== 'miss') out.add(s.from);
  for (const b of v.blasts) if (b.sea === view.you && b.hits.length > 0) b.by.forEach((x) => out.add(x));
  for (const t of v.tricks ?? []) if (t.kind === 'mine' && t.result === 'boomerang' && t.hits.some((h) => h.sea === view.you)) out.add(t.ghost);
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

/** Where my salvo stands this round: the shells already aimed, whether a buoy is in, and the guns. */
interface Salvo {
  /** Cells my shells already aim at this round, by sea. */
  queued: Map<string, Set<string>>;
  /** The sea of this round's first shell, if one is in. */
  sea: string | null;
  /** Shots I fire this round (1 if the view doesn't say). */
  guns: number;
  /** No order sent yet this round. */
  first: boolean;
}

function salvoOf(view: SalvoView): Salvo {
  const orders = view.myOrders ?? [];
  const queued = new Map<string, Set<string>>();
  for (const o of orders) if (o.fire === 'shell') queued.set(o.at, (queued.get(o.at) ?? new Set()).add(o.cell));
  const guns = (view.you && view.guns?.[view.you]) || 1;
  return { queued, sea: orders.find((o) => o.fire === 'shell')?.at ?? null, guns, first: orders.length === 0 };
}

/**
 * Every unshot cell of a target as the chance a ship is there: the heatmap scaled so the sea's
 * likely cells add up to its ship cells afloat that aren't already sure (sure cells are certain).
 * Unlike raw heat, chances compare across seas: a dense lifted row on one sea outranks a guess on
 * another. A cell anyone has shot is absent.
 */
export function chances(target: TargetView): Map<string, number> {
  const { heat, sure } = analyse(target);
  const shot = new Set([...target.hits, ...target.misses]);
  const open = ALL_CELLS.filter((c) => !shot.has(c));
  const likely = open.filter((c) => !sure.has(c));
  const left = Math.max(0, target.afloat - open.filter((c) => sure.has(c)).length);
  const total = likely.reduce((n, c) => n + heat.get(c)!, 0);
  return new Map(open.map((c) => [c, sure.has(c) ? 1 : total > 0 ? Math.min(1, (heat.get(c)! / total) * left) : 0]));
}

/** Every legal shell with its chance of a hit, best first (ties in legal order). */
function ranked(view: SalvoView, seas: Map<string, Fire[]>): { s: Fire; p: number }[] {
  const odds = new Map(view.targets.filter((t) => seas.has(t.sea)).map((t) => [t.sea, chances(t)]));
  return [...seas.values()]
    .flat()
    .map((s) => ({ s, p: odds.get(s.at)?.get(s.cell) ?? 0 }))
    .sort((a, b) => b.p - a.p);
}

/** Something to chase on any sea: an open hit, or a cell a count says must be ship. */
const chasing = (view: SalvoView, seas: Map<string, Fire[]>) =>
  view.targets.some((t) => seas.has(t.sea) && (openHits(t).length > 0 || analyse(t).sure.size > 0));

/** The best buoy on a sea: where the chances of the cells it hasn't heard yet add up highest. */
function scan(target: TargetView, drops: Buoy[]): Buoy | null {
  if (drops.length === 0) return null;
  const odds = chances(target);
  const heard = new Set((target.sonar ?? []).flatMap((x) => x.cells));
  const unheard = (cells: string[]) => cells.reduce((n, c) => n + (heard.has(c) ? 0 : (odds.get(c) ?? 0)), 0);
  const where = bestBuoys(drops, unheard);
  return unheard(buoyCells(where[0].cell)) > 0 ? where[0] : null;
}

/**
 * Medium reads the board like hard (every legal shell ranked by its chance of a hit, on any sea) but
 * shoots one of its top few at random, so it chases and follows the fog without being sharp. With
 * nothing to chase it sometimes spends a shot on a buoy where its best guess lies: with one gun,
 * after round 2, about one round in five (never two running); with a salvo, the round's first shot
 * about every other round.
 */
function medium(view: SalvoView, seas: Map<string, Fire[]>, buoys: Map<string, Buoy[]>, salvo: Salvo, rng: () => number): Order {
  const shells = ranked(view, seas);
  const top = shells[0]?.p ?? 0;
  const due =
    salvo.guns > 1
      ? salvo.first && view.round > 1 && lastBuoyRound(view) < view.round - 1 && rng() < 1 / MEDIUM_SALVO_BUOY_ODDS
      : view.round > 2 && lastBuoyRound(view) < view.round - 1 && rng() < 1 / MEDIUM_BUOY_ODDS;
  if (due && shells.length > 0 && !chasing(view, seas)) {
    const target = view.targets.find((t) => t.sea === shells[0].s.at)!;
    const drop = scan(target, buoys.get(target.sea) ?? []);
    if (drop) return drop;
  }
  // Its top few: within MEDIUM_SPREAD of the best, at most MEDIUM_CHOICES of them.
  const pool = shells.filter((x) => x.p >= top * MEDIUM_SPREAD).slice(0, MEDIUM_CHOICES);
  return pick(pool.length > 0 ? pool : shells, rng).s;
}

/**
 * Hard fires every shot of its salvo at the likeliest legal cell on any sea: the chance a ship is
 * there, from the hits, misses, sinkings, fog counts and its own sonar (see chances). Nobody is
 * safe for being healthy: a fresh hit or a dense lifted row anywhere draws fire. Its queued shells
 * leave `legal`, so each shot takes the next-best cell. With nothing to chase anywhere it drops a
 * buoy where its best guess lies: with one gun instead of its shell, no more than once in three
 * rounds; with a salvo as the round's first shot, once in two.
 */
function hard(view: SalvoView, seas: Map<string, Fire[]>, buoys: Map<string, Buoy[]>, salvo: Salvo, rng: () => number): Order {
  const shells = ranked(view, seas);
  if (shells.length === 0) return pick([...seas.values()].flat(), rng);
  const due = salvo.guns > 1 ? salvo.first && view.round - lastBuoyRound(view) > HARD_SALVO_BUOY_GAP : view.round - lastBuoyRound(view) > HARD_BUOY_GAP;
  if (due && !chasing(view, seas)) {
    const target = view.targets.find((t) => t.sea === shells[0].s.at)!;
    const drop = scan(target, buoys.get(target.sea) ?? []);
    if (drop) return drop;
  }
  const best = shells.filter((x) => x.p >= shells[0].p - 1e-9);
  return pick(best, rng).s;
}

type Mine = Extract<SalvoCommand, { trick: 'mine' }>;
type Splash = Extract<SalvoCommand, { trick: 'splash' }>;
const isMine = (c: SalvoCommand): c is Mine => 'trick' in c && c.trick === 'mine';
const isSplash = (c: SalvoCommand): c is Splash => 'trick' in c && c.trick === 'splash';
/** With mines on offer, a ghost at medium or hard plays a false splash instead in about this share of rounds. */
const SPLASH_SHARE = 0.35;

/**
 * Where a ghost's mine pays: on cells the living will shoot next but where no ship lies (a mine on a
 * ship backfires, sinking it for the shooter). Score = chance the cell is shot next round × (1 − chance
 * of a ship). The chase reaches every cell in line with an open hit (all of them likely shot); elsewhere a
 * cell is shot in proportion to its chance of a ship against the best cell on any sea, since the living
 * fire at the likeliest cells wherever they are. `odds` are each sea's chances.
 */
function mineScores(view: SalvoView, odds: Map<string, Map<string, number>>): (m: Mine) => number {
  const top = Math.max(1e-9, ...[...odds.values()].flatMap((p) => [...p.values()]));
  const chased = new Map(
    view.targets.map((t) => [t.sea, new Set(openHits(t).flatMap((h) => neighbours(h).filter((n) => n[0] === h[0] || rowOf(n) === rowOf(h))))]),
  );
  return (m) => {
    const x = odds.get(m.at)?.get(m.cell) ?? 0;
    const shot = chased.get(m.at)?.has(m.cell) ? 1 : x / top;
    return shot * (1 - x);
  };
}

/**
 * A ghost's one trick a round, from what it knows (public marks, its own past shots and sonar). Easy
 * plays any trick. Medium and hard mine where the living will shoot but a ship is unlikely (see
 * mineScores): hard the best cell, medium one of its best few. Now and then (always, once its mines are
 * all down) they play a false splash instead: on the living seat with the most cells afloat, at the
 * sea that seat fired at most in the last volley, in the coldest cell there, to waste its shots.
 */
export function chooseGhostTrick(view: SalvoView, legal: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand {
  const mines = legal.filter(isMine);
  const splashes = legal.filter(isSplash);
  if (mines.length + splashes.length === 0) return pick(legal, opts.rng);
  if (opts.strength === 'easy') return pick([...mines, ...splashes], opts.rng);
  const seas = [...new Set([...mines, ...splashes].map((x) => x.at))];
  const odds = new Map(view.targets.filter((t) => seas.includes(t.sea)).map((t) => [t.sea, chances(t)]));
  if (splashes.length > 0 && (mines.length === 0 || opts.rng() < SPLASH_SHARE)) {
    const afloat = (sea: string) => view.targets.find((t) => t.sea === sea)?.afloat ?? 0;
    const fools = [...new Set(splashes.map((x) => x.fool))];
    const fool = fools.reduce((a, b) => (afloat(b) > afloat(a) ? b : a));
    const fired = (sea: string) => (view.lastVolley?.shells ?? []).filter((x) => x.from === fool && x.sea === sea).length;
    const options = splashes.filter((x) => x.fool === fool);
    const sea = [...new Set(options.map((x) => x.at))].reduce((a, b) => (fired(b) > fired(a) ? b : a));
    const p = odds.get(sea);
    const there = options.filter((x) => x.at === sea);
    return there.reduce((a, b) => ((p?.get(b.cell) ?? 0) < (p?.get(a.cell) ?? 0) ? b : a));
  }
  const score = mineScores(view, odds);
  const scored = mines.map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s);
  if (opts.strength === 'hard') return scored[0].m;
  const good = scored.filter((x) => x.s >= scored[0].s * MEDIUM_SPREAD).slice(0, MEDIUM_CHOICES);
  return pick(good, opts.rng).m;
}

/**
 * Picks one entry of `legal`, from the view alone: one shot of this round's salvo (it is asked once
 * per gun; `view.myOrders` says what is already in). Deployment is always at random.
 */
export function chooseSalvoMove(view: SalvoView, legal: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand {
  if (legal.length === 0) throw new Error('No legal moves.');
  const random = legal.find((c) => 'place' in c && c.place === 'random');
  if (random) return random;
  // A sunk fleet stays at the table as a ghost: its legal is tricks.
  if (legal.some((c) => 'trick' in c)) return chooseGhostTrick(view, legal, opts);
  const seas = bySea(legal, isShell);
  if (seas.size === 0) return pick(legal, opts.rng);
  const buoys = bySea(legal, isBuoy);
  const salvo = salvoOf(view);
  // Belt and braces: one buoy a round, whatever legal offers.
  if ((view.myOrders ?? []).some((o) => o.fire === 'buoy')) buoys.clear();
  let choice: Order;
  try {
    choice =
      opts.strength === 'hard'
        ? hard(view, seas, buoys, salvo, opts.rng)
        : opts.strength === 'medium'
          ? medium(view, seas, buoys, salvo, opts.rng)
          : easy(view, seas, opts.rng);
  } catch {
    return pick([...seas.values()].flat(), opts.rng);
  }
  // Hand back the very entry from `legal`; anything else falls back to a random legal one.
  if (legal.includes(choice)) return choice;
  return legal.find((c) => 'fire' in c && c.fire === choice.fire && c.at === choice.at && c.cell === choice.cell) ?? pick(legal, opts.rng);
}

/**
 * What the last volley means to me at the table, the strongest first: my own fleet just sank and I
 * stay on as a ghost; my mine backfired (sank a ship for the shooter); my trick landed (a mine that
 * came back as a hit, or my false splash being told); I sank someone's ship; someone hit mine.
 */
export function volleyMoment(view: SalvoView): 'ghost' | 'backfire' | 'trick' | 'bigCascade' | 'gotHit' | null {
  const v = view.lastVolley;
  if (!v || !view.you) return null;
  const me = view.you;
  const tricks = v.tricks ?? [];
  if (v.eliminated.includes(me) && view.phase !== 'over') return 'ghost';
  if (tricks.some((t) => t.kind === 'mine' && t.ghost === me && t.result === 'backfire')) return 'backfire';
  if (tricks.some((t) => t.ghost === me && (t.kind === 'splash' || (t.result === 'boomerang' && t.hits.length > 0)))) return 'trick';
  if (v.sunk.some((x) => x.by.includes(me) && x.sea !== me)) return 'bigCascade';
  if (whoHitMe(view).length > 0) return 'gotHit';
  return null;
}

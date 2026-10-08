import { BID_LEGAL_MAX, FLEET_CELLS, ITEMS, TELL_MAX, SHIPS, SIZE, buoyCells, cellIndex, cellName, clusterCells, hullCells, neighbours, torpedoLane, type ItemId, type SalvoCommand, type SalvoView, type TargetView } from '@cs/salvo';

export type SalvoStrength = 'easy' | 'medium' | 'hard';
/**
 * Who a resident would rather shoot, on top of the odds: `grudge` leans on whoever hit it last,
 * `finisher` on the fleet closest to sinking, `wanderer` on a different whim each round. Without a
 * style it reads the odds alone (still never piling on a sea the others just hammered).
 */
export type SalvoStyle = 'grudge' | 'finisher' | 'wanderer';
export interface SalvoStrategyOptions {
  strength: SalvoStrength;
  rng: () => number;
  style?: SalvoStyle;
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

/** Easy never drops a buoy: it picks a sea by weight and chases a hit there if any sea has one, else shoots a fresh cell at random. */
function easy(view: SalvoView, seas: Map<string, Fire[]>, rng: () => number, weight: (sea: string) => number = () => 1): Fire {
  const targets = view.targets.filter((t) => seas.has(t.sea));
  // A sea by weight (so it wanders and doesn't pile on), among those with something to chase if any.
  const bySea = (cands: { sea: string; shells: Fire[] }[]): Fire[] => {
    const live = cands.filter((c) => c.shells.length > 0);
    const total = live.reduce((n, c) => n + weight(c.sea), 0);
    let r = rng() * total;
    return (live.find((c) => (r -= weight(c.sea)) < 0) ?? live[0])?.shells ?? [];
  };
  const near = bySea(targets.map((t) => ({ sea: t.sea, shells: chases(t, seas.get(t.sea)!, false) })));
  if (near.length > 0) return pick(near, rng);
  const fresh = bySea(
    targets.map((t) => {
      const shot = new Set([...t.hits, ...t.misses]);
      return { sea: t.sea, shells: seas.get(t.sea)!.filter((x) => !shot.has(x.cell)) };
    }),
  );
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

/** How much less a sea draws when the others' whole last volley went into it (a share of it, that much of this). */
const PILE_ON = 0.9;
/** How much more the grudge sea draws, and at most how much more the weakest fleet draws for a finisher. */
const GRUDGE = 1.6;
const FINISH = 1;
/** A wanderer's whims run from 1 − WANDER to 1 + WANDER. */
const WANDER = 0.4;

/**
 * Each target sea's weight on top of the odds. Everyone eases off a sea the others hammered in the last
 * volley (three residents reading the same public hits would otherwise pour every shell into one fleet
 * and sink it in a few rounds); then the style leans. A wanderer's whim is fixed for the round (from the
 * round and the sea), so every shot of one salvo agrees.
 */
export function seaWeights(view: SalvoView, style?: SalvoStyle): (sea: string) => number {
  const me = view.you;
  const others = (view.lastVolley?.shells ?? []).filter((x) => x.from !== me && x.sea !== me);
  const grudges = new Set(style === 'grudge' ? whoHitMe(view) : []);
  return (sea) => {
    let w = others.length > 0 ? 1 - PILE_ON * (others.filter((x) => x.sea === sea).length / others.length) : 1;
    const t = view.targets.find((x) => x.sea === sea);
    if (style === 'grudge' && grudges.has(sea)) w *= GRUDGE;
    if (style === 'finisher' && t) w *= 1 + FINISH * (1 - t.afloat / FLEET_CELLS);
    if (style === 'wanderer') w *= 1 - WANDER + 2 * WANDER * whim(`${view.round} ${sea}`);
    return w;
  };
}
/** A number in [0, 1) from a string: the same string, the same whim. */
function whim(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/** Every legal shell with its chance of a hit times its sea's weight, best first (ties in legal order). */
function ranked(view: SalvoView, seas: Map<string, Fire[]>, weight: (sea: string) => number = () => 1): { s: Fire; p: number }[] {
  const odds = new Map(view.targets.filter((t) => seas.has(t.sea)).map((t) => [t.sea, chances(t)]));
  return [...seas.values()]
    .flat()
    .map((s) => ({ s, p: (odds.get(s.at)?.get(s.cell) ?? 0) * weight(s.at) }))
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
function medium(view: SalvoView, seas: Map<string, Fire[]>, buoys: Map<string, Buoy[]>, salvo: Salvo, rng: () => number, weight?: (sea: string) => number): Order {
  const shells = ranked(view, seas, weight);
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
function hard(view: SalvoView, seas: Map<string, Fire[]>, buoys: Map<string, Buoy[]>, salvo: Salvo, rng: () => number, weight?: (sea: string) => number): Order {
  const shells = ranked(view, seas, weight);
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

/** A bid or a tell: optional, never owed. */
const isOptional = (c: SalvoCommand) => 'bid' in c || 'tell' in c;
type Whisper = Extract<SalvoCommand, { trick: 'whisper' }>;
const isWhisper = (c: SalvoCommand): c is Whisper => 'trick' in c && c.trick === 'whisper';
/** A ghost with no auction open lists a whisper in about this share of its rounds. */
const LISTING_SHARE = 0.25;

/**
 * A ghost's one trick a round, from what it knows (public marks, its own past shots and sonar). Easy
 * plays any trick. Medium and hard mine where the living will shoot but a ship is unlikely (see
 * mineScores): hard the best cell, medium one of its best few. Now and then (always, once its mines are
 * all down) they play a false splash instead: on the living seat with the most cells afloat, at the
 * sea that seat fired at most in the last volley, in the coldest cell there, to waste its shots (never a
 * cell its own splash is still on show at). Every strength, in about LISTING_SHARE of the rounds it has
 * no auction open (always, when whispers are all it has), lists a whisper instead (see chooseListing).
 */
export function chooseGhostTrick(view: SalvoView, offered: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand {
  const owed = offered.filter((c) => !isOptional(c));
  const legal = owed.length > 0 ? owed : offered;
  // Now and then, with no auction of its own open, a whisper: where the living hunt (see chooseListing).
  const whispers = legal.filter(isWhisper);
  if (whispers.length > 0 && !view.myTricks?.whisper && opts.rng() < LISTING_SHARE) return chooseListing(view, whispers);
  const mines = legal.filter(isMine);
  // Never the same cell twice while its splash there is still on show: the reveal would be told twice.
  const shown = new Set((view.myTricks?.splashes ?? []).map((x) => `${x.sea} ${x.cell}`));
  const splashes = legal.filter(isSplash).filter((x) => !shown.has(`${x.at} ${x.cell}`));
  // Nothing but whispers on offer (it owes a trick): list one where it pays.
  if (mines.length + splashes.length === 0) return whispers.length > 0 ? chooseListing(view, whispers) : pick(legal, opts.rng);
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

// ── Whisper: listing, bids, burying, tells ──

type Bid = Extract<SalvoCommand, { bid: number }>;
type Tell = Extract<SalvoCommand, { tell: number }>;
type AuctionView = SalvoView['auctions'][number];
const isBid = (c: SalvoCommand): c is Bid => 'bid' in c;
const isTell = (c: SalvoCommand): c is Tell => 'tell' in c;

/** What a 3×3 on a target is worth to me: the chances of the cells I don't know yet (not shot, not under my sonar, not sure). */
function unknownValue(t: TargetView, cells: string[]): number {
  const odds = chances(t);
  const heard = new Set((t.sonar ?? []).flatMap((x) => x.cells));
  return cells.reduce((n, c) => {
    const p = odds.get(c) ?? 0;
    return n + (heard.has(c) || p >= 1 ? 0 : p);
  }, 0);
}

/**
 * A ghost's listing: on the sea the living hunted most in the last volley (ties to the fleet with fewest cells
 * afloat, the one closest to sinking), over the 3×3 hottest with what nobody knows yet. Always an entry of `whispers`.
 */
function chooseListing(view: SalvoView, whispers: Whisper[]): Whisper {
  const shells = view.lastVolley?.shells ?? [];
  const hunted = (sea: string) => shells.filter((x) => x.sea === sea).length;
  const afloat = (sea: string) => view.targets.find((t) => t.sea === sea)?.afloat ?? FLEET_CELLS;
  const seas = [...new Set(whispers.map((w) => w.at))];
  const sea = seas.reduce((a, b) => (hunted(b) > hunted(a) || (hunted(b) === hunted(a) && afloat(b) < afloat(a)) ? b : a));
  const t = view.targets.find((x) => x.sea === sea);
  const there = whispers.filter((w) => w.at === sea);
  if (!t) return there[0];
  return there.map((w) => ({ w, v: unknownValue(t, buoyCells(w.cell)) })).reduce((a, b) => (b.v > a.v ? b : a)).w;
}

/** Scrap a resident bids per ship cell it expects to learn about, by strength. */
const BID_PER_CELL: Record<SalvoStrength, number> = { easy: 1, medium: 1.5, hard: 2 };
/** At most this share of its scrap on someone else's sea, by style. */
const BID_SHARE: Record<SalvoStyle | 'none', number> = { finisher: 0.5, grudge: 0.3, wanderer: 0.5, none: 0.4 };
/** GAME_OVER (finisher) bids only when the area is worth at least this many unknown ship cells. */
const SHARP = 0.75;
/** OLD IRON (grudge) pays this share of what an area is worth; its grudge sea draws more (seaWeights). */
const GRUDGING = 0.6;
/** Sprocket (wanderer) bids high on nothing in about this share of auctions. */
const IMPULSE = 0.3;

/** My ship cells afloat (unhit) under a 3×3: what a reading there would give away. Decoys don't count (sonar can't hear them). */
function myAfloatIn(view: SalvoView, cells: string[]): number {
  const ships = view.mySea?.ships ?? [];
  return ships.reduce((n, x) => n + x.cells.filter((c) => cells.includes(c) && !x.hits.includes(c)).length, 0);
}

/**
 * How much a resident bids on an auction (0 = abstain), never above its scrap. Over its own sea it buries: when
 * the 3×3 covers ship cells of its own still afloat, it bids up to half its scrap so no rival hears them
 * (GAME_OVER the full half, OLD IRON half that, Sprocket on a whim); with nothing of its own there it lets it go.
 * Elsewhere the area is worth the ship cells it expects there that it doesn't know yet (chances, less what it has
 * heard or is sure of), weighted like its fire (seaWeights: OLD IRON leans on whoever hit it last), times its
 * strength, capped at a share of its scrap. GAME_OVER ignores a poor area; OLD IRON pays grudgingly; Sprocket
 * now and then bids high on nothing at all.
 */
export function chooseBid(view: SalvoView, auction: AuctionView, opts: SalvoStrategyOptions): number {
  const me = view.you;
  if (!me || auction.ghost === me) return 0;
  const scrap = Math.min(view.scrap[me] ?? 0, BID_LEGAL_MAX);
  if (scrap < 1) return 0;
  const style = opts.style;
  const whole = (n: number) => Math.max(0, Math.min(scrap, Math.round(n)));
  if (auction.sea === me) {
    if (myAfloatIn(view, auction.cells) === 0) return 0;
    const half = Math.max(1, Math.floor(scrap / 2));
    const k = style === 'finisher' ? 1 : style === 'grudge' ? 0.5 : style === 'wanderer' ? 0.25 + 0.75 * opts.rng() : 0.75;
    return Math.min(half, Math.max(1, whole(half * k)));
  }
  const t = view.targets.find((x) => x.sea === auction.sea);
  if (!t || t.out) return 0;
  const share = whole(scrap * BID_SHARE[style ?? 'none']);
  if (style === 'wanderer' && opts.rng() < IMPULSE) return Math.max(1, share);
  const value = unknownValue(t, auction.cells) * seaWeights(view, style)(auction.sea);
  if (style === 'finisher' && value < SHARP) return 0;
  return Math.min(share, whole(value * BID_PER_CELL[opts.strength] * (style === 'grudge' ? GRUDGING : 1)));
}

/** GAME_OVER lies in about this share of its auctions; Sprocket in this one. */
const FINISHER_LIES = 0.7;
const WANDERER_LIES = 0.5;

/**
 * The number a ghost tells the winner of its open auction (null with none open). GAME_OVER often lies, plausibly:
 * one to three off the truth, within 0–TELL_MAX. OLD IRON never lies. Sprocket lies badly half the time: 0 or 9
 * (the truth by accident, now and then). With no style, the truth.
 */
export function chooseTell(view: SalvoView, opts: SalvoStrategyOptions): number | null {
  const w = view.myTricks?.whisper;
  if (!w) return null;
  const truth = w.truth;
  if (opts.style === 'finisher' && opts.rng() < FINISHER_LIES) {
    const off = 1 + Math.floor(opts.rng() * 3);
    const up = opts.rng() < 0.5;
    const n = up ? truth + off : truth - off;
    return n >= 0 && n <= TELL_MAX ? n : up ? truth - off : truth + off;
  }
  if (opts.style === 'wanderer' && opts.rng() < WANDERER_LIES) return opts.rng() < 0.5 ? 0 : TELL_MAX;
  return truth;
}

/**
 * The optional decisions `legal` offers me, one per auction (keyed by its ghost and the round, as an auction lives
 * within one round): a bid on each open auction, or the tell on my own.
 */
export function whisperChoices(view: SalvoView, legal: SalvoCommand[]): { key: string; ghost: string }[] {
  const ghosts = new Set<string>();
  for (const c of legal) {
    if (isBid(c)) ghosts.add(c.ghost);
    else if (isTell(c) && view.you) ghosts.add(view.you);
  }
  return [...ghosts].map((ghost) => ({ key: `${ghost}@${view.round}`, ghost }));
}

/**
 * One decision on `ghost`'s auction, as the very entry of `legal`: my tell when it is mine (see chooseTell), else
 * my bid (see chooseBid; the highest legal amount at or below it, `{bid: 0}` to abstain). Null when legal has none.
 */
export function chooseWhisper(view: SalvoView, legal: SalvoCommand[], ghost: string, opts: SalvoStrategyOptions): SalvoCommand | null {
  if (ghost === view.you) {
    const n = chooseTell(view, opts);
    return legal.filter(isTell).find((c) => c.tell === n) ?? null;
  }
  const bids = legal.filter(isBid).filter((c) => c.ghost === ghost);
  const auction = view.auctions.find((a) => a.ghost === ghost);
  if (bids.length === 0 || !auction) return null;
  const n = chooseBid(view, auction, opts);
  const within = bids.filter((c) => c.bid <= n);
  return within.length > 0 ? within.reduce((a, b) => (b.bid > a.bid ? b : a)) : null;
}

/** A whisper moment at the table, the strongest first: I bought a reading on my own sea, won one, listed one. */
export type WhisperMoment = 'buried' | 'wonWhisper' | 'whisper';

/**
 * What changed for me in the whispers since `prev` (null: the first look, nothing to tell): a whisper I won
 * (`buried` when it was over my own sea), or my own auction newly up (not one already open in the same round).
 */
export function whisperMoment(prev: SalvoView | null, view: SalvoView): WhisperMoment | null {
  if (!prev || !view.you) return null;
  const won = (view.whispers ?? []).slice((prev.whispers ?? []).length);
  if (won.some((w) => w.sea === view.you)) return 'buried';
  if (won.length > 0) return 'wonWhisper';
  const mine = (v: SalvoView) => (v.auctions ?? []).some((a) => a.ghost === view.you);
  if (mine(view) && !(mine(prev) && prev.round === view.round)) return 'whisper';
  return null;
}

/** At the end of the match: was a whisper of mine sold, and the number I told not the truth? */
export function liedMoment(view: SalvoView): boolean {
  return (view.truths ?? []).some((x) => x.ghost === view.you && x.state === 'sold' && x.said !== x.truth);
}

// ── The Arsenal: crates and items ──

type CrateCmd = Extract<SalvoCommand, { crate: unknown }>;
type ClusterCmd = Extract<SalvoCommand, { fire: 'cluster' }>;
type TorpedoCmd = Extract<SalvoCommand, { fire: 'torpedo' }>;
type RepairCmd = Extract<SalvoCommand, { use: 'repair' }>;
type DecoyCmd = Extract<SalvoCommand, { use: 'decoy' }>;
const isCrate = (c: SalvoCommand): c is CrateCmd => 'crate' in c;
const isCluster = (c: SalvoCommand): c is ClusterCmd => 'fire' in c && c.fire === 'cluster';
const isTorpedo = (c: SalvoCommand): c is TorpedoCmd => 'fire' in c && c.fire === 'torpedo';
const isRepair = (c: SalvoCommand): c is RepairCmd => 'use' in c && c.use === 'repair';
const isDecoy = (c: SalvoCommand): c is DecoyCmd => 'use' in c && c.use === 'decoy';

/** Each style's crate preference, best first: GAME_OVER wants firepower, OLD IRON wants to stay afloat. Sprocket shuffles. */
const PREFERENCE: Record<SalvoStyle, readonly ItemId[] | null> = {
  finisher: ['cluster', 'torpedo', 'decoy', 'repair'],
  grudge: ['repair', 'decoy', 'cluster', 'torpedo'],
  wanderer: null,
};
const NO_STYLE: readonly ItemId[] = ['cluster', 'torpedo', 'repair', 'decoy'];
/** A decoy is laid in rounds 1 to this; held after round DECOY_STALE it is dead weight. */
const DECOY_UNTIL = 4;
const DECOY_STALE = 6;
/** A cluster goes up only when its plus is worth at least this many of the best single shell. */
const CLUSTER_EDGE = 1.5;

/** Ships of mine still afloat that have taken a hit. */
const damaged = (view: SalvoView) => (view.mySea?.ships ?? []).filter((x) => x.cells.length > 0 && x.hits.length > 0 && x.hits.length < x.cells.length);

/** An item with no use now: a repair with no hit on a ship still afloat; a decoy after round DECOY_STALE. */
function idle(view: SalvoView, item: ItemId): boolean {
  if (item === 'repair') return damaged(view).length === 0;
  if (item === 'decoy') return view.round > DECOY_STALE;
  return false;
}

/**
 * Opens the crate in character: the best card by the style's preference (Sprocket's is shuffled each time), an
 * item with no use now ranked behind every useful one. With two held, it swaps out the least useful held item
 * for the best card, or passes when every held item outranks the cards. Always an entry of `legal`.
 */
export function chooseCrate(view: SalvoView, legal: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand {
  const offers = legal.filter(isCrate);
  if (offers.length === 0) return pick(legal, opts.rng);
  const pass = offers.find((c) => c.crate === 'pass');
  const cards = [...new Set(offers.flatMap((c) => (c.crate === 'pass' ? [] : [c.crate])))];
  if (cards.length === 0) return pass ?? offers[0];
  const order = (opts.style && PREFERENCE[opts.style]) ?? (opts.style === 'wanderer' ? shuffled(ITEMS, opts.rng) : NO_STYLE);
  const rank = (item: ItemId) => (idle(view, item) ? ITEMS.length : 0) + order.indexOf(item);
  const best = cards.reduce((a, b) => (rank(b) < rank(a) ? b : a));
  const drops = [...new Set(offers.flatMap((c) => (c.crate !== 'pass' && c.drop ? [c.drop] : [])))];
  if (drops.length === 0) return offers.find((c) => c.crate === best && !('drop' in c && c.drop)) ?? pass ?? offers[0];
  const worst = drops.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  if (rank(best) < rank(worst)) return offers.find((c) => c.crate === best && 'drop' in c && c.drop === worst)!;
  return pass ?? offers[0];
}
function shuffled<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Shells that would land under this round's queued cluster are wasted: leave them out. */
function notUnderCluster(view: SalvoView): (c: SalvoCommand) => boolean {
  const under = new Set((view.myOrders ?? []).filter((o) => o.fire === 'cluster').flatMap((o) => clusterCells(o.cell).map((c) => `${o.at} ${c}`)));
  return (c) => !(isShell(c) && under.has(`${c.at} ${c.cell}`));
}

const manhattan = (a: string, b: string) => {
  const i = cellIndex(a)!;
  const j = cellIndex(b)!;
  return Math.abs((i % SIZE) - (j % SIZE)) + Math.abs(Math.floor(i / SIZE) - Math.floor(j / SIZE));
};

/**
 * The round's one item, as the salvo's first order (null for none): repair the hit cell of a ship one hit from
 * sinking; a cluster centred where its plus adds up the most chance, when that beats the best single shell
 * CLUSTER_EDGE times over; a decoy in rounds 1–DECOY_UNTIL as far from my ships as it lies; a torpedo, when
 * nothing is being chased, down the lane with the most chance on any living sea.
 */
function chooseItem(view: SalvoView, legal: SalvoCommand[], seas: Map<string, Fire[]>, weight: (sea: string) => number, rng: () => number): SalvoCommand | null {
  if ((view.myOrders ?? []).length > 0 || !view.you) return null;
  const repairs = legal.filter(isRepair);
  const clusters = legal.filter(isCluster);
  const decoys = legal.filter(isDecoy);
  const torpedoes = legal.filter(isTorpedo);
  if (repairs.length + clusters.length + decoys.length + torpedoes.length === 0) return null;
  for (const ship of damaged(view).filter((x) => x.cells.length - x.hits.length === 1)) {
    const weld = repairs.find((r) => ship.hits.includes(r.cell));
    if (weld) return weld;
  }
  const odds = new Map(view.targets.filter((t) => !t.out).map((t) => [t.sea, chances(t)]));
  const worth = (sea: string, cells: string[]) => cells.reduce((n, c) => n + (odds.get(sea)?.get(c) ?? 0), 0) * weight(sea);
  if (clusters.length > 0) {
    const single = Math.max(0, ...ranked(view, seas, weight).map((x) => x.p));
    const scored = clusters.map((c) => ({ c, v: worth(c.at, clusterCells(c.cell)) }));
    const top = scored.reduce((a, b) => (b.v > a.v ? b : a));
    if (top.v > 0 && top.v >= CLUSTER_EDGE * single) return top.c;
  }
  if (decoys.length > 0 && view.round <= DECOY_UNTIL && view.mySea) {
    const mine = view.mySea.ships.flatMap((x) => x.cells);
    const far = (d: DecoyCmd) => Math.min(...hullCells(d.at, 2, d.facing)!.flatMap((c) => mine.map((m) => manhattan(c, m))));
    const scored = decoys.map((d) => ({ d, v: far(d) }));
    const top = Math.max(...scored.map((x) => x.v));
    return pick(scored.filter((x) => x.v === top), rng).d;
  }
  if (torpedoes.length > 0 && !chasing(view, seas)) {
    const scored = torpedoes.map((t) => ({ t, v: worth(t.at, torpedoLane(view.you!, t.lane) ?? []) }));
    const top = scored.reduce((a, b) => (b.v > a.v ? b : a));
    if (top.v > 0) return top.t;
  }
  return null;
}

/**
 * Hard's doubt: two hits side by side on a fleet still afloat, both ends of their line misses (or sunk, or off
 * the sea), and still no sinking. No submarine takes two hits and floats: one of them is a decoy, a false splash, or
 * two ships side by side. Before more shells, a buoy over the pair (one I haven't heard from yet) counts what is real.
 */
function doubtBuoy(view: SalvoView, buoys: Map<string, Buoy[]>): Buoy | null {
  for (const t of view.targets) {
    const drops = buoys.get(t.sea);
    if (!drops || drops.length === 0) continue;
    const open = openHits(t);
    // An end is closed by a miss, a sunk ship, or the edge of the sea; a hit there would make the pair part of a longer line.
    const walls = new Set([...t.misses, ...t.sunk.flatMap((x) => x.cells)]);
    const closed = (i: number | null) => i === null || walls.has(cellName(i));
    for (const a of open) {
      for (const b of open) {
        const ia = cellIndex(a)!;
        const ib = cellIndex(b)!;
        const across = ib - ia === 1 && Math.floor(ia / SIZE) === Math.floor(ib / SIZE);
        const down = ib - ia === SIZE;
        if (!across && !down) continue;
        const step = ib - ia;
        const before = across ? (ia % SIZE === 0 ? null : ia - step) : ia - step >= 0 ? ia - step : null;
        const after = across ? (ib % SIZE === SIZE - 1 ? null : ib + step) : ib + step < SIZE * SIZE ? ib + step : null;
        if (!closed(before) || !closed(after)) continue;
        if ((t.sonar ?? []).some((x) => x.cells.includes(a) && x.cells.includes(b))) continue;
        const over = drops.filter((d) => {
          const cells = buoyCells(d.cell);
          return cells.includes(a) && cells.includes(b);
        });
        if (over.length > 0) return over.find((d) => d.cell === a || d.cell === b) ?? over[0];
      }
    }
  }
  return null;
}

/**
 * Picks one entry of `legal`, from the view alone: one shot of this round's salvo (it is asked once
 * per gun; `view.myOrders` says what is already in). Deployment is always at random.
 */
export function chooseSalvoMove(view: SalvoView, offered: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand {
  if (offered.length === 0) throw new Error('No legal moves.');
  // Bids and tells are optional (never owed): no fallback below may land on one by chance.
  const owed = offered.filter((c) => !isOptional(c));
  const legal = owed.length > 0 ? owed : offered;
  const random = legal.find((c) => 'place' in c && c.place === 'random');
  if (random) return random;
  // A sunk fleet stays at the table as a ghost: its legal is tricks.
  if (legal.some((c) => 'trick' in c)) return chooseGhostTrick(view, legal, opts);
  // An open crate is owed before the round can close: pick (or pass) first, so the item can fire this round.
  if (legal.some(isCrate)) return chooseCrate(view, legal, opts);
  const seas = bySea(legal.filter(notUnderCluster(view)), isShell);
  if (seas.size === 0) {
    const shells = bySea(legal, isShell);
    if (shells.size === 0) return pick(legal, opts.rng);
    shells.forEach((v, k) => seas.set(k, v));
  }
  const buoys = bySea(legal, isBuoy);
  const salvo = salvoOf(view);
  // Belt and braces: one buoy a round, whatever legal offers.
  if ((view.myOrders ?? []).some((o) => o.fire === 'buoy')) buoys.clear();
  const weight = seaWeights(view, opts.style);
  let choice: Order;
  try {
    const item = chooseItem(view, legal, seas, weight, opts.rng);
    if (item) return item;
    if (opts.strength === 'hard') {
      const doubt = doubtBuoy(view, buoys);
      if (doubt) return doubt;
    }
    choice =
      opts.strength === 'hard'
        ? hard(view, seas, buoys, salvo, opts.rng, weight)
        : opts.strength === 'medium'
          ? medium(view, seas, buoys, salvo, opts.rng, weight)
          : easy(view, seas, opts.rng, weight);
  } catch {
    return pick([...seas.values()].flat(), opts.rng);
  }
  // Hand back the very entry from `legal`; anything else falls back to a random legal one.
  if (legal.includes(choice)) return choice;
  return legal.find((c) => 'fire' in c && c.fire === choice.fire && c.at === choice.at && c.cell === choice.cell) ?? pick(legal, opts.rng);
}

/** A moment at the table from the last volley, the strongest first (see volleyMoment). */
export type VolleyMoment = 'ghost' | 'backfire' | 'trick' | 'crate' | 'fooled' | 'bigCascade' | 'gotHit';

/**
 * What the last volley means to me at the table, the strongest first: my own fleet just sank and I
 * stay on as a ghost; my mine backfired (sank a ship for the shooter); my trick landed (a mine that
 * came back as a hit, or my false splash being told); I sank a ship and pull a crate from the wreck
 * (the match goes on and I'm still afloat); my decoy was revealed (someone wasted shots on driftwood);
 * I sank someone's ship (in the volley that ends the match: no crate then); someone hit mine.
 * A hit on my decoy while it is still live plays like any hit: gloating then would give it away.
 */
export function volleyMoment(view: SalvoView): VolleyMoment | null {
  const v = view.lastVolley;
  if (!v || !view.you) return null;
  const me = view.you;
  const tricks = v.tricks ?? [];
  if (v.eliminated.includes(me) && view.phase !== 'over') return 'ghost';
  if (tricks.some((t) => t.kind === 'mine' && t.ghost === me && t.result === 'backfire')) return 'backfire';
  if (tricks.some((t) => t.ghost === me && (t.kind === 'splash' || (t.result === 'boomerang' && t.hits.length > 0)))) return 'trick';
  const sank = v.sunk.some((x) => x.by.includes(me) && x.sea !== me);
  if (sank && view.phase !== 'over' && !view.eliminated.includes(me)) return 'crate';
  if (decoyRevealedIn(view)) return 'fooled';
  if (sank) return 'bigCascade';
  if (whoHitMe(view).length > 0) return 'gotHit';
  return null;
}

/** Was my decoy revealed in the last volley? Public: the volley's items tell it, on my sea. */
function decoyRevealedIn(view: SalvoView): boolean {
  return (view.lastVolley!.items ?? []).some((x) => x.item === 'decoy' && x.sea === view.you);
}

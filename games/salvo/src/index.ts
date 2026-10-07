import { GameRuleError, createRng, type GameModule, type Outcome, type SeatId, type TurnRules } from '@cs/game-api';
import { renderAscii } from './ascii';
import { MINE_LIMIT, SIZE, buoyCells, cellIndex, cellName, hullCells, isBuoyCentre, liftedRows, neighbours, rowOf, type Facing } from './board';

export { FOG_FROM, MINE_LIMIT, SIZE, buoyCells, cellIndex, cellName, hullCells, isBuoyCentre, liftedRows, neighbours } from './board';
export type { Facing } from './board';
export { renderAscii } from './ascii';

export const SEATS = ['north', 'east', 'south', 'west'] as const;
export const TURN_SECONDS = 45;
export const ROUND_CAP = 30;
export type ShipId = 'cruiser' | 'destroyer' | 'frigate' | 'submarine';
export const SHIPS: readonly { id: ShipId; length: number }[] = [
  { id: 'cruiser', length: 4 },
  { id: 'destroyer', length: 3 },
  { id: 'frigate', length: 3 },
  { id: 'submarine', length: 2 },
];
/** Ship cells in a whole fleet (12). */
export const FLEET_CELLS = SHIPS.reduce((n, x) => n + x.length, 0);

export type Phase = 'deploy' | 'fire' | 'over';
export type ShotResult = 'miss' | 'hit' | 'sunk';

/** A placed ship; `hits` ⊆ `cells`. */
export interface Ship {
  id: ShipId;
  cells: string[];
  hits: string[];
}
/** One committed shot. */
export interface Shell {
  from: SeatId;
  sea: SeatId;
  cell: string;
}
/** A sonar buoy dropped this round: public where it fell, private what it heard. */
export type Buoy = Shell;
/** A seat's secret commit for the round: a shell, or a sonar buoy instead of one. */
export interface Order extends Shell {
  kind: 'shell' | 'buoy';
}
/** A ghost's mine: hidden from everyone but its ghost until a shell sets it off. */
export interface Mine {
  ghost: SeatId;
  sea: SeatId;
  cell: string;
  round: number;
}
/** A false splash: one living seat (the fool) sees a fake hit on `sea` at `cell`, dressed as a shell from `as`. */
export interface Splash {
  ghost: SeatId;
  fool: SeatId;
  sea: SeatId;
  cell: string;
  /** The volley it first shows in. */
  round: number;
  as: SeatId;
}
/** A ghost's commit for the round. */
export interface PendingTrick {
  kind: 'mine' | 'splash';
  sea: SeatId;
  cell: string;
  fool?: SeatId;
}
/** What a shell did at its own cell. `ship` is named only when the shell sank it. */
export interface ShellResult extends Shell {
  result: ShotResult;
  ship: ShipId | null;
  blast: boolean;
}
/** Time on Target: a cell two or more seats hit at once, and the 3×3 it took with it. `hits` are the new hits. */
export interface Blast {
  sea: SeatId;
  cell: string;
  by: SeatId[];
  cells: string[];
  hits: string[];
}
/** A trick revealed in a volley (public once it is). A boomerang's sinkings are in the volley's `sunk`, credited to the ghost. */
export type Trick =
  | { kind: 'mine'; ghost: SeatId; sea: SeatId; cell: string; shooters: SeatId[]; result: 'boomerang'; hits: { sea: SeatId; cell: string }[] }
  | { kind: 'mine'; ghost: SeatId; sea: SeatId; cell: string; shooters: SeatId[]; result: 'backfire'; ship: ShipId }
  | { kind: 'splash'; ghost: SeatId; fool: SeatId; sea: SeatId; cell: string };
export interface Volley {
  round: number;
  shells: ShellResult[];
  /** Sonar buoys dropped this round, in seat order: where, never what they heard. */
  buoys: Buoy[];
  blasts: Blast[];
  sunk: { sea: SeatId; ship: ShipId; by: SeatId[] }[];
  /** Seats whose last ship went down in this volley, in seat order (a tiebreak winner included). */
  eliminated: SeatId[];
  /** Tricks revealed in this volley: mines that went off, false splashes withdrawn. [] when none. */
  tricks: Trick[];
}

export interface SalvoState {
  seats: SeatId[];
  seed: number;
  /** How many times the rng has been used (random deployment); advances with each use. */
  draws: number;
  phase: Phase;
  /** 0 during deployment, then 1, 2, … */
  round: number;
  /** Placed ships, in SHIPS order; ships not here are still in port. */
  fleets: Record<SeatId, Ship[]>;
  /** Every cell shot at each sea, oldest first, with its result and who shot it (public once resolved). */
  shots: Record<SeatId, Record<string, { result: 'miss' | 'hit'; by: SeatId[] }>>;
  /** This round's secret commits, one per shot, in the order sent. Each seat sees only its own (`myOrders`). */
  pending: Record<SeatId, Order[]>;
  /** Each seat's sonar buoys, oldest first. Each one is shown only to the seat that dropped it. */
  sonar: Record<SeatId, { sea: SeatId; cell: string; round: number }[]>;
  /** Seats that owe nothing this round (fleet down, or every shot committed), in seat order. Public. */
  ready: SeatId[];
  /** Live mines, oldest first. Each is seen by its ghost alone. */
  mines: Mine[];
  /** False splashes on show (one volley each). Each is seen by its ghost and its fool alone. */
  splashes: Splash[];
  /** Ghosts that missed three rounds: released, placement unchanged. */
  ghostsGone: SeatId[];
  /** Each ghost's trick for this round, secret until the volley. */
  pendingTrick: Record<SeatId, PendingTrick | null>;
  lastVolley: Volley | null;
  scrap: Record<SeatId, number>;
  hitsLanded: Record<SeatId, number>;
  /** In order; reason 'sunk' | 'resign' | 'timeout' | … A tiebreak winner is taken back out of this list. */
  eliminated: { seat: SeatId; round: number; reason: string }[];
  /** Unused by the module (the engine counts); kept at 0. */
  timeouts: Record<SeatId, number>;
  winner: SeatId | null;
  /** 'last-afloat' | 'tiebreak' | 'round-cap' | a forfeit reason. */
  endReason: string | null;
}

export type SalvoCommand =
  | { place: ShipId; at: string; facing: Facing }
  | { place: 'random' }
  | { fire: 'shell'; at: SeatId; cell: string }
  | { fire: 'buoy'; at: SeatId; cell: string }
  | { trick: 'mine'; at: SeatId; cell: string }
  | { trick: 'splash'; fool: SeatId; at: SeatId; cell: string };

export interface TargetView {
  sea: SeatId;
  /** Your own shots at this sea, in the order the cells were first shot by anyone; 'sunk' once the ship there has gone down. */
  mine: { cell: string; result: ShotResult }[];
  /** Every hit cell anyone landed (public), in board order. */
  hits: string[];
  /** Every miss anyone landed (public), in board order. */
  misses: string[];
  /** Sunk ships with their cells (public). */
  sunk: { ship: ShipId; cells: string[] }[];
  /** Lifted rows and how many ship cells in each are still afloat (unhit): a count, never where (public). */
  lifted: { row: number; afloat: number }[];
  /** Your sonar buoys on this sea, oldest first: the 3×3 each listens to and how many ship cells in it are afloat now. Yours alone. */
  sonar: { cell: string; round: number; cells: string[]; afloat: number }[];
  /** Ship cells still unhit (public: 12 − hits). */
  afloat: number;
  /** This fleet is out (sunk, or its player forfeited): still on view, no longer a target. */
  out: boolean;
  /** Every ship, once the match is over. */
  revealed?: Ship[];
  /** Every live mine on this sea, once the match is over. */
  mines?: { ghost: SeatId; cell: string }[];
}
export interface SalvoView {
  you: SeatId | null;
  seats: SeatId[];
  round: number;
  phase: Phase;
  ready: SeatId[];
  /** Sunk fleets still at the table (public). */
  ghosts: SeatId[];
  /** How many shots each living seat fires this round: one per ship still afloat (public: sinkings are). */
  guns: Record<SeatId, number>;
  /** The shots you have sent this round, in order (yours alone; [] for spectators and outside a round). */
  myOrders: { fire: 'shell' | 'buoy'; at: SeatId; cell: string }[];
  /** A ghost's own mischief: its live mines, its live splashes, this round's commit. Null for everyone else. */
  myTricks: {
    mines: { sea: SeatId; cell: string; round: number }[];
    splashes: { fool: SeatId; sea: SeatId; cell: string; round: number }[];
    pending: { trick: 'mine' | 'splash'; at: SeatId; cell: string; fool?: SeatId } | null;
  } | null;
  /** Your fleet: every ship, its cells and hits; ships still in port are listed with `cells: []`. Null for spectators. */
  mySea: { ships: Ship[]; port: ShipId[]; shots: Record<string, 'miss' | 'hit'> } | null;
  /** One per sea that is not yours (spectators: every sea), fleets that are out included (`out`). */
  targets: TargetView[];
  lastVolley: Volley | null;
  scrap: Record<SeatId, number>;
  /** In elimination order. */
  eliminated: SeatId[];
  /** The rows public this round (the same for every sea). */
  liftedRows: number[];
  winner: SeatId | null;
  endReason: string | null;
  ascii: string;
}

const clone = (s: SalvoState): SalvoState => structuredClone(s);
/** A plain-JSON copy for views (cheaper than structuredClone for these small records). */
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isEliminated = (s: SalvoState, seat: SeatId) => s.eliminated.some((x) => x.seat === seat);
const living = (s: SalvoState) => s.seats.filter((x) => !isEliminated(s, x));
const inPort = (s: SalvoState, seat: SeatId) => SHIPS.filter((x) => !s.fleets[seat].some((p) => p.id === x.id));
const isSunk = (ship: Ship) => ship.cells.length > 0 && ship.hits.length === ship.cells.length;
const shipAt = (s: SalvoState, sea: SeatId, cell: string) => s.fleets[sea].find((x) => x.cells.includes(cell));
const unhitCells = (s: SalvoState, seat: SeatId) => s.fleets[seat].reduce((n, x) => n + x.cells.length - x.hits.length, 0);
const bySeatOrder = (s: SalvoState, seats: Iterable<SeatId>) => {
  const set = new Set(seats);
  return s.seats.filter((x) => set.has(x));
};
const isShipId = (x: unknown): x is ShipId => SHIPS.some((ship) => ship.id === x);

/** Shots a seat fires this round: one per ship still afloat. */
const gunsOf = (s: SalvoState, seat: SeatId) => s.fleets[seat].filter((x) => !isSunk(x)).length;

/** Sunk fleets still at the table: ghosts (none once the match is over). */
const ghosts = (s: SalvoState): SeatId[] =>
  s.phase === 'over' ? [] : bySeatOrder(s, s.eliminated.filter((x) => x.reason === 'sunk' && !s.ghostsGone.includes(x.seat)).map((x) => x.seat));
const isGhost = (s: SalvoState, seat: SeatId) => ghosts(s).includes(seat);
const minesOf = (s: SalvoState, ghost: SeatId) => s.mines.filter((x) => x.ghost === ghost);

/**
 * A ghost's tricks: a mine on any unshot cell of a living sea (not on one of its own; another ghost's
 * mine is no bar, or refusing would tell it where that mine is), while it has fewer than MINE_LIMIT;
 * then, with three fleets afloat, a false splash: a living fool, another living sea, an unshot cell.
 * Ship cells are on offer like any other: nothing here may depend on where a ship is.
 */
function trickLegal(s: SalvoState, ghost: SeatId): SalvoCommand[] {
  const out: SalvoCommand[] = [];
  const alive = living(s);
  const own = minesOf(s, ghost);
  const unshot = (sea: SeatId) => Array.from({ length: SIZE * SIZE }, (_, i) => cellName(i)).filter((c) => !s.shots[sea][c]);
  if (own.length < MINE_LIMIT) {
    for (const sea of alive) for (const cell of unshot(sea)) if (!own.some((m) => m.sea === sea && m.cell === cell)) out.push({ trick: 'mine', at: sea, cell });
  }
  if (alive.length >= 3) {
    for (const fool of alive) for (const sea of alive) if (sea !== fool) for (const cell of unshot(sea)) out.push({ trick: 'splash', fool, at: sea, cell });
  }
  return out;
}

function toMove(s: SalvoState): SeatId[] {
  if (s.phase === 'deploy') return living(s).filter((x) => inPort(s, x).length > 0);
  if (s.phase === 'fire') {
    const owing = [...living(s), ...ghosts(s).filter((x) => trickLegal(s, x).length > 0)];
    return bySeatOrder(s, owing.filter((x) => !s.ready.includes(x)));
  }
  return [];
}

// ── Deployment ──

/** Does this hull fit beside what the seat has placed? (Ships may touch, never overlap.) */
const fits = (s: SalvoState, seat: SeatId, cells: string[]) => !cells.some((c) => shipAt(s, seat, c));

/** Every placement of a ship that fits, cells a1..h8, east before north. */
function placements(s: SalvoState, seat: SeatId, ship: { id: ShipId; length: number }) {
  const out: { place: ShipId; at: string; facing: Facing }[] = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (const facing of ['east', 'north'] as const) {
      const cells = hullCells(cellName(i), ship.length, facing);
      if (cells && fits(s, seat, cells)) out.push({ place: ship.id, at: cellName(i), facing });
    }
  }
  return out;
}

/** Put a ship in the fleet, keep the fleet in SHIPS order, and open round 1 once every fleet is down. Mutates `s`. */
function launch(s: SalvoState, seat: SeatId, id: ShipId, cells: string[]): void {
  s.fleets[seat].push({ id, cells, hits: [] });
  s.fleets[seat].sort((a, b) => SHIPS.findIndex((x) => x.id === a.id) - SHIPS.findIndex((x) => x.id === b.id));
  if (inPort(s, seat).length === 0 && !s.ready.includes(seat)) s.ready = bySeatOrder(s, [...s.ready, seat]);
}

/** Round 1 begins when the last living fleet is down. Mutates `s`. */
function maybeOpenFire(s: SalvoState): void {
  if (s.phase !== 'deploy' || living(s).some((x) => inPort(s, x).length > 0)) return;
  s.phase = 'fire';
  s.round = 1;
  s.ready = [];
}

/**
 * Every ship still in port, at random. Each ship is picked uniformly from the placements that fit,
 * so it never retries and never loops; one rng per use, seeded from the seed and the draw count.
 */
function placeRandom(s: SalvoState, seat: SeatId): void {
  const rng = createRng((s.seed + s.draws * 7919) >>> 0);
  s.draws += 1;
  for (const ship of inPort(s, seat)) {
    const options = placements(s, seat, ship);
    if (options.length === 0) throw new GameRuleError('NO_ROOM', `There is no room left for the ${ship.id}.`);
    const pick = rng.pick(options);
    launch(s, seat, ship.id, hullCells(pick.at, ship.length, pick.facing)!);
  }
}

function applyPlace(s: SalvoState, seat: SeatId, command: Record<string, unknown>): void {
  const { place, at, facing } = command;
  if (typeof place !== 'string') {
    throw new GameRuleError('BAD_COMMAND', 'Send {"place":"cruiser","at":"c3","facing":"east"} or {"place":"random"}.');
  }
  if (place === 'random') {
    placeRandom(s, seat);
    return;
  }
  if (!isShipId(place)) throw new GameRuleError('BAD_SHIP', `There is no ship "${place}"; the fleet is ${SHIPS.map((x) => x.id).join(', ')}.`);
  const ship = SHIPS.find((x) => x.id === place)!;
  if (!inPort(s, seat).includes(ship)) throw new GameRuleError('BAD_SHIP', `The ${place} is already deployed.`);
  if (typeof at !== 'string') throw new GameRuleError('BAD_COMMAND', 'Send {"place":"cruiser","at":"c3","facing":"east"}.');
  if (cellIndex(at) === null) throw new GameRuleError('BAD_CELL', `There is no cell "${at}" on an 8×8 sea (a1 to h8).`);
  if (facing !== 'east' && facing !== 'north') throw new GameRuleError('BAD_FACING', 'A ship faces "east" or "north" from its first cell.');
  const cells = hullCells(at, ship.length, facing);
  if (!cells) throw new GameRuleError('OFF_SEA', `The ${place} would leave the sea.`);
  if (!fits(s, seat, cells)) throw new GameRuleError('OVERLAP', `The ${place} would overlap another ship.`);
  launch(s, seat, ship.id, cells);
}

// ── Fire ──

/** Cells this seat has already shot at a sea (directly or in a blast it was part of). */
const firedAt = (s: SalvoState, seat: SeatId, sea: SeatId, cell: string) => s.shots[sea][cell]?.by.includes(seat) ?? false;

/** Has this seat already dropped a buoy at this centre of this sea? */
const buoyedAt = (s: SalvoState, seat: SeatId, sea: SeatId, cell: string) => s.sonar[seat].some((x) => x.sea === sea && x.cell === cell);

function applyTrick(s: SalvoState, seat: SeatId, command: Record<string, unknown>): void {
  if (!isGhost(s, seat)) throw new GameRuleError('NOT_A_GHOST', 'Only a sunk fleet plays tricks; you fire: {"fire":"shell","at":"east","cell":"e5"}.');
  const { trick, at, cell, fool } = command;
  if ((trick !== 'mine' && trick !== 'splash') || typeof at !== 'string' || typeof cell !== 'string') {
    throw new GameRuleError('BAD_COMMAND', 'Send {"trick":"mine","at":"east","cell":"e5"} or {"trick":"splash","fool":"south","at":"east","cell":"e5"}.');
  }
  const alive = living(s);
  if (!alive.includes(at)) throw new GameRuleError('BAD_TARGET', `Play your trick on a living sea: ${alive.join(', ')}.`);
  const i = cellIndex(cell);
  if (i === null) throw new GameRuleError('BAD_CELL', `There is no cell "${cell}" on an 8×8 sea (a1 to h8).`);
  const name = cellName(i);
  if (s.shots[at][name]) throw new GameRuleError('ALREADY_SHOT', `A shell has already landed on ${at}'s ${name}.`);
  if (trick === 'mine') {
    if (minesOf(s, seat).length >= MINE_LIMIT) throw new GameRuleError('MINE_LIMIT', `You have ${MINE_LIMIT} live mines; wait for one to go off, or play a false splash.`);
    if (minesOf(s, seat).some((m) => m.sea === at && m.cell === name)) throw new GameRuleError('YOUR_MINE', `Your mine is already on ${at}'s ${name}.`);
    s.pendingTrick[seat] = { kind: 'mine', sea: at, cell: name };
  } else {
    if (alive.length < 3) throw new GameRuleError('TOO_FEW', 'A false splash needs three fleets afloat; plant a mine.');
    if (typeof fool !== 'string' || !alive.includes(fool) || fool === at) {
      throw new GameRuleError('BAD_FOOL', `Fool a living player who fires at ${at}: ${alive.filter((x) => x !== at).join(', ')}.`);
    }
    s.pendingTrick[seat] = { kind: 'splash', sea: at, cell: name, fool };
  }
  s.ready = bySeatOrder(s, [...s.ready, seat]);
  if (toMove(s).length === 0) resolve(s);
}

function applyFire(s: SalvoState, seat: SeatId, command: Record<string, unknown>): void {
  const { fire, at, cell } = command;
  if ((fire !== 'shell' && fire !== 'buoy') || typeof at !== 'string' || typeof cell !== 'string') {
    throw new GameRuleError('BAD_COMMAND', 'Send {"fire":"shell","at":"east","cell":"e5"} or {"fire":"buoy","at":"east","cell":"e5"}.');
  }
  if (at === seat || !s.seats.includes(at) || isEliminated(s, at)) {
    throw new GameRuleError('BAD_TARGET', `Fire at a living opponent's sea: ${living(s).filter((x) => x !== seat).join(', ')}.`);
  }
  const i = cellIndex(cell);
  if (i === null) throw new GameRuleError('BAD_CELL', `There is no cell "${cell}" on an 8×8 sea (a1 to h8).`);
  const name = cellName(i);
  if (fire === 'buoy') {
    if (!isBuoyCentre(name)) throw new GameRuleError('BAD_BUOY', `A buoy's 3×3 must lie on the sea: drop it on b2 to g7, not ${name}.`);
    if (s.pending[seat].some((x) => x.kind === 'buoy')) throw new GameRuleError('ONE_BUOY', 'One sonar buoy a round; the rest of your salvo is shells.');
    if (buoyedAt(s, seat, at, name)) throw new GameRuleError('ALREADY_BUOYED', `You already have a buoy at ${at}'s ${name}; its reading stays live.`);
  } else if (firedAt(s, seat, at, name)) {
    throw new GameRuleError('ALREADY_FIRED', `You have already shot ${at}'s ${name}.`);
  } else if (aimedAt(s, seat, at, name)) {
    throw new GameRuleError('ALREADY_AIMED', `One of this round's shells is already on ${at}'s ${name}.`);
  }
  s.pending[seat].push({ kind: fire, from: seat, sea: at, cell: name });
  // Ready once the whole salvo is in: one shot per ship afloat.
  if (s.pending[seat].length >= gunsOf(s, seat)) s.ready = bySeatOrder(s, [...s.ready, seat]);
  if (toMove(s).length === 0) resolve(s);
}

/** Is one of this seat's shells already aimed at that cell this round? */
const aimedAt = (s: SalvoState, seat: SeatId, sea: SeatId, cell: string) =>
  s.pending[seat].some((x) => x.kind === 'shell' && x.sea === sea && x.cell === cell);

/** Most of `score`, keeping ties; the first criterion that splits the field decides. */
function best(seats: SeatId[], score: (x: SeatId) => number): SeatId[] {
  const top = Math.max(...seats.map(score));
  return seats.filter((x) => score(x) === top);
}

/** Most scrap, then most hits landed, then a seeded coin flip. Returns the winner and what decided it. */
function tiebreak(s: SalvoState, seats: SeatId[]): { winner: SeatId; by: 'scrap' | 'hits' | 'coin' | 'alone' } {
  if (seats.length === 1) return { winner: seats[0], by: 'alone' };
  const byScrap = best(seats, (x) => s.scrap[x]);
  if (byScrap.length === 1) return { winner: byScrap[0], by: 'scrap' };
  const byHits = best(byScrap, (x) => s.hitsLanded[x]);
  if (byHits.length === 1) return { winner: byHits[0], by: 'hits' };
  return { winner: createRng((s.seed ^ s.round) >>> 0).pick(byHits), by: 'coin' };
}

function finish(s: SalvoState, winner: SeatId, reason: string): void {
  s.winner = winner;
  s.endReason = reason;
  s.phase = 'over';
  s.eliminated = s.eliminated.filter((x) => x.seat !== winner);
  // Nothing is still being played: a false splash on show is over with the match (a volley that ends it tells it first).
  s.splashes = [];
  for (const x of s.seats) s.pendingTrick[x] = null;
}

const colOf = (cell: string) => cellIndex(cell)! % SIZE;
const rowIx = (cell: string) => Math.floor(cellIndex(cell)! / SIZE);

/** Where a mine's blast comes back on `shooter`: the same cell when an unhit ship cell is there, else the nearest (Manhattan, ties in board order). */
function boomerangCell(s: SalvoState, shooter: SeatId, cell: string, hitNow: (sea: SeatId, c: string) => boolean): string | null {
  const open = s.fleets[shooter].flatMap((x) => x.cells.filter((c) => !x.hits.includes(c) && !hitNow(shooter, c)));
  if (open.includes(cell)) return cell;
  const dist = (c: string) => Math.abs(colOf(c) - colOf(cell)) + Math.abs(rowIx(c) - rowIx(cell));
  return open.sort((a, b) => dist(a) - dist(b) || cellIndex(a)! - cellIndex(b)!)[0] ?? null;
}

/** Who a fake shell is dressed as: a living seat other than the fool and the sea, one that fired at the sea this volley if any. */
function dressAs(s: SalvoState, fool: SeatId, sea: SeatId, shells: Shell[]): SeatId | null {
  const can = living(s).filter((x) => x !== fool && x !== sea);
  return can.find((x) => shells.some((sh) => sh.from === x && sh.sea === sea)) ?? can[0] ?? null;
}

/**
 * All shells land together. Grouped by sea and cell in seat order (never commit order): a cell two or
 * more seats hit is a Time on Target and takes its 3×3 with it (a seat never aims two shells at one cell). Every ship cell covered this volley and
 * not hit before becomes a hit credited to every seat that covered it. Mutates `s`.
 */
function resolve(s: SalvoState): void {
  const orders = s.seats.flatMap((x) => s.pending[x]);
  const shells: Shell[] = orders.filter((x) => x.kind === 'shell').map(({ from, sea, cell }) => ({ from, sea, cell }));
  // A buoy listens once the shells have landed; what it hears is worked out live, in the view.
  const buoys: Buoy[] = orders.filter((x) => x.kind === 'buoy').map(({ from, sea, cell }) => ({ from, sea, cell }));
  for (const b of buoys) s.sonar[b.from].push({ sea: b.sea, cell: b.cell, round: s.round });
  // Tricks: a mine is live before the shells land (a ghost who calls the shot catches it this volley);
  // a false splash shows from this volley to its fool. A trick whose sea or fool has left since it was
  // played is dropped, and so is a splash once fewer than three fleets are afloat.
  const alive = living(s);
  for (const g of s.seats) {
    const t = s.pendingTrick[g];
    if (!t || !alive.includes(t.sea)) continue;
    if (t.kind === 'mine') s.mines.push({ ghost: g, sea: t.sea, cell: t.cell, round: s.round });
    else if (alive.length >= 3 && alive.includes(t.fool!)) {
      const as = dressAs(s, t.fool!, t.sea, shells);
      if (as) s.splashes.push({ ghost: g, fool: t.fool!, sea: t.sea, cell: t.cell, round: s.round, as });
    }
  }

  const groups = new Map<string, Shell[]>();
  for (const shell of shells) {
    const key = `${shell.sea} ${shell.cell}`;
    groups.set(key, [...(groups.get(key) ?? []), shell]);
  }

  // Who covered which cell of which sea: direct shells, and every cell of a blast for every shooter in it.
  const cover = new Map<string, Set<SeatId>>();
  const covered = (sea: SeatId, cell: string, by: SeatId[]) => {
    const key = `${sea} ${cell}`;
    const set = cover.get(key) ?? new Set<SeatId>();
    for (const x of by) set.add(x);
    cover.set(key, set);
  };
  const blasts: Blast[] = [];
  for (const group of groups.values()) {
    const { sea, cell } = group[0];
    const by = group.map((x) => x.from);
    if (group.length >= 2) {
      const cells = [cell, ...neighbours(cell)];
      for (const c of cells) covered(sea, c, by);
      blasts.push({ sea, cell, by, cells, hits: cells.filter((c) => shipAt(s, sea, c) && !shipAt(s, sea, c)!.hits.includes(c)) });
    } else {
      covered(sea, cell, by);
    }
  }

  // Record every covered cell, then land the new hits and their credit.
  const newHits = new Map<string, SeatId[]>(); // "sea cell" → credited seats
  for (const [key, set] of cover) {
    const [sea, cell] = key.split(' ');
    const by = bySeatOrder(s, set);
    const ship = shipAt(s, sea, cell);
    const prior = s.shots[sea][cell];
    s.shots[sea][cell] = { result: ship ? 'hit' : 'miss', by: prior ? bySeatOrder(s, [...prior.by, ...by]) : by };
    if (ship && !ship.hits.includes(cell)) newHits.set(key, by);
  }

  const tricks: Trick[] = [];
  const credit = (key: string, by: SeatId[]) => newHits.set(key, bySeatOrder(s, [...(newHits.get(key) ?? []), ...by]));
  const hitNow = (sea: SeatId, c: string) => newHits.has(`${sea} ${c}`);
  const mark = (sea: SeatId, c: string, by: SeatId[]) => {
    s.shots[sea][c] = { result: 'hit', by: bySeatOrder(s, [...(s.shots[sea][c]?.by ?? []), ...by]) };
  };
  // Mines go off after every shell has landed: seas in seat order, then board order, then the ghosts' seat order. They never chain.
  const order = (m: Mine) => [s.seats.indexOf(m.sea), cellIndex(m.cell)!, s.seats.indexOf(m.ghost)];
  const fired = s.mines
    .filter((m) => groups.has(`${m.sea} ${m.cell}`))
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  for (const m of fired) {
    const shooters = bySeatOrder(s, groups.get(`${m.sea} ${m.cell}`)!.map((x) => x.from));
    const ship = shipAt(s, m.sea, m.cell);
    if (ship) {
      // Backfire: the hull goes up with the shot, every cell of it credited to the shooters.
      for (const c of ship.cells) {
        if (ship.hits.includes(c)) continue;
        mark(m.sea, c, shooters);
        credit(`${m.sea} ${c}`, shooters);
      }
      tricks.push({ kind: 'mine', ghost: m.ghost, sea: m.sea, cell: m.cell, shooters, result: 'backfire', ship: ship.id });
    } else {
      // Dirty trick: each shooter's own fleet takes a hit, credited to the ghost.
      const hits: { sea: SeatId; cell: string }[] = [];
      for (const x of shooters) {
        const c = boomerangCell(s, x, m.cell, hitNow);
        if (!c) continue;
        mark(x, c, [m.ghost]);
        credit(`${x} ${c}`, [m.ghost]);
        hits.push({ sea: x, cell: c });
      }
      tricks.push({ kind: 'mine', ghost: m.ghost, sea: m.sea, cell: m.cell, shooters, result: 'boomerang', hits });
    }
  }
  // Every mine whose cell is now spent is gone: the ones that went off, and any a blast's spill, a boomerang
  // or a backfire hull landed on (those fizzle untold; a spent cell could never set them off).
  s.mines = s.mines.filter((m) => !s.shots[m.sea][m.cell]);
  const sunkBefore = new Set(s.seats.flatMap((sea) => s.fleets[sea].filter(isSunk).map((x) => `${sea} ${x.id}`)));
  for (const [key, by] of newHits) {
    const [sea, cell] = key.split(' ');
    shipAt(s, sea, cell)!.hits.push(cell);
    for (const x of by) {
      s.scrap[x] += 1;
      s.hitsLanded[x] += 1;
    }
  }
  for (const sea of s.seats) for (const ship of s.fleets[sea]) ship.hits.sort((a, b) => ship.cells.indexOf(a) - ship.cells.indexOf(b));

  const sunk: Volley['sunk'] = [];
  for (const sea of s.seats) {
    for (const ship of s.fleets[sea]) {
      if (!isSunk(ship) || sunkBefore.has(`${sea} ${ship.id}`)) continue;
      const by = bySeatOrder(s, ship.cells.flatMap((c) => newHits.get(`${sea} ${c}`) ?? []));
      sunk.push({ sea, ship: ship.id, by });
      for (const x of by) s.scrap[x] += 3;
    }
  }

  const results: ShellResult[] = shells.map((shell) => {
    const key = `${shell.sea} ${shell.cell}`;
    const ship = shipAt(s, shell.sea, shell.cell);
    const blast = (groups.get(key)?.length ?? 0) >= 2;
    const sankIt = ship && newHits.get(key)?.includes(shell.from) && sunk.some((x) => x.sea === shell.sea && x.ship === ship.id);
    return { ...shell, result: sankIt ? 'sunk' : ship ? 'hit' : 'miss', ship: sankIt ? ship.id : null, blast };
  });

  // A false splash shows for one volley; at the next (or as soon as a shell lands on it) it's told.
  for (const x of s.splashes) {
    if (x.round < s.round || cover.has(`${x.sea} ${x.cell}`)) tricks.push({ kind: 'splash', ghost: x.ghost, fool: x.fool, sea: x.sea, cell: x.cell });
  }
  s.splashes = s.splashes.filter((x) => x.round === s.round && !cover.has(`${x.sea} ${x.cell}`));

  // Eliminations: every living fleet now fully sunk. Half its scrap (counted before anyone is paid) goes to each sinker of its last ships.
  const out = living(s).filter((x) => s.fleets[x].length > 0 && s.fleets[x].every(isSunk));
  const snapshot = { ...s.scrap };
  for (const victim of out) {
    s.eliminated.push({ seat: victim, round: s.round, reason: 'sunk' });
    const sinkers = bySeatOrder(s, sunk.filter((x) => x.sea === victim).flatMap((x) => x.by));
    for (const x of sinkers) s.scrap[x] += Math.floor(snapshot[victim] / 2);
  }
  // A mine dies with its sea. A false splash on a sea that went out, or still on show as the match ends, is told now.
  s.mines = s.mines.filter((m) => !isEliminated(s, m.sea));
  const ends = living(s).length <= 1 || s.round >= ROUND_CAP;
  for (const x of s.splashes) {
    if (ends || isEliminated(s, x.sea)) tricks.push({ kind: 'splash', ghost: x.ghost, fool: x.fool, sea: x.sea, cell: x.cell });
  }
  s.splashes = ends ? [] : s.splashes.filter((x) => !isEliminated(s, x.sea));

  s.lastVolley = { round: s.round, shells: results, buoys, blasts, sunk, eliminated: out, tricks };
  for (const x of s.seats) s.pending[x] = [];
  for (const x of s.seats) s.pendingTrick[x] = null;
  s.ready = [];

  const left = living(s);
  if (left.length === 1) finish(s, left[0], 'last-afloat');
  else if (left.length === 0) finish(s, tiebreak(s, out).winner, 'tiebreak');
  else if (s.round >= ROUND_CAP) finish(s, tiebreak(s, best(left, (x) => unhitCells(s, x))).winner, 'round-cap');
  else s.round += 1;
}

function apply(state: SalvoState, seat: SeatId, command: unknown): SalvoState {
  if (state.phase === 'over') throw new GameRuleError('GAME_OVER', 'The game is over.');
  if (!toMove(state).includes(seat)) throw new GameRuleError('NOT_YOUR_TURN', `${seat} owes nothing this round.`);
  if (typeof command !== 'object' || command === null) throw new GameRuleError('BAD_COMMAND', 'Send a JSON object; see legal.');
  const s = clone(state);
  const cmd = command as Record<string, unknown>;
  if (s.phase === 'deploy') {
    if (!('place' in cmd)) throw new GameRuleError('BAD_COMMAND', 'The fleets are deploying: send {"place":"random"} or a placement.');
    applyPlace(s, seat, cmd);
    maybeOpenFire(s);
  } else if ('trick' in cmd) {
    applyTrick(s, seat, cmd);
  } else {
    if (isGhost(s, seat)) throw new GameRuleError('BAD_COMMAND', 'You are a ghost: send {"trick":"mine","at":"east","cell":"e5"} or {"trick":"splash","fool":"south","at":"east","cell":"e5"}.');
    if (!('fire' in cmd)) throw new GameRuleError('BAD_COMMAND', 'The fleets are down: send {"fire":"shell","at":"east","cell":"e5"}.');
    applyFire(s, seat, cmd);
  }
  return s;
}

function legal(s: SalvoState, seat: SeatId): SalvoCommand[] {
  if (!toMove(s).includes(seat)) return [];
  if (isGhost(s, seat)) return trickLegal(s, seat);
  if (s.phase === 'deploy') {
    const out: SalvoCommand[] = inPort(s, seat).flatMap((ship) => placements(s, seat, ship));
    out.push({ place: 'random' });
    return out;
  }
  const out: SalvoCommand[] = [];
  for (const sea of living(s)) {
    if (sea === seat) continue;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const cell = cellName(i);
      if (!firedAt(s, seat, sea, cell) && !aimedAt(s, seat, sea, cell)) out.push({ fire: 'shell', at: sea, cell });
    }
  }
  // Or a sonar buoy for one of the shots: one a round, any centre whose 3×3 lies on the sea, once per centre per sea.
  const buoyed = s.pending[seat].some((x) => x.kind === 'buoy');
  for (const sea of buoyed ? [] : living(s)) {
    if (sea === seat) continue;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const cell = cellName(i);
      if (isBuoyCentre(cell) && !buoyedAt(s, seat, sea, cell)) out.push({ fire: 'buoy', at: sea, cell });
    }
  }
  return out;
}

function outcome(s: SalvoState): Outcome | null {
  if (!s.winner) return null;
  // Survivors who did not win (round cap) share second; then elimination rounds, newest first, each a shared place.
  const survivors = living(s).filter((x) => x !== s.winner);
  const rounds = [...new Set(s.eliminated.map((x) => x.round))].sort((a, b) => b - a);
  const groups = rounds.map((r) => bySeatOrder(s, s.eliminated.filter((x) => x.round === r).map((x) => x.seat)));
  return {
    winners: [s.winner],
    placement: [[s.winner], ...(survivors.length > 0 ? [survivors] : []), ...groups],
    reason: s.endReason ?? 'last-afloat',
  };
}

function forfeit(state: SalvoState, seat: SeatId, reason: string): SalvoState {
  const s = clone(state);
  if (s.phase !== 'over' && isGhost(s, seat)) {
    // A ghost that misses three rounds fades: released, its placement untouched, its mischief gone with it.
    s.ghostsGone.push(seat);
    s.pendingTrick[seat] = null;
    s.mines = s.mines.filter((x) => x.ghost !== seat);
    s.splashes = s.splashes.filter((x) => x.ghost !== seat);
    s.ready = s.ready.filter((x) => x !== seat);
    if (s.phase === 'fire' && toMove(s).length === 0) resolve(s);
    return s;
  }
  if (s.phase === 'over' || !s.seats.includes(seat) || isEliminated(s, seat)) return s;
  s.eliminated.push({ seat, round: s.round, reason });
  s.pending[seat] = [];
  s.ready = s.ready.filter((x) => x !== seat);
  const alive = living(s);
  if (alive.length === 1) {
    for (const x of s.seats) s.pending[x] = [];
    s.ready = [];
    finish(s, alive[0], reason);
  } else if (s.phase === 'fire' && toMove(s).length === 0) {
    resolve(s);
  } else {
    maybeOpenFire(s);
  }
  return s;
}

/** Unhit ship cells of a sea among the cells `where` accepts. */
const afloatIn = (s: SalvoState, sea: SeatId, where: (cell: string) => boolean) =>
  s.fleets[sea].reduce((n, x) => n + x.cells.filter((c) => where(c) && !x.hits.includes(c)).length, 0);

function targetView(s: SalvoState, sea: SeatId, you: SeatId | null, fakes: Splash[]): TargetView {
  const shots = Object.entries(s.shots[sea]);
  const byBoard = (a: string, b: string) => cellIndex(a)! - cellIndex(b)!;
  const sunkShips = s.fleets[sea].filter(isSunk);
  const sunkCells = new Set(sunkShips.flatMap((x) => x.cells));
  const real = shots.filter(([, x]) => x.result === 'hit').map(([c]) => c);
  // A fool sees the false splashes played on them as hits like any other.
  const hits = [...new Set([...real, ...fakes.filter((x) => x.sea === sea).map((x) => x.cell)])].sort(byBoard);
  const t: TargetView = {
    sea,
    mine: you
      ? shots.filter(([, x]) => x.by.includes(you)).map(([cell, x]) => ({ cell, result: sunkCells.has(cell) ? 'sunk' : x.result }))
      : [],
    hits,
    misses: shots.filter(([, x]) => x.result === 'miss').map(([c]) => c).sort(byBoard),
    sunk: sunkShips.map((x) => ({ ship: x.id, cells: [...x.cells] })),
    lifted: liftedRows(s.round).map((row) => ({ row, afloat: afloatIn(s, sea, (c) => rowOf(c) === row) })),
    sonar: you
      ? s.sonar[you]
          .filter((x) => x.sea === sea)
          .map((x) => {
            const cells = buoyCells(x.cell);
            return { cell: x.cell, round: x.round, cells, afloat: afloatIn(s, sea, (c) => cells.includes(c)) };
          })
      : [],
    afloat: FLEET_CELLS - hits.length,
    out: isEliminated(s, sea),
  };
  if (s.phase === 'over') {
    t.revealed = copy(s.fleets[sea]);
    t.mines = s.mines.filter((m) => m.sea === sea).map(({ ghost, cell }) => ({ ghost, cell }));
  }
  return t;
}

/** The last volley as a seat sees it: a fool's copy carries each false splash of that volley as one more shell from its dressed-up shooter. */
function volleyView(s: SalvoState, fakes: Splash[]): Volley | null {
  if (!s.lastVolley) return null;
  const v = copy(s.lastVolley);
  for (const x of fakes) {
    if (x.round !== v.round) continue;
    const fake: ShellResult = { from: x.as, sea: x.sea, cell: x.cell, result: 'hit', ship: null, blast: false };
    // After the last shell from its shooter, else where seat order puts it.
    const last = v.shells.map((sh) => sh.from).lastIndexOf(x.as);
    const at = last >= 0 ? last + 1 : v.shells.findIndex((sh) => s.seats.indexOf(sh.from) > s.seats.indexOf(x.as));
    v.shells.splice(at >= 0 ? at : v.shells.length, 0, fake);
  }
  return v;
}

function view(s: SalvoState, seat: SeatId | null): SalvoView {
  const you = seat !== null && s.seats.includes(seat) ? seat : null;
  const over = s.phase === 'over';
  const seas = s.seats.filter((x) => x !== you);
  const fakes = you && !over ? s.splashes.filter((x) => x.fool === you) : [];
  const mySea: SalvoView['mySea'] = you
    ? {
        ships: SHIPS.map((x) => {
          const ship = s.fleets[you].find((p) => p.id === x.id);
          return ship ? { id: ship.id, cells: [...ship.cells], hits: [...ship.hits] } : { id: x.id, cells: [], hits: [] };
        }),
        port: inPort(s, you).map((x) => x.id),
        shots: Object.fromEntries(Object.entries(s.shots[you]).map(([c, x]) => [c, x.result])),
      }
    : null;
  const v: Omit<SalvoView, 'ascii'> = {
    you,
    seats: [...s.seats],
    round: s.round,
    phase: s.phase,
    ready: [...s.ready],
    ghosts: ghosts(s),
    guns: s.phase === 'fire' ? Object.fromEntries(living(s).map((x) => [x, gunsOf(s, x)])) : {},
    myOrders: you && s.phase === 'fire' ? s.pending[you].map((x) => ({ fire: x.kind, at: x.sea, cell: x.cell })) : [],
    myTricks:
      you && isGhost(s, you)
        ? {
            mines: minesOf(s, you).map(({ sea, cell, round }) => ({ sea, cell, round })),
            splashes: s.splashes.filter((x) => x.ghost === you).map(({ fool, sea, cell, round }) => ({ fool, sea, cell, round })),
            pending: s.pendingTrick[you] ? { trick: s.pendingTrick[you]!.kind, at: s.pendingTrick[you]!.sea, cell: s.pendingTrick[you]!.cell, ...(s.pendingTrick[you]!.fool ? { fool: s.pendingTrick[you]!.fool } : {}) } : null,
          }
        : null,
    mySea,
    targets: seas.map((x) => targetView(s, x, you, fakes)),
    lastVolley: volleyView(s, fakes),
    scrap: { ...s.scrap },
    eliminated: s.eliminated.map((x) => x.seat),
    liftedRows: liftedRows(s.round),
    winner: s.winner,
    endReason: s.endReason,
  };
  return { ...v, ascii: renderAscii(v) };
}

// ── Narration: nothing here may name a cell, a sea or a ship before the volley lands. ──

const isFire = (c: unknown) => typeof c === 'object' && c !== null && 'fire' in c;
const isRandom = (c: unknown) => typeof c === 'object' && c !== null && (c as { place?: unknown }).place === 'random';

const isTrick = (c: unknown) => typeof c === 'object' && c !== null && 'trick' in c;

function describe(command: unknown): string {
  if (isTrick(command)) return 'plays a dirty trick';
  if (isFire(command)) return 'fires';
  return isRandom(command) ? 'deploys the fleet' : 'deploys a ship';
}

function narrate(_before: SalvoState, _after: SalvoState, _seat: SeatId, command: unknown): string {
  if (isTrick(command)) return 'is up to something…';
  return isFire(command) ? 'is ready' : describe(command);
}

const who = (seats: SeatId[]) => {
  const names = seats.map((x) => `{${x}}`);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};
const COUNT = ['No', 'One', 'Both', 'Three', 'Four'];

/** One revealed trick, told. A boomerang names the cell it struck, never the ship (unless the volley's sinkings do). */
function trickLine(t: Trick): string {
  if (t.kind === 'splash') return `Dirty trick! The hit {${t.fool}} saw on {${t.sea}} ${t.cell} was {${t.ghost}}'s false splash.`;
  const shell = `${who(t.shooters)}'s ${t.shooters.length === 1 ? 'shell' : 'shells'}`;
  if (t.result === 'backfire') {
    return `Backfire! {${t.ghost}}'s mine was sitting on {${t.sea}}'s ${t.ship}. ${shell} ${t.shooters.length === 1 ? 'sends' : 'send'} it to the bottom. Thanks for the help, {${t.ghost}}.`;
  }
  const back = t.hits.length === 0 ? 'but there was nothing left to hit' : t.hits.map((h) => `it comes back on {${h.sea}}'s own sea at ${h.cell}, a hit`).join('; ');
  return `Dirty trick! {${t.ghost}}'s mine at {${t.sea}} ${t.cell} goes off under ${shell} — ${back}.`;
}

/** The round's story, told once it has landed, credited to no seat. Seats are written {seat}. */
export function roundSummary(before: SalvoState, after: SalvoState): string[] {
  if (before.phase === 'deploy' && after.phase === 'fire') return ['All fleets are down. Round 1 begins.'];
  const ended = before.phase !== 'over' && after.phase === 'over';
  if (after.round === before.round && !ended) return [];
  const lines: string[] = [];
  const v = after.lastVolley;
  const fresh = v !== null && v.round === before.round && v !== before.lastVolley && before.phase === 'fire';
  const tied = after.endReason === 'tiebreak' && v ? v.eliminated : [];
  if (fresh && v) {
    // Hits and sinkings by name; the misses only counted (a four-seat round can fire sixteen shells).
    const clauses: string[] = [];
    let misses = 0;
    for (const x of v.shells) {
      if (x.blast) continue;
      const clause =
        x.result === 'sunk' ? `{${x.from}} sinks {${x.sea}}'s ${x.ship}` : x.result === 'hit' ? `{${x.from}} hits {${x.sea}} at ${x.cell}` : null;
      if (clause === null) misses += 1;
      else if (!clauses.includes(clause)) clauses.push(clause);
    }
    const parts = misses > 0 ? [...clauses, `${misses} ${misses === 1 ? 'miss' : 'misses'}`] : clauses;
    if (parts.length > 0) lines.push(`Round ${v.round}: ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}.`);
    for (const b of v.buoys ?? []) lines.push(`{${b.from}} drops a sonar buoy on {${b.sea}}'s sea at ${b.cell}.`);
    for (const b of v.blasts) {
      const hits = `${b.hits.length} ${b.hits.length === 1 ? 'hit' : 'hits'}`;
      lines.push(`Time on Target at {${b.sea}} ${b.cell} by ${who(b.by)}: ${b.cells.length} cells, ${hits}.`);
    }
    for (const x of v.sunk) {
      const told = v.shells.some((sh) => !sh.blast && sh.result === 'sunk' && sh.sea === x.sea && sh.ship === x.ship);
      if (!told) lines.push(`${who(x.by)} ${x.by.length === 1 ? 'sinks' : 'sink'} {${x.sea}}'s ${x.ship}.`);
    }
    for (const t of v.tricks ?? []) lines.push(trickLine(t));
    for (const x of v.eliminated) {
      if (tied.includes(x)) continue;
      const sunk = after.eliminated.some((e) => e.seat === x && e.reason === 'sunk');
      lines.push(`{${x}} is out${sunk && !ended ? ', and comes back as a ghost' : ''}.`);
    }
  }
  if (!ended) {
    const lifted = liftedRows(after.round).filter((r) => !liftedRows(before.round).includes(r));
    for (const r of lifted) lines.push(`The fog lifts from row ${r}.`);
    return lines;
  }
  const w = `{${after.winner}}`;
  if (after.endReason === 'last-afloat') {
    lines.push(`${w} is the last fleet afloat and takes it.`);
  } else if (after.endReason === 'tiebreak') {
    const why = { scrap: 'had more scrap', hits: 'landed more hits', coin: 'wins the coin flip', alone: 'is the last' }[tiebreak(after, tied).by];
    const together = tied.length === 2 ? 'Both fleets go down together.' : `All ${COUNT[tied.length].toLowerCase()} fleets go down together.`;
    lines.push(`${together} ${w} ${why}. ${w} takes it.`);
  } else if (after.endReason === 'round-cap') {
    const alive = after.seats.filter((x) => x === after.winner || !after.eliminated.some((e) => e.seat === x));
    const most = best(alive, (x) => unhitCells(after, x));
    const why = most.length === 1 ? 'has the most ship cells afloat' : { scrap: 'had more scrap', hits: 'landed more hits', coin: 'wins the coin flip', alone: '' }[tiebreak(after, most).by];
    lines.push(`Round ${after.round} is the last. ${w} ${why}. ${w} takes it.`);
  } else {
    lines.push(`Everyone else is gone. ${w} takes it.`);
  }
  return lines;
}

export const salvoGame: GameModule<SalvoState> & { turn: TurnRules<SalvoState> & Required<Pick<TurnRules<SalvoState>, 'round' | 'roundSummary'>> } = {
  meta: {
    id: 'salvo',
    name: 'Salvo',
    tagline: 'Four hidden fleets. Everyone fires at once.',
    mode: 'turn',
    minPlayers: 2,
    maxPlayers: 4,
    seats: [...SEATS],
    rulesPath: 'games/salvo/docs/rules.md',
    humans: true,
    thumbnail: 'thumbnail.jpg',
    houseFill: true,
    // Unranked for now (the design's "first week or so"): the residents are tuned first, then this comes down.
    practiceGames: Number.MAX_SAFE_INTEGER,
  },
  setup({ seats, seed }) {
    if (seats.length < 2 || seats.length > 4) throw new GameRuleError('BAD_SEATS', 'Salvo takes 2–4 players.');
    const each = <T>(make: () => T): Record<SeatId, T> => Object.fromEntries(seats.map((x) => [x, make()]));
    return {
      seats: [...seats],
      seed,
      draws: 0,
      phase: 'deploy',
      round: 0,
      fleets: each<Ship[]>(() => []),
      shots: each(() => ({})),
      pending: each<Order[]>(() => []),
      sonar: each<SalvoState['sonar'][SeatId]>(() => []),
      ready: [],
      mines: [],
      splashes: [],
      ghostsGone: [],
      pendingTrick: each<PendingTrick | null>(() => null),
      lastVolley: null,
      scrap: each(() => 0),
      hitsLanded: each(() => 0),
      eliminated: [],
      timeouts: each(() => 0),
      winner: null,
      endReason: null,
    };
  },
  view,
  outcome,
  forfeit,
  isOut: (s, seat) => isEliminated(s, seat),
  stillSeated: (s, seat) => isGhost(s, seat),
  turn: {
    turnSeconds: TURN_SECONDS,
    simultaneous: true,
    round: (s) => s.round,
    toMove,
    legal,
    apply,
    describe,
    narrate,
    roundSummary,
  },
};

export default salvoGame;

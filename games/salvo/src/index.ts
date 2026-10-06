import { GameRuleError, createRng, type GameModule, type Outcome, type SeatId, type TurnRules } from '@cs/game-api';
import { renderAscii } from './ascii';
import { SIZE, buoyCells, cellIndex, cellName, hullCells, isBuoyCentre, liftedRows, neighbours, rowOf, type Facing } from './board';

export { FOG_FROM, SIZE, buoyCells, cellIndex, cellName, hullCells, isBuoyCentre, liftedRows, neighbours } from './board';
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
export interface Volley {
  round: number;
  shells: ShellResult[];
  /** Sonar buoys dropped this round, in seat order: where, never what they heard. */
  buoys: Buoy[];
  blasts: Blast[];
  sunk: { sea: SeatId; ship: ShipId; by: SeatId[] }[];
  /** Seats whose last ship went down in this volley, in seat order (a tiebreak winner included). */
  eliminated: SeatId[];
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
  /** This round's secret commits. Never in any view. */
  pending: Record<SeatId, Order | null>;
  /** Each seat's sonar buoys, oldest first. Each one is shown only to the seat that dropped it. */
  sonar: Record<SeatId, { sea: SeatId; cell: string; round: number }[]>;
  /** Seats that owe nothing this round (fleet down, or shell committed), in seat order. Public. */
  ready: SeatId[];
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
  | { fire: 'buoy'; at: SeatId; cell: string };

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
  /** Every ship, once the match is over. */
  revealed?: Ship[];
}
export interface SalvoView {
  you: SeatId | null;
  seats: SeatId[];
  round: number;
  phase: Phase;
  ready: SeatId[];
  /** Your fleet: every ship, its cells and hits; ships still in port are listed with `cells: []`. Null for spectators. */
  mySea: { ships: Ship[]; port: ShipId[]; shots: Record<string, 'miss' | 'hit'> } | null;
  /** One per sea that is not yours and not eliminated (spectators: every living sea); every sea once over. */
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

function toMove(s: SalvoState): SeatId[] {
  if (s.phase === 'deploy') return living(s).filter((x) => inPort(s, x).length > 0);
  if (s.phase === 'fire') return living(s).filter((x) => !s.ready.includes(x));
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
    if (buoyedAt(s, seat, at, name)) throw new GameRuleError('ALREADY_BUOYED', `You already have a buoy at ${at}'s ${name}; its reading stays live.`);
  } else if (firedAt(s, seat, at, name)) {
    throw new GameRuleError('ALREADY_FIRED', `You have already shot ${at}'s ${name}.`);
  }
  s.pending[seat] = { kind: fire, from: seat, sea: at, cell: name };
  s.ready = bySeatOrder(s, [...s.ready, seat]);
  if (living(s).every((x) => s.ready.includes(x))) resolve(s);
}

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
}

/**
 * All shells land together. Grouped by sea and cell in seat order (never commit order): a cell two or
 * more seats hit is a Time on Target and takes its 3×3 with it. Every ship cell covered this volley and
 * not hit before becomes a hit credited to every seat that covered it. Mutates `s`.
 */
function resolve(s: SalvoState): void {
  const orders = s.seats.map((x) => s.pending[x]).filter((x): x is Order => x !== null);
  const shells: Shell[] = orders.filter((x) => x.kind === 'shell').map(({ from, sea, cell }) => ({ from, sea, cell }));
  // A buoy listens once the shells have landed; what it hears is worked out live, in the view.
  const buoys: Buoy[] = orders.filter((x) => x.kind === 'buoy').map(({ from, sea, cell }) => ({ from, sea, cell }));
  for (const b of buoys) s.sonar[b.from].push({ sea: b.sea, cell: b.cell, round: s.round });
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

  // Eliminations: every living fleet now fully sunk. Half its scrap (counted before anyone is paid) goes to each sinker of its last ships.
  const out = living(s).filter((x) => s.fleets[x].length > 0 && s.fleets[x].every(isSunk));
  const snapshot = { ...s.scrap };
  for (const victim of out) {
    s.eliminated.push({ seat: victim, round: s.round, reason: 'sunk' });
    const sinkers = bySeatOrder(s, sunk.filter((x) => x.sea === victim).flatMap((x) => x.by));
    for (const x of sinkers) s.scrap[x] += Math.floor(snapshot[victim] / 2);
  }

  s.lastVolley = { round: s.round, shells: results, buoys, blasts, sunk, eliminated: out };
  for (const x of s.seats) s.pending[x] = null;
  s.ready = [];

  const alive = living(s);
  if (alive.length === 1) finish(s, alive[0], 'last-afloat');
  else if (alive.length === 0) finish(s, tiebreak(s, out).winner, 'tiebreak');
  else if (s.round >= ROUND_CAP) finish(s, tiebreak(s, best(alive, (x) => unhitCells(s, x))).winner, 'round-cap');
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
  } else {
    if (!('fire' in cmd)) throw new GameRuleError('BAD_COMMAND', 'The fleets are down: send {"fire":"shell","at":"east","cell":"e5"}.');
    applyFire(s, seat, cmd);
  }
  return s;
}

function legal(s: SalvoState, seat: SeatId): SalvoCommand[] {
  if (!toMove(s).includes(seat)) return [];
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
      if (!firedAt(s, seat, sea, cell)) out.push({ fire: 'shell', at: sea, cell });
    }
  }
  // Or a sonar buoy instead: any centre whose 3×3 lies on the sea, once per centre per sea.
  for (const sea of living(s)) {
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
  if (s.phase === 'over' || !s.seats.includes(seat) || isEliminated(s, seat)) return s;
  s.eliminated.push({ seat, round: s.round, reason });
  s.pending[seat] = null;
  s.ready = s.ready.filter((x) => x !== seat);
  const alive = living(s);
  if (alive.length === 1) {
    for (const x of s.seats) s.pending[x] = null;
    s.ready = [];
    finish(s, alive[0], reason);
  } else if (s.phase === 'fire' && alive.every((x) => s.ready.includes(x))) {
    resolve(s);
  } else {
    maybeOpenFire(s);
  }
  return s;
}

/** Unhit ship cells of a sea among the cells `where` accepts. */
const afloatIn = (s: SalvoState, sea: SeatId, where: (cell: string) => boolean) =>
  s.fleets[sea].reduce((n, x) => n + x.cells.filter((c) => where(c) && !x.hits.includes(c)).length, 0);

function targetView(s: SalvoState, sea: SeatId, you: SeatId | null): TargetView {
  const shots = Object.entries(s.shots[sea]);
  const byBoard = (a: string, b: string) => cellIndex(a)! - cellIndex(b)!;
  const sunkShips = s.fleets[sea].filter(isSunk);
  const sunkCells = new Set(sunkShips.flatMap((x) => x.cells));
  const hits = shots.filter(([, x]) => x.result === 'hit').map(([c]) => c).sort(byBoard);
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
  };
  if (s.phase === 'over') t.revealed = copy(s.fleets[sea]);
  return t;
}

function view(s: SalvoState, seat: SeatId | null): SalvoView {
  const you = seat !== null && s.seats.includes(seat) ? seat : null;
  const over = s.phase === 'over';
  const seas = s.seats.filter((x) => x !== you && (over || !isEliminated(s, x)));
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
    mySea,
    targets: seas.map((x) => targetView(s, x, you)),
    lastVolley: s.lastVolley && copy(s.lastVolley),
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

function describe(command: unknown): string {
  if (isFire(command)) return 'fires';
  return isRandom(command) ? 'deploys the fleet' : 'deploys a ship';
}

function narrate(_before: SalvoState, _after: SalvoState, _seat: SeatId, command: unknown): string {
  return isFire(command) ? 'is ready' : describe(command);
}

const who = (seats: SeatId[]) => {
  const names = seats.map((x) => `{${x}}`);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};
const COUNT = ['No', 'One', 'Both', 'Three', 'Four'];

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
    const clauses: string[] = [];
    for (const x of v.shells) {
      if (x.blast) continue;
      if (x.result === 'sunk') clauses.push(`{${x.from}} sinks {${x.sea}}'s ${x.ship}`);
      else if (x.result === 'hit') clauses.push(`{${x.from}} hits {${x.sea}} at ${x.cell}`);
      else clauses.push(`{${x.from}} misses {${x.sea}}`);
    }
    if (clauses.length > 0) lines.push(`Round ${v.round}: ${clauses.join(', ')}.`);
    for (const b of v.buoys ?? []) lines.push(`{${b.from}} drops a sonar buoy on {${b.sea}}'s sea at ${b.cell}.`);
    for (const b of v.blasts) {
      const hits = `${b.hits.length} ${b.hits.length === 1 ? 'hit' : 'hits'}`;
      lines.push(`Time on Target at {${b.sea}} ${b.cell} by ${who(b.by)}: ${b.cells.length} cells, ${hits}.`);
    }
    for (const x of v.sunk) {
      const told = v.shells.some((sh) => !sh.blast && sh.result === 'sunk' && sh.sea === x.sea && sh.ship === x.ship);
      if (!told) lines.push(`${who(x.by)} ${x.by.length === 1 ? 'sinks' : 'sink'} {${x.sea}}'s ${x.ship}.`);
    }
    for (const x of v.eliminated) if (!tied.includes(x)) lines.push(`{${x}} is out.`);
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
      pending: each<Order | null>(() => null),
      sonar: each<SalvoState['sonar'][SeatId]>(() => []),
      ready: [],
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

import { describe, expect, test } from 'bun:test';
import {
  FOG_FROM,
  ITEMS,
  MINE_LIMIT,
  ROUND_CAP,
  SEATS,
  SHIPS,
  TURN_SECONDS,
  buoyCells,
  cellIndex,
  cellName,
  hullCells,
  isBuoyCentre,
  liftedRows,
  neighbours,
  roundSummary,
  salvoGame as G,
  type SalvoCommand,
  type SalvoState,
  type ItemId,
  type SalvoView,
  type ShipId,
} from './index';

const turn = G.turn;
const seatsOf = (n: number) => SEATS.slice(0, n) as string[];
const fresh = (n = 4, seed = 1): SalvoState => G.setup({ seats: seatsOf(n), seed });
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return null;
};
const place = (s: SalvoState, seat: string, ship: ShipId, at: string, facing: 'east' | 'north' = 'east') =>
  turn.apply(s, seat, { place: ship, at, facing });
const fire = (s: SalvoState, seat: string, at: string, cell: string) => turn.apply(s, seat, { fire: 'shell', at, cell });
const buoy = (s: SalvoState, seat: string, at: string, cell: string) => turn.apply(s, seat, { fire: 'buoy', at, cell });
/** The shells in a seat's legal (buoys are listed after them). */
const shellsOf = (s: SalvoState, seat: string) => (turn.legal(s, seat) as SalvoCommand[]).filter((c) => 'fire' in c && c.fire === 'shell');
const viewOf = (s: SalvoState, seat: string | null) => G.view(s, seat) as SalvoView;

/** The standard fleet: every ship along the west edge, one row apart. Cells: a1–d1, a3–c3, a5–c5, a7–b7. */
const STANDARD: [ShipId, string][] = [
  ['cruiser', 'a1'],
  ['destroyer', 'a3'],
  ['frigate', 'a5'],
  ['submarine', 'a7'],
];
const SHIP_CELLS = ['a1', 'b1', 'c1', 'd1', 'a3', 'b3', 'c3', 'a5', 'b5', 'c5', 'a7', 'b7'];

/** Every seat deploys the standard fleet; the first round is open. */
function deployed(n = 4, seed = 1): SalvoState {
  let s = fresh(n, seed);
  for (const seat of s.seats) for (const [ship, at] of STANDARD) s = place(s, seat, ship, at);
  return s;
}

/** A shot for the helpers: [sea, cell], a shell unless 'buoy' is given. */
type Shot = [string, string] | [string, string, 'shell' | 'buoy'];
const isOut = (s: SalvoState, seat: string) => s.eliminated.some((x) => x.seat === seat);
/** Ships afloat: one gun each. */
const gunsOf = (s: SalvoState, seat: string) => s.fleets[seat].filter((x) => x.hits.length < x.cells.length).length;
/** Each seat's filler column: columns e–h are open water in the STANDARD fleet, and one each means fillers never meet. */
const FILL_COLUMN: Record<string, string> = { north: 'e', east: 'f', south: 'g', west: 'h' };
/** Where a seat's fillers go: its last living opponent in seat order. */
const fillSea = (s: SalvoState, seat: string) => s.seats.filter((x) => x !== seat && !isOut(s, x)).at(-1)!;

/**
 * One seat's whole salvo: the shots given, then filler shells until every gun has fired. Fillers run down the
 * seat's own column of its last living opponent from row 8, skipping cells this seat has shot or anyone has
 * aimed this round, and any "sea cell" in `avoid` (shots others are about to send), so they never make a
 * Time on Target and never hit a STANDARD ship. Any crate the seat has open is passed first, unless `keepCrates`.
 */
function salvo(s: SalvoState, seat: string, shots: Shot[] = [], avoid: string[] = [], keepCrates = false): SalvoState {
  while (!keepCrates && s.phase === 'fire' && s.crates[seat]?.length > 0 && turn.toMove(s).includes(seat)) s = turn.apply(s, seat, { crate: 'pass' });
  for (const [sea, cell, kind = 'shell'] of shots) s = turn.apply(s, seat, { fire: kind, at: sea, cell });
  if (!turn.toMove(s).includes(seat)) return s;
  const sea = fillSea(s, seat);
  const taken = new Set([...avoid, ...s.seats.flatMap((x) => s.pending[x].filter((o) => o.kind === 'shell').map((o) => `${o.sea} ${o.cell}`))]);
  const owed = gunsOf(s, seat) - s.pending[seat].length;
  for (let k = 0, row = 8; k < owed; row--) {
    const cell = `${FILL_COLUMN[seat]}${row}`;
    if (taken.has(`${sea} ${cell}`) || s.shots[sea][cell]?.by.includes(seat)) continue;
    s = fire(s, seat, sea, cell);
    k++;
  }
  return s;
}

/** Every seat still owing fires its whole salvo, in seat order: `shots` gives the shots that matter, fillers do the rest. */
function volley(s: SalvoState, shots: Record<string, Shot | Shot[]>): SalvoState {
  const lists: Record<string, Shot[]> = {};
  for (const [seat, x] of Object.entries(shots)) lists[seat] = Array.isArray(x[0]) ? (x as Shot[]) : [x as Shot];
  const avoid = Object.values(lists).flatMap((l) => l.filter((x) => x[2] !== 'buoy').map(([sea, cell]) => `${sea} ${cell}`));
  const round = s.round;
  for (const seat of s.seats) {
    if (s.round !== round || s.phase !== 'fire') break;
    if (isOut(s, seat)) continue;
    if (lists[seat] || turn.toMove(s).includes(seat)) s = salvo(s, seat, lists[seat], avoid);
  }
  return s;
}

/**
 * Every ghost still owing plays the first trick on offer, which closes the round. That is a real mine on the
 * first living sea's first unshot cell (north a1, b1, … while north is afloat): a test using this keeps its shells off those cells.
 */
function haunt(s: SalvoState): SalvoState {
  const round = s.round;
  for (const seat of s.seats) {
    if (s.phase === 'fire' && s.round === round && G.stillSeated!(s, seat) && turn.toMove(s).includes(seat)) s = turn.apply(s, seat, (turn.legal(s, seat) as unknown[])[0]);
  }
  return s;
}

/** The volley's misses, as "from sea cell". */
const missesOf = (s: SalvoState) => s.lastVolley!.shells.filter((x) => x.result === 'miss').map((x) => `${x.from} ${x.sea} ${x.cell}`);

/** Mark cells of a sea as already hit (test setup only; keeps `shots` and ship hits in step). */
function preHit(s: SalvoState, sea: string, cells: string[], by = 'west') {
  for (const cell of cells) {
    const ship = s.fleets[sea].find((x) => x.cells.includes(cell));
    if (ship && !ship.hits.includes(cell)) ship.hits.push(cell);
    s.shots[sea][cell] = { result: ship ? 'hit' : 'miss', by: [by] };
  }
}

describe('board helpers', () => {
  test('cells are a1..h8, a1 bottom-left, case-insensitive', () => {
    expect(cellIndex('a1')).toBe(0);
    expect(cellIndex('h1')).toBe(7);
    expect(cellIndex('a2')).toBe(8);
    expect(cellIndex('H8')).toBe(63);
    expect(cellIndex(' e5 ')).toBe(36);
    for (const bad of ['i1', 'a9', 'a0', '', 'e', '55', 'a10']) expect(cellIndex(bad)).toBeNull();
    expect(cellName(0)).toBe('a1');
    expect(cellName(63)).toBe('h8');
    expect(cellName(36)).toBe('e5');
  });
  test('neighbours are the eight around a cell, on the sea', () => {
    expect(neighbours('a1')).toEqual(['b1', 'a2', 'b2']);
    expect(neighbours('e5')).toEqual(['d4', 'e4', 'f4', 'd5', 'f5', 'd6', 'e6', 'f6']);
    expect(neighbours('h8')).toEqual(['g7', 'h7', 'g8']);
    expect(neighbours('z9')).toEqual([]);
  });
  test('hulls run east or north from their first cell and must stay on the sea', () => {
    expect(hullCells('c3', 4, 'east')).toEqual(['c3', 'd3', 'e3', 'f3']);
    expect(hullCells('c3', 4, 'north')).toEqual(['c3', 'c4', 'c5', 'c6']);
    expect(hullCells('E5', 4, 'north')).toEqual(['e5', 'e6', 'e7', 'e8']);
    expect(hullCells('f3', 4, 'east')).toBeNull();
    expect(hullCells('a6', 4, 'north')).toBeNull();
    expect(hullCells('z1', 2, 'east')).toBeNull();
  });
  test('the fog lifts one row a round from round 6, edges inward', () => {
    expect(FOG_FROM).toBe(6);
    expect(liftedRows(0)).toEqual([]);
    expect(liftedRows(5)).toEqual([]);
    expect(liftedRows(6)).toEqual([8]);
    expect(liftedRows(7)).toEqual([8, 1]);
    expect(liftedRows(8)).toEqual([8, 1, 7]);
    expect(liftedRows(13)).toEqual([8, 1, 7, 2, 6, 3, 5, 4]);
    expect(liftedRows(30)).toEqual([8, 1, 7, 2, 6, 3, 5, 4]);
  });
  test('a buoy centre keeps its 3×3 on the sea: b2..g7', () => {
    expect(['b2', 'g7', 'e5', 'B2'].map(isBuoyCentre)).toEqual([true, true, true, true]);
    expect(['a1', 'a5', 'h4', 'e1', 'e8', 'z9'].map(isBuoyCentre)).toEqual([false, false, false, false, false, false]);
    expect(buoyCells('b2')).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3']);
  });
});

describe('setup', () => {
  test('two to four seats, deploying, nothing placed', () => {
    for (const n of [2, 3, 4]) {
      const s = fresh(n);
      expect(s.seats).toEqual(seatsOf(n));
      expect(s.phase).toBe('deploy');
      expect(s.round).toBe(0);
      expect(s.draws).toBe(0);
      expect(s.ready).toEqual([]);
      expect(s.lastVolley).toBeNull();
      expect(s.winner).toBeNull();
      for (const seat of s.seats) {
        expect(s.fleets[seat]).toEqual([]);
        expect(s.shots[seat]).toEqual({});
        expect(s.pending[seat]).toEqual([]);
        expect(s.scrap[seat]).toBe(0);
        expect(s.hitsLanded[seat]).toBe(0);
        expect(s.timeouts[seat]).toBe(0);
      }
      expect(turn.toMove(s)).toEqual(seatsOf(n));
      expect(turn.round(s)).toBe(0);
    }
  });
  test('rejects one or five seats', () => {
    expect(codeOf(() => G.setup({ seats: ['north'], seed: 1 }))).toBe('BAD_SEATS');
    expect(codeOf(() => G.setup({ seats: [...SEATS, 'extra'], seed: 1 }))).toBe('BAD_SEATS');
  });
  test('meta and turn rules', () => {
    expect(G.meta.id).toBe('salvo');
    expect(G.meta.seats).toEqual([...SEATS]);
    expect([G.meta.minPlayers, G.meta.maxPlayers]).toEqual([2, 4]);
    expect(G.meta.rulesPath).toBe('games/salvo/docs/rules.md');
    expect(turn.turnSeconds).toBe(TURN_SECONDS);
    expect(turn.simultaneous).toBe(true);
    expect(SHIPS.reduce((n, x) => n + x.length, 0)).toBe(12);
  });
});

describe('deployment', () => {
  test('legal lists every fitting placement and the random option', () => {
    const s = fresh();
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    // cruiser 5×8×2, destroyer and frigate 6×8×2 each, submarine 7×8×2, plus random
    expect(legal).toHaveLength(80 + 96 + 96 + 112 + 1);
    expect(legal[0]).toEqual({ place: 'cruiser', at: 'a1', facing: 'east' });
    expect(legal).toContainEqual({ place: 'random' });
    const after = place(s, 'north', 'cruiser', 'a1');
    const next = turn.legal(after, 'north') as SalvoCommand[];
    expect(next.some((c) => 'place' in c && c.place === 'cruiser')).toBe(false);
    expect(next).not.toContainEqual({ place: 'submarine', at: 'b1', facing: 'east' }); // overlaps
    expect(next).toContainEqual({ place: 'submarine', at: 'a2', facing: 'east' }); // touching is fine
  });
  test('placing a ship puts it in the fleet; the others keep deploying', () => {
    const s = place(fresh(), 'north', 'cruiser', 'c3', 'north');
    expect(s.fleets.north).toEqual([{ id: 'cruiser', cells: ['c3', 'c4', 'c5', 'c6'], hits: [] }]);
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south', 'west']);
    expect(s.phase).toBe('deploy');
  });
  test('illegal placements carry precise codes', () => {
    const s = place(fresh(), 'north', 'cruiser', 'a1');
    expect(codeOf(() => turn.apply(s, 'north', null))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(s, 'north', {}))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(s, 'north', { place: 5 }))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(s, 'north', { place: 'frigate', at: 5, facing: 'east' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(s, 'north', { fire: 'shell', at: 'east', cell: 'a1' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => place(s, 'north', 'battleship' as ShipId, 'a3'))).toBe('BAD_SHIP');
    expect(codeOf(() => place(s, 'north', 'cruiser', 'a3'))).toBe('BAD_SHIP');
    expect(codeOf(() => place(s, 'north', 'frigate', 'z9'))).toBe('BAD_CELL');
    expect(codeOf(() => turn.apply(s, 'north', { place: 'frigate', at: 'a3', facing: 'west' }))).toBe('BAD_FACING');
    expect(codeOf(() => turn.apply(s, 'north', { place: 'frigate', at: 'a3' }))).toBe('BAD_FACING');
    expect(codeOf(() => place(s, 'north', 'frigate', 'g3'))).toBe('OFF_SEA');
    expect(codeOf(() => place(s, 'north', 'frigate', 'a7', 'north'))).toBe('OFF_SEA');
    expect(codeOf(() => place(s, 'north', 'frigate', 'b1', 'north'))).toBe('OVERLAP');
    expect(codeOf(() => place(s, 'nobody', 'frigate', 'a3'))).toBe('NOT_YOUR_TURN');
    let done = s;
    for (const [ship, at] of STANDARD.slice(1)) done = place(done, 'north', ship, at);
    expect(codeOf(() => place(done, 'north', 'frigate', 'e5'))).toBe('NOT_YOUR_TURN');
    expect(turn.legal(done, 'north')).toEqual([]);
    expect(done.ready).toEqual(['north']);
  });
  test('random places every ship still in port, the same way every time', () => {
    const s = place(fresh(4, 42), 'north', 'cruiser', 'a1');
    const a = turn.apply(s, 'north', { place: 'random' });
    const b = turn.apply(s, 'north', { place: 'random' });
    expect(a).toEqual(b);
    expect(a.draws).toBe(1);
    expect(a.fleets.north.map((x) => x.id)).toEqual(['cruiser', 'destroyer', 'frigate', 'submarine']);
    expect(a.fleets.north[0].cells).toEqual(['a1', 'b1', 'c1', 'd1']);
    const cells = a.fleets.north.flatMap((x) => x.cells);
    expect(new Set(cells).size).toBe(12);
    for (const ship of a.fleets.north) {
      const length = SHIPS.find((x) => x.id === ship.id)!.length;
      const facing = ship.cells[1][0] === ship.cells[0][0] ? 'north' : 'east';
      expect(hullCells(ship.cells[0], length, facing)).toEqual(ship.cells);
    }
    // the next use of the rng draws differently
    const c = turn.apply(a, 'east', { place: 'random' });
    expect(c.draws).toBe(2);
    expect(c.fleets.east).not.toEqual(turn.apply(fresh(4, 42), 'east', { place: 'random' }).fleets.east);
    // a different seed, a different fleet
    const d = turn.apply(fresh(4, 43), 'north', { place: 'random' });
    const e = turn.apply(fresh(4, 42), 'north', { place: 'random' });
    expect(d.fleets.north).not.toEqual(e.fleets.north);
  });
  test('the first round opens when the last fleet is down', () => {
    let s = fresh(2);
    s = turn.apply(s, 'north', { place: 'random' });
    expect(s.phase).toBe('deploy');
    expect(turn.toMove(s)).toEqual(['east']);
    expect(s.ready).toEqual(['north']);
    s = turn.apply(s, 'east', { place: 'random' });
    expect(s.phase).toBe('fire');
    expect(s.round).toBe(1);
    expect(s.ready).toEqual([]);
    expect(turn.toMove(s)).toEqual(['north', 'east']);
    expect(turn.round(s)).toBe(1);
  });
});

describe('fire', () => {
  test('legal is one shell at each living opponent sea, per unshot cell, then a buoy per centre', () => {
    const s = deployed();
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    expect(legal).toHaveLength(192 + 108);
    expect(legal[0]).toEqual({ fire: 'shell', at: 'east', cell: 'a1' });
    expect(legal[63]).toEqual({ fire: 'shell', at: 'east', cell: 'h8' });
    expect(legal[64]).toEqual({ fire: 'shell', at: 'south', cell: 'a1' });
    expect(legal[192]).toEqual({ fire: 'buoy', at: 'east', cell: 'b2' });
    expect(legal.at(-1)).toEqual({ fire: 'buoy', at: 'west', cell: 'g7' });
    expect(turn.legal(deployed(3), 'north')).toHaveLength(128 + 72);
    expect(turn.legal(deployed(2), 'north')).toHaveLength(64 + 36);
    const next = volley(s, { north: ['east', 'h8'], east: ['north', 'h8'], south: ['north', 'h7'], west: ['north', 'h6'] });
    // north's h8 at east and its three fillers at west (e8, e7, e6) are spent
    expect(shellsOf(next, 'north')).toHaveLength(192 - 4);
    expect(turn.legal(next, 'south')).toContainEqual({ fire: 'shell', at: 'east', cell: 'h8' }); // someone else's shot is still yours to take
    expect(turn.legal(next, 'north')).not.toContainEqual({ fire: 'shell', at: 'east', cell: 'h8' });
  });
  test('illegal shells carry precise codes', () => {
    const s = deployed(3);
    expect(codeOf(() => fire(s, 'north', 'north', 'a1'))).toBe('BAD_TARGET');
    expect(codeOf(() => fire(s, 'north', 'west', 'a1'))).toBe('BAD_TARGET');
    expect(codeOf(() => fire(s, 'north', 'up', 'a1'))).toBe('BAD_TARGET');
    expect(codeOf(() => fire(s, 'north', 'east', 'k1'))).toBe('BAD_CELL');
    expect(codeOf(() => turn.apply(s, 'north', { fire: 'torpedo', at: 'east', cell: 'a1' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(s, 'north', { fire: 'shell', at: 'east' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(s, 'north', { place: 'random' }))).toBe('BAD_COMMAND');
    const aimed = fire(s, 'north', 'east', 'e5');
    expect(codeOf(() => fire(aimed, 'north', 'east', 'E5'))).toBe('ALREADY_AIMED');
    const ready = salvo(s, 'north', [['east', 'e5']]);
    expect(codeOf(() => fire(ready, 'north', 'east', 'e6'))).toBe('NOT_YOUR_TURN');
    expect(turn.legal(ready, 'north')).toEqual([]);
    const next = volley(s, { north: ['east', 'e5'], east: ['north', 'e5'], south: ['north', 'e6'] });
    expect(codeOf(() => fire(next, 'north', 'east', 'E5'))).toBe('ALREADY_FIRED');
    expect(fire(next, 'south', 'east', 'e5').pending.south).toEqual([{ kind: 'shell', from: 'south', sea: 'east', cell: 'e5' }]);
  });
  test('a round resolves only when the last seat commits', () => {
    let s = deployed();
    s = salvo(s, 'west', [['north', 'h8']]);
    s = salvo(s, 'north', [['east', 'a1']]);
    s = salvo(s, 'south', [['east', 'h8']]);
    expect(s.round).toBe(1);
    expect(s.ready).toEqual(['north', 'south', 'west']);
    expect(turn.toMove(s)).toEqual(['east']);
    // east's first three shots leave it owing; nothing has landed
    for (const cell of ['a1', 'b1', 'c1']) s = fire(s, 'east', 'north', cell);
    expect(s.round).toBe(1);
    expect(turn.toMove(s)).toEqual(['east']);
    expect(s.lastVolley).toBeNull();
    expect(s.shots.east).toEqual({});
    expect(s.shots.north).toEqual({});
    s = fire(s, 'east', 'north', 'd1');
    expect(s.round).toBe(2);
    expect(s.ready).toEqual([]);
    expect(Object.values(s.pending).every((p) => p.length === 0)).toBe(true);
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south', 'west']);
    expect(s.lastVolley!.round).toBe(1);
    // seat order, each seat's shots in the order sent
    expect(s.lastVolley!.shells.map((x) => x.from)).toEqual(SEATS.flatMap((x) => [x, x, x, x]));
    expect(s.lastVolley!.shells.filter((x) => x.from === 'east').map((x) => x.cell)).toEqual(['a1', 'b1', 'c1', 'd1']);
  });
  test('hits, misses and a sinking', () => {
    let s = deployed(2);
    preHit(s, 'east', ['a7'], 'north');
    s = volley(s, { north: ['east', 'b7'], east: ['north', 'a1'] });
    expect(s.lastVolley!.shells.filter((x) => x.result !== 'miss')).toEqual([
      { from: 'north', sea: 'east', cell: 'b7', result: 'sunk', ship: 'submarine', blast: false },
      { from: 'east', sea: 'north', cell: 'a1', result: 'hit', ship: null, blast: false },
    ]);
    // the fillers, open water
    expect(missesOf(s)).toEqual(['north east e8', 'north east e7', 'north east e6', 'east north f8', 'east north f7', 'east north f6']);
    expect(s.lastVolley!.sunk).toEqual([{ sea: 'east', ship: 'submarine', by: ['north'] }]);
    expect(s.fleets.east.find((x) => x.id === 'submarine')!.hits).toEqual(['a7', 'b7']);
    expect(s.shots.east.b7).toEqual({ result: 'hit', by: ['north'] });
    expect(s.scrap).toEqual({ north: 1 + 3, east: 1 });
    expect(s.hitsLanded).toEqual({ north: 1, east: 1 });
  });
  test('a miss, and a shell on a cell someone already hit lands as a hit with no new scrap', () => {
    let s = deployed(3);
    s = volley(s, { north: ['east', 'h8'], east: ['north', 'a1'], south: ['north', 'b2'] });
    expect(s.lastVolley!.shells[0]).toMatchObject({ from: 'north', sea: 'east', cell: 'h8', result: 'miss' });
    expect(s.shots.east.h8).toEqual({ result: 'miss', by: ['north'] });
    expect(s.shots.north.a1).toEqual({ result: 'hit', by: ['east'] });
    s = volley(s, { north: ['east', 'g8'], east: ['north', 'b8'], south: ['north', 'a1'] });
    expect(s.lastVolley!.shells.find((x) => x.from === 'south' && x.cell === 'a1')).toEqual({ from: 'south', sea: 'north', cell: 'a1', result: 'hit', ship: null, blast: false });
    expect(s.scrap.south).toBe(0);
    expect(s.hitsLanded.south).toBe(0);
    expect(s.shots.north.a1.by).toEqual(['east', 'south']);
    expect(s.fleets.north[0].hits).toEqual(['a1']);
  });
  test('Time on Target: two shells on one cell hit all nine, credited to both', () => {
    let s = deployed();
    s = volley(s, { north: ['east', 'b2'], east: ['north', 'h8'], south: ['east', 'b2'], west: ['east', 'e5'] });
    const v = s.lastVolley!;
    expect(v.blasts).toEqual([
      { sea: 'east', cell: 'b2', by: ['north', 'south'], cells: ['b2', 'a1', 'b1', 'c1', 'a2', 'c2', 'a3', 'b3', 'c3'], hits: ['a1', 'b1', 'c1', 'a3', 'b3', 'c3'] },
    ]);
    expect(v.shells.filter((x) => x.blast).map((x) => x.from)).toEqual(['north', 'south']);
    expect(v.shells.find((x) => x.from === 'north')).toEqual({ from: 'north', sea: 'east', cell: 'b2', result: 'miss', ship: null, blast: true });
    expect(v.sunk).toEqual([{ sea: 'east', ship: 'destroyer', by: ['north', 'south'] }]);
    // six hits and one sinking each
    expect(s.scrap).toEqual({ north: 9, east: 0, south: 9, west: 0 });
    expect(s.hitsLanded).toEqual({ north: 6, east: 0, south: 6, west: 0 });
    for (const cell of ['a1', 'b2', 'c3']) expect(s.shots.east[cell].by).toEqual(['north', 'south']);
    expect(s.shots.east.b2.result).toBe('miss');
    // a lone shell hits one cell only (every filler went at west's or south's sea)
    expect(s.shots.east.e5).toEqual({ result: 'miss', by: ['west'] });
    expect(Object.keys(s.shots.east)).toHaveLength(10);
    // blast cells leave the shooters' legal, as do their three fillers each
    expect(shellsOf(s, 'north')).toHaveLength(192 - 9 - 3);
    expect(shellsOf(s, 'west')).toHaveLength(192 - 1 - 3);
  });
  test('a sinking shared by two lone shells credits both', () => {
    let s = deployed(3);
    preHit(s, 'east', ['a3']);
    s = volley(s, { north: ['east', 'b3'], east: ['north', 'h8'], south: ['east', 'c3'] });
    expect(s.lastVolley!.sunk).toEqual([{ sea: 'east', ship: 'destroyer', by: ['north', 'south'] }]);
    expect(s.lastVolley!.shells.filter((x) => x.result === 'sunk').map((x) => x.from)).toEqual(['north', 'south']);
    expect(s.scrap.north).toBe(4);
    expect(s.scrap.south).toBe(4);
  });
});

describe('one shot per ship afloat', () => {
  test('a full fleet fires four; a seat fires one fewer the round after a sinking', () => {
    let s = deployed(2);
    expect(viewOf(s, 'north').guns).toEqual({ north: 4, east: 4 });
    preHit(s, 'east', ['a7'], 'north');
    s = volley(s, { north: ['east', 'b7'] });
    expect(s.round).toBe(2);
    expect(viewOf(s, 'east').guns).toEqual({ north: 4, east: 3 });
    for (const cell of ['h1', 'h2']) s = fire(s, 'east', 'north', cell);
    expect(s.ready).toEqual([]);
    s = fire(s, 'east', 'north', 'h3');
    expect(s.ready).toEqual(['east']);
    expect(turn.toMove(s)).toEqual(['north']);
  });
  test('a seat owes until its last shot: toMove, ready and legal across a partial salvo', () => {
    let s = deployed(3);
    for (const [k, cell] of ['e5', 'e6', 'e7'].entries()) {
      s = fire(s, 'north', 'east', cell);
      expect(s.pending.north).toHaveLength(k + 1);
      expect(s.ready).toEqual([]);
      expect(turn.toMove(s)).toEqual(['north', 'east', 'south']);
      expect(turn.legal(s, 'north').length).toBeGreaterThan(0);
    }
    s = fire(s, 'north', 'east', 'e8');
    expect(s.ready).toEqual(['north']);
    expect(turn.toMove(s)).toEqual(['east', 'south']);
    expect(turn.legal(s, 'north')).toEqual([]);
    expect(codeOf(() => fire(s, 'north', 'east', 'e4'))).toBe('NOT_YOUR_TURN');
    expect(s.round).toBe(1);
  });
  test('a seat down to one ship fires one shot and is ready', () => {
    let s = deployed(3);
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'd1'));
    expect(viewOf(s, null).guns).toEqual({ north: 4, east: 1, south: 4 });
    s = fire(s, 'east', 'north', 'h8');
    expect(s.ready).toEqual(['east']);
    expect(turn.legal(s, 'east')).toEqual([]);
  });
  test('one buoy a round: a second is refused and legal drops buoys once one is queued', () => {
    const s = deployed();
    const one = buoy(s, 'north', 'east', 'b2');
    expect(codeOf(() => buoy(one, 'north', 'east', 'c3'))).toBe('ONE_BUOY');
    expect(codeOf(() => buoy(one, 'north', 'south', 'b2'))).toBe('ONE_BUOY');
    const legal = turn.legal(one, 'north') as SalvoCommand[];
    expect(legal.some((c) => 'fire' in c && c.fire === 'buoy')).toBe(false);
    expect(legal).toHaveLength(192);
    // a shell still may go where the buoy fell
    expect(fire(one, 'north', 'east', 'b2').pending.north).toHaveLength(2);
    // next round a buoy is legal again (a new centre)
    const next = volley(one, {});
    expect(next.round).toBe(2);
    expect(turn.legal(next, 'north')).toContainEqual({ fire: 'buoy', at: 'east', cell: 'c3' });
    expect(buoy(next, 'north', 'east', 'c3').pending.north).toHaveLength(1);
  });
  test('two shells of one salvo may not share a cell; the same cell on another sea is fine', () => {
    const s = fire(deployed(), 'north', 'east', 'e5');
    expect(codeOf(() => fire(s, 'north', 'east', 'e5'))).toBe('ALREADY_AIMED');
    expect(codeOf(() => fire(s, 'north', 'east', ' E5 '))).toBe('ALREADY_AIMED');
    expect(turn.legal(s, 'north')).not.toContainEqual({ fire: 'shell', at: 'east', cell: 'e5' });
    expect(fire(s, 'north', 'south', 'e5').pending.north).toHaveLength(2);
    // a buoy on an aimed cell is not a second shell
    expect(buoy(s, 'north', 'east', 'e5').pending.north.map((x) => x.kind)).toEqual(['shell', 'buoy']);
    // someone else may aim the same cell
    expect(fire(s, 'south', 'east', 'e5').pending.south).toHaveLength(1);
  });
  test('legal shrinks as the salvo is queued: no repeated cell, no second buoy', () => {
    let s = deployed();
    expect(turn.legal(s, 'north')).toHaveLength(192 + 108);
    s = fire(s, 'north', 'east', 'e5');
    expect(turn.legal(s, 'north')).toHaveLength(191 + 108);
    s = buoy(s, 'north', 'west', 'c3');
    expect(turn.legal(s, 'north')).toHaveLength(191);
    s = fire(s, 'north', 'west', 'c3');
    expect(turn.legal(s, 'north')).toHaveLength(190);
    expect(turn.legal(s, 'north')).not.toContainEqual({ fire: 'shell', at: 'west', cell: 'c3' });
    // another seat's legal is untouched by north's queue
    expect(turn.legal(s, 'south')).toHaveLength(192 + 108);
  });
  test("myOrders shows the viewer's own queued shots and nobody else's; ascii counts the salvo", () => {
    let s = deployed();
    s = fire(s, 'north', 'east', 'e5');
    s = buoy(s, 'north', 'east', 'c3');
    s = fire(s, 'south', 'west', 'g2');
    const north = viewOf(s, 'north');
    expect(north.myOrders).toEqual([
      { fire: 'shell', at: 'east', cell: 'e5' },
      { fire: 'buoy', at: 'east', cell: 'c3' },
    ]);
    expect(north.ascii).toContain('Your salvo: 2 of 4 sent (shell at east e5, buoy at east c3).');
    expect(north.ascii).toContain('Shots this round (one per ship afloat): north 4, east 4, south 4, west 4.');
    expect(viewOf(s, 'south').myOrders).toEqual([{ fire: 'shell', at: 'west', cell: 'g2' }]);
    expect(viewOf(s, 'east').myOrders).toEqual([]);
    expect(viewOf(s, 'east').ascii).toContain('Your salvo: 0 of 4 sent.');
    const spectator = viewOf(s, null);
    expect(spectator.myOrders).toEqual([]);
    expect(spectator.ascii).not.toContain('Your salvo');
    // once the volley lands the queue is empty again
    s = volley(s, {});
    expect(s.round).toBe(2);
    for (const seat of [null, ...s.seats]) expect(viewOf(s, seat).myOrders).toEqual([]);
  });
  test('guns are public, count living seats only, and are empty outside the fire phase', () => {
    expect(viewOf(fresh(), 'north').guns).toEqual({});
    let s = deployed(3);
    preHit(s, 'south', ['a1', 'b1', 'c1', 'd1', 'a7', 'b7']);
    for (const seat of [null, ...s.seats]) expect(viewOf(s, seat).guns).toEqual({ north: 4, east: 4, south: 2 });
    s = G.forfeit(s, 'east', 'resign');
    expect(viewOf(s, 'north').guns).toEqual({ north: 4, south: 2 });
    s = G.forfeit(s, 'south', 'resign');
    expect(viewOf(s, 'north').guns).toEqual({});
  });
  test("a forfeit mid-salvo drops that seat's queued shots and resolves the round if everyone else is in", () => {
    let s = deployed(3);
    s = fire(s, 'east', 'north', 'a1');
    s = fire(s, 'east', 'north', 'b1');
    s = salvo(s, 'north', [['east', 'a3']]);
    s = salvo(s, 'south', [['east', 'b3']]);
    expect(s.round).toBe(1);
    expect(turn.toMove(s)).toEqual(['east']);
    s = G.forfeit(s, 'east', 'timeout');
    expect(s.round).toBe(2);
    expect(s.lastVolley!.shells.some((x) => x.from === 'east')).toBe(false);
    expect(s.lastVolley!.shells).toHaveLength(8);
    expect(s.shots.north).toEqual({});
    expect(s.shots.east.a3).toEqual({ result: 'hit', by: ['north'] });
    expect(Object.values(s.pending).every((p) => p.length === 0)).toBe(true);
    expect(turn.toMove(s)).toEqual(['north', 'south']);
  });
  test('two shells from one seat on neighbouring cells are no Time on Target', () => {
    let s = deployed(2);
    s = volley(s, { north: [['east', 'a1'], ['east', 'b1'], ['east', 'c1'], ['east', 'd1']] });
    const v = s.lastVolley!;
    expect(v.blasts).toEqual([]);
    expect(v.shells.filter((x) => x.from === 'north').every((x) => !x.blast)).toBe(true);
    // four cells, nothing around them
    expect(Object.keys(s.shots.east).sort()).toEqual(['a1', 'b1', 'c1', 'd1']);
    expect(v.sunk).toEqual([{ sea: 'east', ship: 'cruiser', by: ['north'] }]);
    expect(s.scrap.north).toBe(4 + 3);
    expect(roundSummary(deployed(2), s)).toEqual(["Round 1: {north} sinks {east}'s cruiser and 4 misses.", '{north} pulls a crate from the wreck.']);
  });
  test('the summary counts misses rather than naming them', () => {
    const s = deployed(2);
    expect(roundSummary(s, volley(s, {}))).toEqual(['Round 1: 8 misses.']);
    // one gun each: east hits a cell already hit, north misses once
    const t = deployed(2);
    preHit(t, 'north', SHIP_CELLS.filter((c) => c !== 'd1'));
    preHit(t, 'east', SHIP_CELLS.slice(4));
    const after = volley(t, { north: ['east', 'h8'], east: ['north', 'a1'] });
    expect(roundSummary(t, after)).toEqual(['Round 1: {east} hits {north} at a1 and 1 miss.']);
  });
});

describe('elimination and the end', () => {
  /** East is down to one ship cell: everything hit but d1. */
  const nearlySunk = (n: number, sea = 'east') => {
    const s = deployed(n);
    preHit(s, sea, SHIP_CELLS.filter((c) => c !== 'd1'));
    return s;
  };

  test('sinking the last ship eliminates a seat and pays half its scrap to the sinker', () => {
    let s = nearlySunk(3);
    s.scrap.east = 7;
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'h8'], south: ['north', 'h7'] });
    expect(s.eliminated).toEqual([{ seat: 'east', round: 1, reason: 'sunk' }]);
    expect(s.lastVolley!.eliminated).toEqual(['east']);
    expect(s.scrap.north).toBe(1 + 3 + 3); // hit, sinking, half of seven
    expect(G.isOut!(s, 'east')).toBe(true);
    expect(G.isOut!(s, 'north')).toBe(false);
    expect(s.phase).toBe('fire');
    expect(s.winner).toBeNull();
    // east is a ghost now and owes a trick
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south']);
    expect(codeOf(() => fire(s, 'north', 'east', 'e5'))).toBe('BAD_TARGET');
    // south's sea alone, less north's three fillers there
    expect(shellsOf(s, 'north')).toHaveLength(64 - 3);
    expect(G.outcome(s)).toBeNull();
  });
  test('the last fleet afloat wins', () => {
    let s = nearlySunk(2);
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'h8'] });
    expect(s.phase).toBe('over');
    expect(s.winner).toBe('north');
    expect(s.endReason).toBe('last-afloat');
    expect(G.outcome(s)).toEqual({ winners: ['north'], placement: [['north'], ['east']], reason: 'last-afloat' });
    expect(turn.toMove(s)).toEqual([]);
    expect(turn.legal(s, 'north')).toEqual([]);
    expect(codeOf(() => fire(s, 'north', 'east', 'e5'))).toBe('GAME_OVER');
    expect(codeOf(() => place(s, 'north', 'cruiser', 'e5'))).toBe('GAME_OVER');
  });
  test('placement is elimination order, last out best', () => {
    let s = nearlySunk(4);
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'h8'], south: ['north', 'h7'], west: ['north', 'h6'] });
    s = haunt(volley(s, { north: ['west', 'd1'], south: ['north', 'g7'] })); // west's salvo is already in (the helper's filler)
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = haunt(volley(s, { north: ['south', 'd1'], south: ['north', 'f7'] }));
    expect(s.lastVolley!.tricks).toEqual([]); // the ghosts' mines never went off
    expect(s.mines.map((m) => `${m.ghost} ${m.sea} ${m.cell}`)).toEqual(['east north a1', 'east north b1', 'west north a1']);
    expect(G.outcome(s)).toEqual({ winners: ['north'], placement: [['north'], ['south'], ['west'], ['east']], reason: 'last-afloat' });
  });
  test('the last fleets sinking together go to the tiebreak: scrap first', () => {
    let s = nearlySunk(2, 'east');
    preHit(s, 'north', SHIP_CELLS.filter((c) => c !== 'd1'));
    s.scrap.east = 5;
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'd1'] });
    expect(s.lastVolley!.eliminated).toEqual(['north', 'east']);
    expect(s.winner).toBe('east');
    expect(s.endReason).toBe('tiebreak');
    expect(s.eliminated.map((x) => x.seat)).toEqual(['north']);
    expect(G.isOut!(s, 'east')).toBe(false);
    expect(G.outcome(s)).toEqual({ winners: ['east'], placement: [['east'], ['north']], reason: 'tiebreak' });
  });
  test('the tiebreak falls to hits landed, then a seeded coin flip', () => {
    let s = nearlySunk(2, 'east');
    preHit(s, 'north', SHIP_CELLS.filter((c) => c !== 'd1'));
    s.hitsLanded.north = 3;
    const byHits = volley(structuredClone(s), { north: ['east', 'd1'], east: ['north', 'd1'] });
    expect(byHits.winner).toBe('north');
    s.hitsLanded.north = 0;
    const flipped = volley(structuredClone(s), { north: ['east', 'd1'], east: ['north', 'd1'] });
    expect(flipped.endReason).toBe('tiebreak');
    expect(['north', 'east']).toContain(flipped.winner!);
    expect(volley(structuredClone(s), { north: ['east', 'd1'], east: ['north', 'd1'] }).winner).toBe(flipped.winner);
    const winners = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const t = structuredClone(s);
      t.seed = seed;
      winners.add(volley(t, { north: ['east', 'd1'], east: ['north', 'd1'] }).winner!);
    }
    expect(winners.size).toBe(2);
  });
  test('three fleets down together: one winner, the others share second', () => {
    let s = deployed(3);
    for (const sea of s.seats) preHit(s, sea, SHIP_CELLS.filter((c) => c !== 'd1'));
    s.scrap.south = 2;
    s = volley(s, { north: ['east', 'd1'], east: ['south', 'd1'], south: ['north', 'd1'] });
    expect(s.winner).toBe('south');
    expect(G.outcome(s)).toEqual({ winners: ['south'], placement: [['south'], ['north', 'east']], reason: 'tiebreak' });
  });
  test('a knockout pays half the victim scrap counted before anyone is paid', () => {
    let s = deployed(2);
    for (const sea of s.seats) preHit(s, sea, SHIP_CELLS.filter((c) => c !== 'd1'));
    s.scrap.north = 10;
    s.scrap.east = 4;
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'd1'] });
    // north: 10 + 1 hit + 3 sink + half of east's 8 = 18; east: 4 + 4 + half of north's 14 = 15
    expect(s.scrap).toEqual({ north: 18, east: 15 });
    expect(s.winner).toBe('north');
  });
  test('the round cap ends it: most ship cells afloat wins', () => {
    let s = deployed(3);
    s.round = ROUND_CAP;
    preHit(s, 'north', ['a1']);
    preHit(s, 'east', ['a1', 'b1']);
    s = volley(s, { north: ['east', 'h8'], east: ['north', 'h8'], south: ['north', 'h7'] });
    expect(s.phase).toBe('over');
    expect(s.round).toBe(ROUND_CAP);
    expect(s.winner).toBe('south');
    expect(G.outcome(s)).toEqual({ winners: ['south'], placement: [['south'], ['north', 'east']], reason: 'round-cap' });
  });
  test('the round cap with equal fleets falls to the tiebreak order', () => {
    let s = deployed(2);
    s.round = ROUND_CAP;
    s.scrap.east = 1;
    s = volley(s, { north: ['east', 'h8'], east: ['north', 'h8'] });
    expect(s.winner).toBe('east');
    expect(s.endReason).toBe('round-cap');
  });
});

describe('forfeit', () => {
  test('during deployment: out, and the round opens once the rest are down', () => {
    let s = fresh(3);
    s = turn.apply(s, 'north', { place: 'random' });
    s = turn.apply(s, 'south', { place: 'random' });
    s = place(s, 'east', 'cruiser', 'a1');
    s = G.forfeit(s, 'east', 'resign');
    expect(s.eliminated).toEqual([{ seat: 'east', round: 0, reason: 'resign' }]);
    expect(s.phase).toBe('fire');
    expect(s.round).toBe(1);
    expect(s.fleets.east).toHaveLength(1); // the wreck stays
    expect(turn.toMove(s)).toEqual(['north', 'south']);
  });
  test('during deployment with two seats: the other wins', () => {
    const s = G.forfeit(fresh(2), 'north', 'timeout');
    expect(G.outcome(s)).toEqual({ winners: ['east'], placement: [['east'], ['north']], reason: 'timeout' });
    expect(s.phase).toBe('over');
  });
  test('during fire: shells in the air still land, and the round resolves', () => {
    let s = deployed(3);
    s = salvo(s, 'north', [['east', 'a1']]);
    s = salvo(s, 'south', [['east', 'b1']]);
    expect(s.round).toBe(1);
    s = G.forfeit(s, 'east', 'disconnect');
    expect(s.round).toBe(2);
    expect(s.lastVolley!.shells.filter((x) => x.result !== 'miss').map((x) => [x.from, x.sea, x.cell, x.result])).toEqual([
      ['north', 'east', 'a1', 'hit'],
      ['south', 'east', 'b1', 'hit'],
    ]);
    expect(missesOf(s)).toEqual(['north south e8', 'north south e7', 'north south e6', 'south east g8', 'south east g7', 'south east g6']);
    expect(s.scrap).toEqual({ north: 1, east: 0, south: 1 });
    expect(s.eliminated).toEqual([{ seat: 'east', round: 1, reason: 'disconnect' }]);
    expect(turn.toMove(s)).toEqual(['north', 'south']);
  });
  test('a forfeiting seat that had fired loses its shells', () => {
    let s = deployed(3);
    s = salvo(s, 'east', [['north', 'a1']]);
    s = G.forfeit(s, 'east', 'resign');
    expect(s.pending.east).toEqual([]);
    expect(s.ready).toEqual([]);
    expect(s.round).toBe(1);
  });
  test('down to one: the last seat wins with the forfeit reason', () => {
    let s = deployed(2);
    s = fire(s, 'north', 'east', 'a1');
    s = G.forfeit(s, 'east', 'resign');
    expect(G.outcome(s)).toEqual({ winners: ['north'], placement: [['north'], ['east']], reason: 'resign' });
    expect(turn.toMove(s)).toEqual([]);
  });
  test('no-op when already out or over', () => {
    const s = G.forfeit(deployed(3), 'east', 'resign');
    expect(G.forfeit(s, 'east', 'timeout')).toEqual(s);
    const over = G.forfeit(s, 'north', 'resign');
    expect(G.forfeit(over, 'south', 'resign')).toEqual(over);
  });
});

describe('immutability', () => {
  test('apply and forfeit leave their input untouched', () => {
    const s = fresh();
    const before = JSON.stringify(s);
    place(s, 'north', 'cruiser', 'a1');
    turn.apply(s, 'north', { place: 'random' });
    G.forfeit(s, 'north', 'resign');
    expect(JSON.stringify(s)).toBe(before);
    let f = deployed();
    f = salvo(f, 'north', [['east', 'b2']]);
    f = salvo(f, 'east', [['north', 'a1']]);
    f = salvo(f, 'south', [['east', 'b2']]);
    for (const cell of ['a2', 'a4', 'a6']) f = fire(f, 'west', 'north', cell);
    const mid = JSON.stringify(f);
    fire(f, 'west', 'north', 'a8'); // west's last shot resolves the round
    G.forfeit(f, 'west', 'resign');
    expect(JSON.stringify(f)).toBe(mid);
  });
});

describe('narration keeps secrets', () => {
  const SECRET = /\b[a-h][1-8]\b|north|east|south|west|cruiser|destroyer|frigate|submarine/i;
  test('describe and narrate never name a cell, sea or ship', () => {
    const s = fresh();
    const commands: SalvoCommand[] = [
      { place: 'cruiser', at: 'c3', facing: 'north' },
      { place: 'random' },
    ];
    expect(turn.describe!(commands[0])).toBe('deploys a ship');
    expect(turn.describe!(commands[1])).toBe('deploys the fleet');
    expect(turn.describe!({ fire: 'shell', at: 'east', cell: 'e5' })).toBe('fires');
    expect(turn.narrate!(s, place(s, 'north', 'cruiser', 'c3', 'north'), 'north', commands[0])).toBe('deploys a ship');
    expect(turn.narrate!(s, turn.apply(s, 'north', commands[1]), 'north', commands[1])).toBe('deploys the fleet');
    const f = deployed();
    const cmd = { fire: 'shell', at: 'east', cell: 'e5' };
    expect(turn.narrate!(f, turn.apply(f, 'north', cmd), 'north', cmd)).toBe('is ready');
    for (const text of [turn.describe!(cmd), turn.describe!(commands[0]), turn.describe!(commands[1])]) expect(text).not.toMatch(SECRET);
  });
});

describe('roundSummary', () => {
  test('silent within a round', () => {
    const s = deployed();
    expect(roundSummary(s, fire(s, 'north', 'east', 'e5'))).toEqual([]);
    const d = fresh(2);
    expect(roundSummary(d, turn.apply(d, 'north', { place: 'random' }))).toEqual([]);
  });
  test('the end of deployment', () => {
    const d = turn.apply(fresh(2), 'north', { place: 'random' });
    expect(turn.roundSummary(d, turn.apply(d, 'east', { place: 'random' }))).toEqual(['All fleets are down. Round 1 begins.']);
  });
  test('a round with hits, misses, a sinking and a Time on Target', () => {
    let s = deployed();
    preHit(s, 'north', ['a7']);
    const before = s;
    s = volley(s, { north: ['east', 'b2'], east: ['north', 'b7'], south: ['east', 'b2'], west: ['south', 'h8'] });
    // misses: three fillers each from north, east and south, and west's h8 with its three
    expect(roundSummary(before, s)).toEqual([
      "Round 1: {east} sinks {north}'s submarine and 13 misses.",
      'Time on Target at {east} b2 by {north} and {south}: 9 cells, 6 hits.',
      "{north} and {south} sink {east}'s destroyer.",
      '{east} pulls a crate from the wreck.',
      '{north} pulls a crate from the wreck.',
      '{south} pulls a crate from the wreck.',
    ]);
  });
  test('hits name the cell; eliminations and a fog line', () => {
    let s = deployed(3);
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'd1'));
    s.round = FOG_FROM - 1;
    const before = s;
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'a1'], south: ['north', 'h8'] });
    expect(roundSummary(before, s)).toEqual([
      // east's one gun hits; north's three fillers, south's h8 and its three fillers miss
      `Round ${FOG_FROM - 1}: {north} sinks {east}'s cruiser, {east} hits {north} at a1 and 7 misses.`,
      '{north} pulls a crate from the wreck.',
      '{east} is out, and comes back as a ghost.',
      'The fog lifts from row 8.',
    ]);
  });
  test('the verdicts', () => {
    let s = deployed(2);
    for (const sea of s.seats) preHit(s, sea, SHIP_CELLS.filter((c) => c !== 'd1'));
    s.scrap.east = 5;
    const before = s;
    const after = volley(s, { north: ['east', 'd1'], east: ['north', 'd1'] });
    expect(roundSummary(before, after)).toEqual([
      "Round 1: {north} sinks {east}'s cruiser and {east} sinks {north}'s cruiser.",
      'Both fleets go down together. {east} had more scrap. {east} takes it.',
    ]);
    const lone = deployed(2);
    preHit(lone, 'east', SHIP_CELLS.filter((c) => c !== 'd1'));
    const won = volley(lone, { north: ['east', 'd1'], east: ['north', 'h8'] });
    expect(roundSummary(lone, won).slice(-2)).toEqual(['{east} is out.', '{north} is the last fleet afloat and takes it.']);
  });
});

describe('sonar buoys', () => {
  test('a buoy stands in for one shell of the salvo; the drop is secret until the volley', () => {
    const s = buoy(deployed(), 'north', 'east', 'b2');
    expect(s.pending.north).toEqual([{ kind: 'buoy', from: 'north', sea: 'east', cell: 'b2' }]);
    expect(s.ready).toEqual([]);
    const full = salvo(s, 'north');
    expect(full.pending.north).toHaveLength(4);
    expect(full.ready).toEqual(['north']);
    expect(turn.describe!({ fire: 'buoy', at: 'east', cell: 'b2' })).toBe('fires');
    expect(turn.narrate!(deployed(), s, 'north', { fire: 'buoy', at: 'east', cell: 'b2' })).toBe('is ready');
    for (const other of ['east', 'south', 'west', null]) expect(JSON.stringify(viewOf(full, other))).not.toContain('buoy');
  });
  test('illegal buoys carry precise codes', () => {
    const s = deployed();
    expect(codeOf(() => buoy(s, 'north', 'east', 'a1'))).toBe('BAD_BUOY');
    expect(codeOf(() => buoy(s, 'north', 'east', 'h5'))).toBe('BAD_BUOY');
    expect(codeOf(() => buoy(s, 'north', 'north', 'b2'))).toBe('BAD_TARGET');
    expect(codeOf(() => turn.apply(s, 'north', { fire: 'flare', at: 'east', cell: 'b2' }))).toBe('BAD_COMMAND');
    let next = buoy(s, 'north', 'east', 'b2');
    expect(codeOf(() => buoy(next, 'north', 'south', 'c3'))).toBe('ONE_BUOY');
    next = volley(next, { east: ['north', 'h8'], south: ['north', 'h7'], west: ['north', 'h6'] });
    expect(codeOf(() => buoy(next, 'north', 'east', 'b2'))).toBe('ALREADY_BUOYED');
    expect(turn.legal(next, 'north')).not.toContainEqual({ fire: 'buoy', at: 'east', cell: 'b2' });
    expect(turn.legal(next, 'north')).toContainEqual({ fire: 'buoy', at: 'south', cell: 'b2' });
    // A buoy is not a shot: the cell is still yours to shoot.
    expect(turn.legal(next, 'north')).toContainEqual({ fire: 'shell', at: 'east', cell: 'b2' });
  });
  test('a buoy does no damage, scores nothing and is never part of a Time on Target', () => {
    let s = buoy(deployed(), 'north', 'east', 'b2');
    s = volley(s, { east: ['north', 'h8'], south: ['east', 'b2'], west: ['north', 'h6'] });
    // south's lone shell on b2 hits only b2; north's buoy on the same cell takes nothing with it.
    expect(s.lastVolley!.blasts).toEqual([]);
    // north's other three shots are fillers at west; nobody else's shell is on east's sea
    expect(s.lastVolley!.shells.filter((x) => x.sea === 'east').map((x) => [x.from, x.cell])).toEqual([['south', 'b2']]);
    expect(s.lastVolley!.shells.filter((x) => x.from === 'north')).toHaveLength(3);
    expect(s.lastVolley!.buoys).toEqual([{ from: 'north', sea: 'east', cell: 'b2' }]);
    expect(s.shots.east.b2).toEqual({ result: 'miss', by: ['south'] });
    expect(s.shots.east.a1).toBeUndefined();
    expect(s.scrap.north).toBe(0);
  });
  test("only the dropper hears it: the 3×3's ship cells afloat, after the shells, live after that", () => {
    let s = buoy(deployed(), 'north', 'east', 'b2');
    // b2's 3×3 is a1–c3: the cruiser's a1 b1 c1 and the destroyer's a3 b3 c3. west hits a1 in the same volley.
    s = volley(s, { east: ['north', 'h8'], south: ['north', 'h7'], west: ['east', 'a1'] });
    const reading = viewOf(s, 'north').targets.find((t) => t.sea === 'east')!.sonar;
    expect(reading).toEqual([{ cell: 'b2', round: 1, cells: buoyCells('b2'), afloat: 5 }]);
    for (const other of ['east', 'south', 'west', null]) {
      for (const t of viewOf(s, other).targets) expect(t.sonar).toEqual([]);
    }
    expect(JSON.stringify(viewOf(s, 'south'))).not.toMatch(/"afloat":5/);
    preHit(s, 'east', ['c3']);
    expect(viewOf(s, 'north').targets.find((t) => t.sea === 'east')!.sonar[0].afloat).toBe(4);
    expect(viewOf(s, 'north').ascii).toContain('Your sonar buoy at b2 (round 1) hears 4 ship cells afloat in a1–c3.');
  });
  test('the round summary says where a buoy fell, never what it heard', () => {
    const before = buoy(deployed(), 'north', 'east', 'b2');
    let s0 = salvo(before, 'north');
    s0 = salvo(s0, 'east', [['north', 'h8']]);
    s0 = salvo(s0, 'south', [['north', 'h7']]);
    for (const cell of ['h6', 'h5', 'h4']) s0 = fire(s0, 'west', 'north', cell);
    const after = fire(s0, 'west', 'north', 'h3');
    const lines = roundSummary(s0, after);
    expect(lines).toContain("{north} drops a sonar buoy on {east}'s sea at b2.");
    expect(lines.join(' ')).not.toMatch(/hears|afloat/);
  });
});

describe('views', () => {
  test('a seat sees its own fleet, its port, and the shots on its sea', () => {
    let s = fresh(2);
    s = place(s, 'north', 'cruiser', 'a1');
    const v = viewOf(s, 'north');
    expect(v.you).toBe('north');
    expect(v.phase).toBe('deploy');
    expect(v.mySea!.ships).toEqual([
      { id: 'cruiser', cells: ['a1', 'b1', 'c1', 'd1'], hits: [] },
      { id: 'destroyer', cells: [], hits: [] },
      { id: 'frigate', cells: [], hits: [] },
      { id: 'submarine', cells: [], hits: [] },
    ]);
    expect(v.mySea!.port).toEqual(['destroyer', 'frigate', 'submarine']);
    expect(v.targets.map((t) => t.sea)).toEqual(['east']);
    const e = viewOf(s, 'east');
    expect(JSON.stringify(e)).not.toContain('a1');
  });
  test('targets show your shots, public hits, misses, sinkings and afloat counts', () => {
    let s = deployed(3);
    preHit(s, 'east', ['a7'], 'south');
    s = volley(s, { north: ['east', 'b7'], east: ['north', 'a1'], south: ['east', 'h8'] });
    const v = viewOf(s, 'north');
    expect(v.round).toBe(2);
    expect(v.phase).toBe('fire');
    expect(v.mySea!.shots).toEqual({ a1: 'hit' });
    const east = v.targets.find((t) => t.sea === 'east')!;
    expect(east.mine).toEqual([{ cell: 'b7', result: 'sunk' }]);
    expect(east.hits).toEqual(['a7', 'b7']);
    // south's h8 and its fillers g8 g7 g6, in board order (north's fillers went at south)
    expect(east.misses).toEqual(['g6', 'g7', 'g8', 'h8']);
    expect(east.sunk).toEqual([{ ship: 'submarine', cells: ['a7', 'b7'] }]);
    expect(east.lifted).toEqual([]);
    expect(east.afloat).toBe(10);
    expect(east.revealed).toBeUndefined();
    expect(v.scrap).toEqual({ north: 4, east: 1, south: 0 });
    expect(v.lastVolley!.round).toBe(1);
  });
  test('the spectator view is public only while live', () => {
    let s = deployed(3);
    s = volley(s, { north: ['east', 'b7'], east: ['north', 'a1'], south: ['east', 'h8'] });
    const v = viewOf(s, null);
    expect(v.you).toBeNull();
    expect(v.mySea).toBeNull();
    expect(v.targets.map((t) => t.sea)).toEqual(['north', 'east', 'south']);
    const json = JSON.stringify(v.targets);
    expect(json).not.toContain('"cells":["a1","b1","c1","d1"]');
    expect(json).not.toContain('c3');
    expect(v.targets[0].hits).toEqual(['a1']);
    expect(v.targets[0].mine).toEqual([]);
    for (const line of v.ascii.split('\n').filter((l) => /^[1-8] /.test(l))) expect(line).not.toMatch(/[CDFS]/);
  });
  test('the fog lifts rows for everyone, as a count of ship cells afloat, never where', () => {
    const s = deployed(2);
    s.round = FOG_FROM + 1;
    const v = viewOf(s, null);
    expect(v.liftedRows).toEqual([8, 1]);
    expect(v.targets[0].lifted).toEqual([
      { row: 8, afloat: 0 },
      { row: 1, afloat: 4 },
    ]);
    // A hit in a lifted row counts down for everyone.
    preHit(s, 'east', ['b1']);
    expect(viewOf(s, 'north').targets[0].lifted[1]).toEqual({ row: 1, afloat: 3 });
    expect(JSON.stringify(v.targets[0].lifted)).not.toMatch(/[a-h][1-8]/);
  });
  test('everything is revealed once over, eliminated seas included', () => {
    let s = deployed(3);
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'a1'], south: ['north', 'h8'] });
    // East is out but stays on view, marked; it's no longer a target (nobody's legal names it).
    expect(viewOf(s, null).targets.map((t) => [t.sea, t.out])).toEqual([['north', false], ['east', true], ['south', false]]);
    expect((turn.legal(s, 'north') as SalvoCommand[]).some((c) => 'at' in c && c.at === 'east')).toBe(false);
    s = G.forfeit(s, 'south', 'resign');
    const spectator = viewOf(s, null);
    expect(spectator.targets.map((t) => t.sea)).toEqual(['north', 'east', 'south']);
    for (const t of spectator.targets) expect(t.revealed!.flatMap((x) => x.cells).sort()).toEqual([...SHIP_CELLS].sort());
    const north = viewOf(s, 'north');
    expect(north.targets.map((t) => t.sea)).toEqual(['east', 'south']);
    expect(north.targets[1].revealed).toHaveLength(4);
    expect(north.winner).toBe('north');
    expect(north.phase).toBe('over');
  });
  test("a seat never sees another fleet or anyone else's pending shot; its own are in myOrders alone", () => {
    let s = deployed();
    s = salvo(s, 'north', [['east', 'e5']]);
    s = fire(s, 'south', 'east', 'e5');
    const blank = { ...s, pending: { north: [], east: [], south: [], west: [] } };
    const strip = ({ myOrders: _o, ascii: _a, ...rest }: SalvoView) => rest;
    for (const seat of [null, ...s.seats]) {
      const v = viewOf(s, seat);
      expect(strip(v)).toEqual(strip(viewOf(blank, seat)));
      expect(v.ready).toEqual(['north']);
    }
    expect(viewOf(s, 'north').myOrders).toEqual([
      { fire: 'shell', at: 'east', cell: 'e5' },
      { fire: 'shell', at: 'west', cell: 'e8' },
      { fire: 'shell', at: 'west', cell: 'e7' },
      { fire: 'shell', at: 'west', cell: 'e6' },
    ]);
    expect(viewOf(s, 'south').myOrders).toEqual([{ fire: 'shell', at: 'east', cell: 'e5' }]);
    for (const seat of [null, 'east', 'west']) {
      expect(viewOf(s, seat).myOrders).toEqual([]);
      expect(JSON.stringify(viewOf(s, seat))).not.toContain('e5');
    }
    const east = viewOf(s, 'east');
    expect(JSON.stringify(east.targets)).not.toContain('d1');
  });
  test('ascii draws every sea, your own with ships', () => {
    let s = deployed(2);
    s = volley(s, { north: ['east', 'a1'], east: ['north', 'h8'] });
    const v = viewOf(s, 'north');
    const lines = v.ascii.split('\n');
    expect(lines).toContain('north (you), scrap 1, 12 ship cells afloat');
    expect(lines).toContain('east, scrap 0, 11 ship cells afloat');
    // east's h8 and its fillers f8 f7 f6 on north's sea; north's fillers e8 e7 e6 on east's
    expect(lines).toContain('8 . . . . . o . o');
    expect(lines).toContain('7 S S . . . o . .');
    expect(lines).toContain('1 C C C C . . . .');
    expect(lines).toContain('8 . . . . o . . .');
    expect(lines).toContain('1 X . . . . . . .');
    expect(lines).toContain('Shots this round (one per ship afloat): north 4, east 4.');
    expect(lines).toContain('Your salvo: 0 of 4 sent.');
    expect(v.ascii).toContain('X = hit');
    const spectator = viewOf(s, null).ascii;
    expect(spectator).not.toContain('(you)');
    for (const line of spectator.split('\n').filter((l) => /^[1-8] /.test(l))) expect(line).not.toMatch(/[CDFS]/);
  });
});

/** West's fleet all but sunk, then north sinks its last cell (b7): west is a ghost, three fleets afloat. */
function withGhost(n = 4): SalvoState {
  const s = deployed(n);
  preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
  return volley(s, { north: ['west', 'b7'] });
}
const trick = (s: SalvoState, seat: string, cmd: Record<string, unknown>) => turn.apply(s, seat, cmd);
type TrickCmd = { trick: 'mine' | 'splash'; at: string; cell: string; fool?: string };
const tricksOf = (s: SalvoState, seat: string) => (turn.legal(s, seat) as SalvoCommand[]).filter((c) => 'trick' in c) as TrickCmd[];

describe('ghosts', () => {
  test('a sunk fleet stays seated as a ghost and owes a trick', () => {
    const s = withGhost();
    expect(s.eliminated.map((x) => x.seat)).toEqual(['west']);
    expect(G.isOut!(s, 'west')).toBe(true);
    expect(G.stillSeated!(s, 'west')).toBe(true);
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south', 'west']);
    expect(viewOf(s, null).ghosts).toEqual(['west']);
    expect(viewOf(s, 'west').myTricks).toEqual({ mines: [], splashes: [], pending: null, whisper: null });
    expect(viewOf(s, 'north').myTricks).toBeNull();
  });

  test('a seat that resigns afloat is out and not a ghost', () => {
    const s = G.forfeit!(deployed(), 'west', 'resign');
    expect(G.stillSeated!(s, 'west')).toBe(false);
    expect(turn.toMove(s)).not.toContain('west');
    expect(viewOf(s, null).ghosts).toEqual([]);
  });

  test("a ghost's legal is mines on unshot cells of living seas, then splashes", () => {
    const s = withGhost();
    const legal = tricksOf(s, 'west');
    const mines = legal.filter((c) => c.trick === 'mine');
    const splashes = legal.filter((c) => c.trick === 'splash');
    const unshot = ['north', 'east', 'south'].reduce((n, sea) => n + 64 - Object.keys(s.shots[sea]).length, 0);
    expect(mines.length).toBe(unshot);
    expect(mines.every((c) => !s.shots[c.at][c.cell])).toBe(true);
    expect(splashes.every((c) => c.fool !== c.at && ['north', 'east', 'south'].includes(c.fool!))).toBe(true);
    expect(splashes.length).toBe(['north', 'east', 'south'].reduce((n, fool) => n + ['north', 'east', 'south'].filter((x) => x !== fool).reduce((m, sea) => m + 64 - Object.keys(s.shots[sea]).length, 0), 0));
    expect(mines.some((c) => c.at === 'east' && c.cell === 'a1')).toBe(true);
  });

  test('a trick makes the ghost ready; the living still owe', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    expect(s.ready).toEqual(['west']);
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south']);
    expect(turn.legal(s, 'west')).toEqual([]);
    expect(viewOf(s, 'west').myTricks!.pending).toEqual({ trick: 'mine', at: 'east', cell: 'e2' });
    expect(viewOf(s, 'east').myTricks).toBeNull();
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e3' }))).toBe('NOT_YOUR_TURN');
  });

  test("the ghost's trick is the last commit: it resolves the round", () => {
    let s = withGhost();
    const round = s.round;
    for (const seat of ['north', 'east', 'south']) s = salvo(s, seat);
    expect(s.round).toBe(round);
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    expect(s.round).toBe(round + 1);
  });

  test('illegal tricks carry precise codes', () => {
    const s = withGhost();
    expect(codeOf(() => trick(s, 'north', { trick: 'mine', at: 'east', cell: 'e2' }))).toBe('NOT_A_GHOST');
    expect(codeOf(() => trick(s, 'west', { fire: 'shell', at: 'east', cell: 'e2' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => trick(s, 'west', { trick: 'curse', at: 'east', cell: 'e2' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'west', cell: 'e2' }))).toBe('BAD_TARGET');
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: 'z9' }))).toBe('BAD_CELL');
    const shot = Object.keys(s.shots.east)[0] ?? null;
    if (shot) expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: shot }))).toBe('ALREADY_SHOT');
    expect(codeOf(() => trick(s, 'west', { trick: 'splash', fool: 'east', at: 'east', cell: 'e2' }))).toBe('BAD_FOOL');
    expect(codeOf(() => trick(s, 'west', { trick: 'splash', fool: 'west', at: 'east', cell: 'e2' }))).toBe('BAD_FOOL');
  });

  test('a ghost may hold three live mines; the fourth is refused and mines leave legal', () => {
    let s = withGhost();
    s.mines = [
      { ghost: 'west', sea: 'east', cell: 'h1', round: 1 },
      { ghost: 'west', sea: 'east', cell: 'h2', round: 1 },
      { ghost: 'west', sea: 'south', cell: 'h3', round: 1 },
    ];
    expect(MINE_LIMIT).toBe(3);
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'north', cell: 'h4' }))).toBe('MINE_LIMIT');
    expect(tricksOf(s, 'west').every((c) => c.trick !== 'mine')).toBe(true);
    s = { ...s, mines: s.mines.slice(0, 1) };
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: 'h1' }))).toBe('YOUR_MINE');
    s = { ...s, mines: [{ ghost: 'north', sea: 'east', cell: 'h5', round: 1 }] };
    expect(tricksOf(s, 'west').some((c) => c.trick === 'mine' && c.at === 'east' && c.cell === 'h5')).toBe(true);
  });

  test('a false splash needs three fleets afloat', () => {
    let s = deployed(3);
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['south', 'b7'] });
    expect(G.stillSeated!(s, 'south')).toBe(true);
    expect(codeOf(() => trick(s, 'south', { trick: 'splash', fool: 'north', at: 'east', cell: 'e2' }))).toBe('TOO_FEW');
    expect(tricksOf(s, 'south').every((c) => c.trick !== 'splash')).toBe(true);
  });

  test('a ghost with no trick sits out', () => {
    let s = deployed(3);
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['south', 'b7'] });
    s.mines = ['h1', 'h2', 'h3'].map((cell) => ({ ghost: 'south', sea: 'east', cell, round: 1 }));
    // A whisper is always on offer, unless its own auction is still running.
    s.auctions = [{ ghost: 'south', sea: 'east', centre: 'd4', cells: buoyCells('d4'), truth: 0, tell: null, opensRound: s.round, closesAt: null, bids: {}, abstained: [], state: 'sold', winner: 'north', price: 1, closedRound: s.round }];
    expect(tricksOf(s, 'south').every((c) => (c.trick as string) === 'whisper')).toBe(true);
    s.auctions[0] = { ...s.auctions[0], state: 'open', winner: null, closedRound: null };
    expect(turn.legal(s, 'south')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ tell: n })));
    expect(turn.toMove(s)).toEqual(['north', 'east']);
  });

  test('a ghost forfeit keeps placement, clears its tricks and resolves the round when it was last', () => {
    let s = withGhost();
    s.mines = [{ ghost: 'west', sea: 'east', cell: 'h1', round: 1 }];
    for (const seat of ['north', 'east', 'south']) s = salvo(s, seat);
    const round = s.round;
    const placementBefore = s.eliminated.map((x) => ({ ...x }));
    s = G.forfeit!(s, 'west', 'timeout');
    expect(s.eliminated).toEqual(placementBefore);
    expect(s.ghostsGone).toEqual(['west']);
    expect(s.mines).toEqual([]);
    expect(G.stillSeated!(s, 'west')).toBe(false);
    expect(s.round).toBe(round + 1);
  });

  test('narration never names the trick before the reveal', () => {
    const cmd = { trick: 'mine', at: 'east', cell: 'e2' };
    const s = withGhost();
    expect(turn.describe!(cmd)).toBe('plays a dirty trick');
    expect(turn.narrate!(s, trick(s, 'west', cmd), 'west', cmd)).toBe('is up to something…');
  });
});

/** A four-seat table where `seat`'s fleet sits in columns e–h (so a1..d8 are open water there). */
function deployedEastward(seat: string): SalvoState {
  let s = fresh(4);
  for (const x of s.seats) {
    const fleet: [ShipId, string][] = x === seat ? [['cruiser', 'e1'], ['destroyer', 'e3'], ['frigate', 'e5'], ['submarine', 'e7']] : STANDARD;
    for (const [ship, at] of fleet) s = place(s, x, ship, at);
  }
  return s;
}
const tricksIn = (s: SalvoState) => s.lastVolley!.tricks;

describe('a false splash never gives itself away', () => {
  test('no splash on a sea down to its last ship cell: a fake hit there would read "0 afloat"', () => {
    let s = withGhost();
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'));
    expect(viewOf(s, 'west').targets.find((t) => t.sea === 'east')!.afloat).toBe(1);
    const splashes = tricksOf(s, 'west').filter((c) => c.trick === 'splash');
    expect(splashes.some((c) => c.at === 'east')).toBe(false);
    expect(splashes.some((c) => c.at === 'south')).toBe(true);
    expect(codeOf(() => trick(s, 'west', { trick: 'splash', fool: 'north', at: 'east', cell: 'h4' }))).toBe('LAST_CELL');
    // Mines there are fine.
    expect(tricksOf(s, 'west').some((c) => c.trick === 'mine' && c.at === 'east')).toBe(true);
  });

  test('a splash whose sea is down to its last cell after the volley is told at once, never shown', () => {
    let s = withGhost();
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7' && c !== 'a7'));
    s = trick(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volley(s, { north: ['east', 'a7'] });
    expect(viewOf(s, 'south').targets.find((t) => t.sea === 'east')!.hits).not.toContain('h4');
    expect(viewOf(s, 'south').targets.find((t) => t.sea === 'east')!.afloat).toBe(1);
    expect(s.lastVolley!.tricks).toEqual([{ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' }]);
    expect(s.splashes).toEqual([]);
  });
});

describe('tricks in the volley', () => {
  test('a mine on open water comes back on the shooter: same cell when a ship is there', () => {
    let s = deployedEastward('east');
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['west', 'b7'] });
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' }); // east's a1 is open water
    s = volley(s, { north: ['east', 'a1'] });
    expect(tricksIn(s)).toEqual([{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'a1', shooters: ['north'], result: 'boomerang', hits: [{ sea: 'north', cell: 'a1' }] }]);
    expect(s.fleets.north.find((x) => x.id === 'cruiser')!.hits).toContain('a1');
    expect(s.shots.north.a1).toEqual({ result: 'hit', by: ['west'] });
    expect(s.mines).toEqual([]);
    expect(s.scrap.west).toBeGreaterThanOrEqual(1);
  });

  test('…else the nearest unhit ship cell, ties in board order', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' }); // open water on east; north has no ship at e2
    s = volley(s, { north: ['east', 'e2'] });
    // From e2 the nearest unhit north ship cell is d1 (distance 2).
    expect((tricksIn(s)[0] as { hits: unknown[] }).hits).toEqual([{ sea: 'north', cell: 'd1' }]);
  });

  test("a mine laid this round catches this round's shell", () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'south', cell: 'f6' });
    s = volley(s, { east: ['south', 'f6'] });
    expect(tricksIn(s)).toHaveLength(1);
    expect(tricksIn(s)[0]).toMatchObject({ kind: 'mine', shooters: ['east'], result: 'boomerang' });
  });

  test('a mine on a ship backfires: the whole ship sinks for the shooter', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' }); // east's cruiser a1–d1
    const scrap = s.scrap.north;
    s = volley(s, { north: ['east', 'a1'] });
    expect(tricksIn(s)).toEqual([{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'a1', shooters: ['north'], result: 'backfire', ship: 'cruiser' }]);
    expect(s.fleets.east.find((x) => x.id === 'cruiser')!.hits.sort()).toEqual(['a1', 'b1', 'c1', 'd1']);
    expect(s.lastVolley!.sunk).toContainEqual({ sea: 'east', ship: 'cruiser', by: ['north'] });
    expect(s.scrap.north - scrap).toBe(4 + 3);
  });

  test('Time on Target on a mine triggers it once per shooter; spill cells do not', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'south', cell: 'f6' });
    s = volley(s, { north: ['south', 'f6'], east: ['south', 'f6'] });
    expect(tricksIn(s)[0]).toMatchObject({ shooters: ['north', 'east'], result: 'boomerang' });
    expect((tricksIn(s)[0] as { hits: unknown[] }).hits).toHaveLength(2);
    // A mine the blast only spills onto does not go off: it fizzles, untold (its cell is spent).
    let t = withGhost();
    t = trick(t, 'west', { trick: 'mine', at: 'south', cell: 'g7' }); // next to f6, off every filler column
    t = volley(t, { north: ['south', 'f6'], east: ['south', 'f6'] });
    expect(tricksIn(t)).toEqual([]);
    expect(t.mines).toEqual([]);
  });

  test('a mine spent by a boomerang or a backfire hull fizzles, untold', () => {
    let s = withGhost();
    s.mines = [{ ghost: 'west', sea: 'north', cell: 'd1', round: 1 }];
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    s = volley(s, { north: ['east', 'e2'] }); // the boomerang lands on north d1
    expect(tricksIn(s)).toHaveLength(1);
    expect(s.mines).toEqual([]);
    let t = withGhost();
    t.mines = [{ ghost: 'west', sea: 'east', cell: 'c1', round: 1 }];
    t = trick(t, 'west', { trick: 'mine', at: 'east', cell: 'a1' });
    t = volley(t, { north: ['east', 'a1'] }); // the cruiser a1–d1 goes up, c1 with it
    expect(tricksIn(t)).toEqual([{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'a1', shooters: ['north'], result: 'backfire', ship: 'cruiser' }]);
    expect(t.mines).toEqual([]);
  });

  test('a false splash on show when the match ends at a volley is told in it, and the fool sees the truth', () => {
    let s = withGhost();
    preHit(s, 'north', SHIP_CELLS.filter((c) => c !== 'd1'));
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = trick(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volley(s, { east: [['north', 'd1'], ['south', 'd1']] });
    expect(s.phase).toBe('over');
    expect(tricksIn(s)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' });
    expect(s.splashes).toEqual([]);
    expect(viewOf(s, 'south').targets.find((t) => t.sea === 'east')!.hits).not.toContain('h4');
    // The round cap ends it the same way.
    let t = withGhost();
    t.round = ROUND_CAP;
    t = trick(t, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    t = volley(t, {});
    expect(t.endReason).toBe('round-cap');
    expect(tricksIn(t)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' });
  });

  test('a false splash on show when the match ends by forfeit is cleared; the fool sees the truth', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volley(s, { north: ['east', 'h8'] });
    expect(s.splashes).toHaveLength(1);
    s = G.forfeit!(G.forfeit!(s, 'south', 'resign'), 'north', 'resign');
    expect(s.winner).toBe('east');
    expect(s.splashes).toEqual([]);
    expect(viewOf(s, 'south').targets.find((t) => t.sea === 'east')!.hits).not.toContain('h4');
    expect(JSON.stringify(viewOf(s, 'south'))).not.toMatch(/"h4"/);
  });

  test('a boomerang can knock the shooter out', () => {
    let s = withGhost();
    preHit(s, 'north', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    s = volley(s, { north: ['east', 'e2'] });
    expect(s.lastVolley!.eliminated).toContain('north');
    expect(s.lastVolley!.sunk).toContainEqual({ sea: 'north', ship: 'cruiser', by: ['west'] });
    expect(G.stillSeated!(s, 'north')).toBe(true); // a mine's victim becomes a ghost too
  });

  test('a mine dies with its sea', () => {
    let s = withGhost();
    s.mines = [{ ghost: 'west', sea: 'south', cell: 'h8', round: 1 }];
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'h1' });
    s = volley(s, { north: ['south', 'b7'] });
    expect(s.mines.map((m) => m.sea)).toEqual(['east']);
  });

  test('a false splash shows to the fool alone, dressed as a real shooter, then is told', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volley(s, { north: ['east', 'h8'] });
    const fool = viewOf(s, 'south');
    const east = fool.targets.find((t) => t.sea === 'east')!;
    expect(east.hits).toContain('h4');
    expect(east.afloat).toBe(viewOf(s, 'north').targets.find((t) => t.sea === 'east')!.afloat - 1);
    expect(fool.lastVolley!.shells).toContainEqual({ from: 'north', sea: 'east', cell: 'h4', result: 'hit', ship: null, blast: false });
    for (const other of ['north', 'east', null]) expect(JSON.stringify(viewOf(s, other as string | null))).not.toMatch(/"h4"/);
    expect(viewOf(s, 'west').myTricks!.splashes).toEqual([{ fool: 'south', sea: 'east', cell: 'h4', round: s.round - 1 }]);
    expect(tricksIn(s)).toEqual([]);
    // The next volley takes it back and tells the table.
    s = trick(s, 'west', { trick: 'mine', at: 'north', cell: 'h1' });
    s = volley(s, {});
    expect(tricksIn(s)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' });
    expect(viewOf(s, 'south').targets.find((t) => t.sea === 'east')!.hits).not.toContain('h4');
  });

  test('a false splash shot first is told at once', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volley(s, { north: ['east', 'h4'] });
    expect(tricksIn(s)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' });
    expect(s.splashes).toEqual([]);
  });

  test('a false splash whose cell a backfire hull or a boomerang lands on is told at once', () => {
    // Backfire: east's cruiser a1–d1 goes up with north's shell, c1 (the splash) with it.
    let s = withGhost();
    s.splashes = [{ ghost: 'west', fool: 'south', sea: 'east', cell: 'c1', round: s.round, as: 'north' }];
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' });
    s = volley(s, { north: ['east', 'a1'] });
    expect(s.shots.east.c1).toEqual({ result: 'hit', by: ['north'] });
    expect(tricksIn(s)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'c1' });
    expect(s.splashes).toEqual([]);
    // Boomerang: north's shell on east's e2 comes back on north's d1, the splash's cell.
    let t = withGhost();
    t.splashes = [{ ghost: 'west', fool: 'south', sea: 'north', cell: 'd1', round: t.round, as: 'east' }];
    t = trick(t, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    t = volley(t, { north: ['east', 'e2'] });
    expect(t.shots.north.d1).toEqual({ result: 'hit', by: ['west'] });
    expect(tricksIn(t)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'north', cell: 'd1' });
    expect(t.splashes).toEqual([]);
  });

  test('a trick on a seat that left before the volley is dropped', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'h1' });
    s = G.forfeit!(s, 'east', 'resign');
    s = volley(s, {});
    expect(s.mines).toEqual([]);
    expect(tricksIn(s)).toEqual([]);
    // A splash whose fool resigned, and one with too few fleets left, never shows.
    let t = withGhost();
    t = trick(t, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    t = G.forfeit!(t, 'south', 'resign');
    t = volley(t, {});
    expect(t.splashes).toEqual([]);
    let u = withGhost();
    u = trick(u, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    u = G.forfeit!(u, 'north', 'resign');
    u = volley(u, {});
    expect(u.splashes).toEqual([]);
    expect(JSON.stringify(viewOf(u, 'south'))).not.toMatch(/"h4"/);
  });

  test('the round summary tells each trick; the out line says a ghost rises', () => {
    let s = deployed();
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
    const before = s;
    s = volley(s, { north: ['west', 'b7'] });
    expect(roundSummary(before, s)).toContain('{west} is out, and comes back as a ghost.');
    let t = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' });
    const b2 = t;
    t = volley(t, { north: ['east', 'a1'] });
    expect(roundSummary(b2, t)).toContain("Backfire! {west}'s mine was sitting on {east}'s cruiser. {north}'s shell sends it to the bottom. Thanks for the help, {west}.");
    let u = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    const b3 = u;
    u = volley(u, { north: ['east', 'e2'] });
    expect(roundSummary(b3, u)).toContain("Dirty trick! {west}'s mine at {east} e2 goes off under {north}'s shell — it comes back on {north}'s own sea at d1, a hit.");
  });

  test('live mines are shown on their seas once the match is over', () => {
    let s = withGhost();
    s.mines = [{ ghost: 'west', sea: 'east', cell: 'h8', round: 1 }];
    s = G.forfeit!(G.forfeit!(s, 'south', 'resign'), 'north', 'resign');
    expect(s.phase).toBe('over');
    expect(viewOf(s, null).targets.find((t) => t.sea === 'east')!.mines).toEqual([{ ghost: 'west', cell: 'h8' }]);
  });

  test('the ascii shows a ghost its own mines as M, and nobody else', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'h8' });
    for (const seat of ['north', 'east', 'south']) s = salvo(s, seat);
    expect(viewOf(s, 'west').ascii).toMatch(/^8 .* M/m);
    expect(viewOf(s, 'north').ascii).not.toMatch(/ M( |$)/m);
  });
});

describe('crates', () => {
  /** North sinks east's submarine (a7–b7) in one volley: preHit a7, then shoot b7. */
  function sinkSub(): SalvoState {
    const s = deployed();
    preHit(s, 'east', ['a7'], 'north');
    return volley(s, { north: ['east', 'b7'] });
  }
  test('sinking a ship earns its shooter a crate of three items; the table hears it, never which', () => {
    const s = sinkSub();
    const mine = viewOf(s, 'north').myArsenal!;
    expect(mine.items).toEqual([]);
    expect(mine.crate).toHaveLength(3);
    expect(viewOf(s, 'east').myArsenal!.crate).toBeNull();
    expect(viewOf(s, null).myArsenal).toBeNull();
    const summary = roundSummary(deployed(), s);
    expect(summary).toContain('{north} pulls a crate from the wreck.');
    expect(summary.join(' ')).not.toMatch(/cluster|torpedo|repair|decoy/);
  });
  test('an open crate is owed: legal leads with its cards and pass; the seat is not ready until it picks', () => {
    let s = sinkSub();
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    const crate = viewOf(s, 'north').myArsenal!.crate!;
    expect(legal.slice(0, 4)).toEqual([...crate.map((x) => ({ crate: x })), { crate: 'pass' }]);
    s = salvo(s, 'north', [], [], true); // all guns fired
    expect(turn.toMove(s)).toContain('north');
    expect(s.ready).not.toContain('north');
    expect(turn.legal(s, 'north')).toEqual([...crate.map((x) => ({ crate: x })), { crate: 'pass' }]);
    expect(codeOf(() => fire(s, 'north', 'west', 'a2'))).toBe('SALVO_DONE');
    s = turn.apply(s, 'north', { crate: crate[0] });
    expect(viewOf(s, 'north').myArsenal).toEqual({ items: [crate[0]], crate: null });
    expect(viewOf(s, 'east').holding.north).toBe(1);
    expect(s.ready).toContain('north');
  });
  test('a crate pick that is the last thing owed closes the round', () => {
    let s = sinkSub();
    const round = s.round;
    s = salvo(s, 'north', [], [], true);
    for (const x of ['east', 'south', 'west']) s = salvo(s, x);
    expect(s.round).toBe(round);
    expect(turn.toMove(s)).toEqual(['north']);
    s = turn.apply(s, 'north', { crate: 'pass' });
    expect(s.round).toBe(round + 1);
    expect(s.crates.north).toEqual([]);
    expect(s.arsenal.north).toEqual([]);
  });
  test('two held: a pick needs a drop; pass is always fine', () => {
    let s = sinkSub();
    s.arsenal.north = ['repair', 'decoy'];
    const crate = s.crates.north[0];
    const card = crate.find((x) => x !== 'repair' && x !== 'decoy') ?? crate[0];
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    expect(legal.slice(0, 7)).toEqual([
      ...crate.flatMap((x): SalvoCommand[] => [{ crate: x, drop: 'repair' }, { crate: x, drop: 'decoy' }]),
      { crate: 'pass' },
    ] as SalvoCommand[]);
    expect(codeOf(() => turn.apply(s, 'north', { crate: card }))).toBe('HANDS_FULL');
    expect(codeOf(() => turn.apply(s, 'north', { crate: card, drop: 'torpedo' }))).toBe('BAD_DROP');
    s = turn.apply(s, 'north', { crate: card, drop: 'repair' });
    expect(s.arsenal.north.sort()).toEqual((['decoy', card] as ItemId[]).sort());
    expect(codeOf(() => turn.apply(s, 'north', { crate: 'pass' }))).toBe('NO_CRATE');
  });
  test('two of a kind held: each swap is listed once', () => {
    const s = sinkSub();
    s.arsenal.north = ['cluster', 'cluster'];
    const crate = s.crates.north[0];
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    expect(legal.slice(0, crate.length + 1)).toEqual([...crate.map((x): SalvoCommand => ({ crate: x, drop: 'cluster' })), { crate: 'pass' }] as SalvoCommand[]);
  });
  test('holding never reads over the limit: hold 2, queue one, pick a card — the table sees 2', () => {
    let s = sinkSub();
    s.arsenal.north = ['cluster', 'torpedo'];
    s = turn.apply(s, 'north', { fire: 'cluster', at: 'west', cell: 'b3' });
    expect(s.arsenal.north).toEqual(['torpedo']);
    s = turn.apply(s, 'north', { crate: s.crates.north[0][0] });
    expect(s.arsenal.north).toHaveLength(2);
    for (const viewer of ['east', 'south', 'west', null]) expect(viewOf(s, viewer).holding.north).toBe(2);
  });
  test('cards not in the crate are refused', () => {
    const s = sinkSub();
    const missing = ITEMS.find((x) => !s.crates.north[0].includes(x))!;
    expect(codeOf(() => turn.apply(s, 'north', { crate: missing }))).toBe('NOT_IN_CRATE');
  });
  test('a shared sinking crates every shooter; ghosts and the finished match get none', () => {
    let s = deployed();
    preHit(s, 'east', ['a7'], 'north');
    s = volley(s, { north: ['east', 'b7'], south: ['east', 'b7'] }); // Time on Target on b7
    expect(s.crates.north).toHaveLength(1);
    expect(s.crates.south).toHaveLength(1);
    expect(s.crates.west).toEqual([]);
  });
  test("a ghost's boomerang that sinks a ship earns the ghost no crate", () => {
    let s = withGhost();
    preHit(s, 'north', ['a7'], 'east');
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'b8' }); // open water on east; north's nearest unhit ship cell is b7
    const before = s;
    s = volley(s, { north: ['east', 'b8'] });
    expect(tricksIn(s)).toEqual([{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'b8', shooters: ['north'], result: 'boomerang', hits: [{ sea: 'north', cell: 'b7' }] }]);
    expect(s.lastVolley!.sunk).toEqual([{ sea: 'north', ship: 'submarine', by: ['west'] }]);
    expect(s.crates.west).toEqual([]);
    expect(s.crates.north).toEqual([]);
    expect(roundSummary(before, s).join(' ')).not.toMatch(/crate/);
  });
  test('a drop with room in hand is refused: pick without dropping', () => {
    const s = sinkSub();
    s.arsenal.north = ['repair'];
    expect(codeOf(() => turn.apply(s, 'north', { crate: s.crates.north[0][0], drop: 'repair' }))).toBe('BAD_DROP');
  });
  test('two sinkings in one volley queue two crates, one open at a time', () => {
    let s = deployed();
    preHit(s, 'east', ['a7'], 'north');
    preHit(s, 'west', ['a7'], 'north');
    s = volley(s, { north: [['east', 'b7'], ['west', 'b7']] });
    expect(s.crates.north).toHaveLength(2);
    expect(viewOf(s, 'north').myArsenal!.crate).toEqual(s.crates.north[0]);
    expect(roundSummary(deployed(), s).filter((x) => x === '{north} pulls a crate from the wreck.')).toHaveLength(2);
    s = turn.apply(s, 'north', { crate: 'pass' });
    expect(s.crates.north).toHaveLength(1);
    expect(turn.toMove(s)).toContain('north');
  });
  test('a seat whose fleet goes down in the volley gets no crate for its own sinking', () => {
    let s = deployed();
    preHit(s, 'north', ['a7'], 'east');
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'), 'north');
    s = volley(s, { north: ['east', 'b7'], east: ['north', 'b7'] });
    expect(s.lastVolley!.sunk.some((x) => x.sea === 'north' && x.by.includes('east'))).toBe(true);
    expect(s.crates.north).toHaveLength(1);
    expect(s.crates.east).toEqual([]);
    expect(viewOf(s, 'east').myArsenal).toBeNull();
  });
  test('no crate once the match is over', () => {
    let s = deployed(2);
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['east', 'b7'] });
    expect(s.phase).toBe('over');
    expect(s.crates.north).toEqual([]);
    expect(roundSummary(deployed(2), s).join(' ')).not.toMatch(/crate/);
  });
  test('narration never names a crate card', () => {
    const s = sinkSub();
    const cmd = { crate: s.crates.north[0][0] };
    expect(turn.describe!(cmd)).toBe('opens a crate');
    expect(turn.narrate!(s, turn.apply(s, 'north', cmd), 'north', cmd)).toBe('opens a crate');
  });
  test('a random legal command always makes progress (the autopilot never stalls on a crate)', () => {
    let s = sinkSub();
    for (let k = 0; k < 20 && turn.toMove(s).includes('north'); k++) s = turn.apply(s, 'north', (turn.legal(s, 'north') as SalvoCommand[]).at(-1)!);
    expect(turn.toMove(s)).not.toContain('north');
  });
});

describe('cluster and torpedo', () => {
  /** STANDARD fleets everywhere; `seat` holds `items`. */
  function holding(seat: string, items: ItemId[]): SalvoState {
    const s = deployed();
    s.arsenal[seat] = items;
    return s;
  }
  const use = (s: SalvoState, seat: string, cmd: Record<string, unknown>) => turn.apply(s, seat, cmd);
  const itemsOf = (s: SalvoState, seat: string) =>
    (turn.legal(s, seat) as SalvoCommand[]).filter((c) => 'fire' in c && (c.fire === 'cluster' || c.fire === 'torpedo'));

  test('legal offers each held kind once, every sea; one item a round (ONE_ITEM)', () => {
    expect(itemsOf(deployed(), 'north')).toEqual([]);
    const two = itemsOf(holding('north', ['cluster', 'cluster']), 'north');
    expect(two).toHaveLength(3 * 64);
    expect(two[0]).toEqual({ fire: 'cluster', at: 'east', cell: 'a1' });
    let s = holding('north', ['cluster', 'torpedo']);
    const offered = itemsOf(s, 'north');
    expect(offered.filter((c) => (c as { fire: string }).fire === 'torpedo')).toHaveLength(3 * 8);
    expect(offered).toContainEqual({ fire: 'torpedo', at: 'west', lane: 'h' });
    expect(itemsOf(holding('west', ['torpedo']), 'west')).toContainEqual({ fire: 'torpedo', at: 'east', lane: '8' });
    s = use(s, 'north', { fire: 'cluster', at: 'east', cell: 'b3' });
    expect(s.arsenal.north).toEqual(['torpedo']);
    expect(viewOf(s, 'north').myArsenal!.items).toEqual(['torpedo']); // spent, for its owner
    expect(viewOf(s, 'east').holding.north).toBe(2); // the table can't tell until the reveal
    expect(viewOf(s, null).holding.north).toBe(2);
    expect(viewOf(s, 'north').myOrders).toEqual([{ fire: 'cluster', at: 'east', cell: 'b3' }]);
    expect(viewOf(s, 'east').myOrders).toEqual([]);
    expect(itemsOf(s, 'north')).toEqual([]);
    expect(codeOf(() => use(s, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }))).toBe('ONE_ITEM');
    s = volley(s, {});
    expect(viewOf(s, 'east').holding.north).toBe(1);
  });

  test('refusals carry precise codes', () => {
    const s = holding('north', ['cluster', 'torpedo']);
    expect(codeOf(() => use(deployed(), 'north', { fire: 'cluster', at: 'east', cell: 'b3' }))).toBe('NO_ITEM');
    expect(codeOf(() => use(holding('north', ['cluster']), 'north', { fire: 'torpedo', at: 'east', lane: 'c' }))).toBe('NO_ITEM');
    expect(codeOf(() => use(s, 'north', { fire: 'torpedo', at: 'east', lane: '3' }))).toBe('BAD_LANE');
    expect(codeOf(() => use(holding('west', ['torpedo']), 'west', { fire: 'torpedo', at: 'east', lane: 'c' }))).toBe('BAD_LANE');
    expect(codeOf(() => use(s, 'north', { fire: 'cluster', at: 'north', cell: 'b3' }))).toBe('BAD_TARGET');
    expect(codeOf(() => use(s, 'north', { fire: 'cluster', at: 'east', cell: 'z9' }))).toBe('BAD_CELL');
    expect(codeOf(() => use(s, 'north', { fire: 'torpedo', at: 'east' }))).toBe('BAD_COMMAND');
    const shot = holding('north', ['cluster', 'torpedo']);
    preHit(shot, 'east', ['b3'], 'north');
    expect(codeOf(() => use(shot, 'north', { fire: 'cluster', at: 'east', cell: 'b3' }))).toBe('ALREADY_FIRED');
    preHit(shot, 'east', ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'], 'north');
    expect(codeOf(() => use(shot, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }))).toBe('LANE_SPENT');
    expect(itemsOf(shot, 'north')).not.toContainEqual({ fire: 'torpedo', at: 'east', lane: 'e' });
    expect(itemsOf(shot, 'north')).toContainEqual({ fire: 'torpedo', at: 'south', lane: 'e' });
    expect(itemsOf(shot, 'north')).not.toContainEqual({ fire: 'cluster', at: 'east', cell: 'b3' });
    expect(shot.arsenal.north).toEqual(['cluster', 'torpedo']); // a refused item stays in hand
    // Two of your own guns on one cell: a cluster centre on your queued shell, a shell on your queued cluster centre.
    let aimed = fire(holding('north', ['cluster']), 'north', 'east', 'b3');
    expect(itemsOf(aimed, 'north')).not.toContainEqual({ fire: 'cluster', at: 'east', cell: 'b3' });
    expect(codeOf(() => use(aimed, 'north', { fire: 'cluster', at: 'east', cell: 'b3' }))).toBe('ALREADY_AIMED');
    aimed = use(holding('north', ['cluster']), 'north', { fire: 'cluster', at: 'east', cell: 'b3' });
    expect(shellsOf(aimed, 'north')).not.toContainEqual({ fire: 'shell', at: 'east', cell: 'b3' });
    expect(shellsOf(aimed, 'north')).toContainEqual({ fire: 'shell', at: 'east', cell: 'a3' }); // the plus around it is fine
    expect(codeOf(() => fire(aimed, 'north', 'east', 'b3'))).toBe('ALREADY_AIMED');
    // A lane over your own queued shell is fine.
    const lane = fire(holding('north', ['torpedo']), 'north', 'east', 'e5');
    expect(codeOf(() => use(lane, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }))).toBeNull();
  });

  test('a cluster lands five cells as shells from its shooter: hits paid, a sinking, a crate', () => {
    let s = holding('north', ['cluster']);
    const scrap = s.scrap.north;
    const before = s;
    s = use(s, 'north', { fire: 'cluster', at: 'east', cell: 'b3' }); // the destroyer is a3–c3
    s = volley(s, {});
    expect(s.lastVolley!.items).toEqual([{ item: 'cluster', from: 'north', sea: 'east', cell: 'b3', cells: ['b3', 'b2', 'a3', 'c3', 'b4'], hits: ['b3', 'a3', 'c3'] }]);
    expect(s.lastVolley!.shells.some((x) => x.sea === 'east')).toBe(false); // a cluster is not a shell
    expect(s.shots.east.b2).toEqual({ result: 'miss', by: ['north'] });
    expect(s.shots.east.a3).toEqual({ result: 'hit', by: ['north'] });
    expect(s.lastVolley!.sunk).toEqual([{ sea: 'east', ship: 'destroyer', by: ['north'] }]);
    expect(s.scrap.north - scrap).toBe(3 + 3);
    expect(s.hitsLanded.north).toBe(3);
    expect(s.crates.north).toHaveLength(1);
    expect(s.arsenal.north).toEqual([]);
    const lines = roundSummary(before, s);
    expect(lines).toContain("{north}'s cluster lands on {east} around b3: 3 hits.");
    expect(lines).toContain("{north} sinks {east}'s destroyer.");
  });

  test('a cluster at the edge lands three cells; cells you have shot are skipped; open water is all water', () => {
    let s = holding('north', ['cluster']);
    s = volley(use(s, 'north', { fire: 'cluster', at: 'east', cell: 'a1' }), {});
    expect(s.lastVolley!.items[0]).toMatchObject({ cells: ['a1', 'b1', 'a2'], hits: ['a1', 'b1'] });
    let t = holding('north', ['cluster']);
    preHit(t, 'east', ['f5'], 'north');
    preHit(t, 'east', ['f7'], 'south');
    const before = t;
    t = volley(use(t, 'north', { fire: 'cluster', at: 'east', cell: 'f6' }), {});
    expect(t.lastVolley!.items[0]).toMatchObject({ cell: 'f6', cells: ['f6', 'e6', 'g6', 'f7'], hits: [] });
    expect(t.shots.east.f5).toEqual({ result: 'miss', by: ['north'] });
    expect(t.shots.east.f7).toEqual({ result: 'miss', by: ['north', 'south'] }); // seat order
    expect(roundSummary(before, t)).toContain("{north}'s cluster lands on {east} around f6: all water.");
  });

  test("a cluster cell another seat's lone shell also hits is no Time on Target", () => {
    let s = holding('north', ['cluster']);
    s = use(s, 'north', { fire: 'cluster', at: 'east', cell: 'b3' });
    s = volley(s, { south: ['east', 'a3'] });
    expect(s.lastVolley!.blasts).toEqual([]);
    expect(s.lastVolley!.shells.find((x) => x.from === 'south' && x.cell === 'a3')).toMatchObject({ result: 'sunk', blast: false });
    expect(s.shots.east.a3).toEqual({ result: 'hit', by: ['north', 'south'] });
    expect(s.shots.east.a4).toBeUndefined(); // no 3×3 spill
    expect(s.lastVolley!.sunk).toEqual([{ sea: 'east', ship: 'destroyer', by: ['north', 'south'] }]);
  });

  test("a cluster or torpedo never sets off a ghost's mine: the mine it spends fizzles", () => {
    let s = withGhost();
    s = turn.apply(s, 'north', { crate: 'pass' });
    s.arsenal.north = ['cluster'];
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e6' }); // south's fillers run down east's column g
    s = volley(use(s, 'north', { fire: 'cluster', at: 'east', cell: 'f6' }), {});
    expect(tricksIn(s)).toEqual([]);
    expect(s.mines).toEqual([]);
    expect(s.shots.east.e6).toEqual({ result: 'miss', by: ['north'] });
    // A torpedo running over a mine spends it the same way.
    let t = withGhost();
    t = turn.apply(t, 'north', { crate: 'pass' });
    t.arsenal.north = ['torpedo'];
    t = trick(t, 'west', { trick: 'mine', at: 'east', cell: 'e6' });
    t = volley(use(t, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }), {});
    expect(tricksIn(t)).toEqual([]);
    expect(t.mines).toEqual([]);
  });

  test("each seat's torpedo runs away from it and stops at the first ship cell; the summary tells each", () => {
    let s = deployed();
    for (const x of s.seats) s.arsenal[x] = ['torpedo'];
    const before = s;
    s = use(s, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }); // down column e from e8: open water
    s = use(s, 'east', { fire: 'torpedo', at: 'north', lane: '3' }); // west along row 3 from h3: the destroyer ends at c3
    s = use(s, 'south', { fire: 'torpedo', at: 'east', lane: 'b' }); // up column b from b1: the cruiser
    s = use(s, 'west', { fire: 'torpedo', at: 'east', lane: '1' }); // east along row 1 from a1: the cruiser
    s = volley(s, {});
    expect(s.lastVolley!.items).toEqual([
      { item: 'torpedo', from: 'north', sea: 'east', lane: 'e', path: ['e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e2', 'e1'], struck: null },
      { item: 'torpedo', from: 'east', sea: 'north', lane: '3', path: ['h3', 'g3', 'f3', 'e3', 'd3', 'c3'], struck: 'c3' },
      { item: 'torpedo', from: 'south', sea: 'east', lane: 'b', path: ['b1'], struck: 'b1' },
      { item: 'torpedo', from: 'west', sea: 'east', lane: '1', path: ['a1'], struck: 'a1' },
    ]);
    for (const c of ['e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e2', 'e1']) expect(s.shots.east[c]).toEqual({ result: 'miss', by: ['north'] });
    for (const c of ['h3', 'g3', 'f3', 'e3', 'd3']) expect(s.shots.north[c]).toEqual({ result: 'miss', by: ['east'] });
    expect(s.shots.north.c3).toEqual({ result: 'hit', by: ['east'] });
    expect(s.shots.north.b3).toBeUndefined();
    expect(s.shots.east.a1).toEqual({ result: 'hit', by: ['west'] });
    expect(s.shots.east.b1).toEqual({ result: 'hit', by: ['south'] });
    expect(s.fleets.east.find((x) => x.id === 'cruiser')!.hits).toEqual(['a1', 'b1']);
    expect(s.hitsLanded).toMatchObject({ north: 0, east: 1, south: 1, west: 1 });
    const lines = roundSummary(before, s);
    expect(lines).toContain("{north}'s torpedo runs down {east}'s lane e and runs clean through.");
    expect(lines).toContain("{east}'s torpedo runs down {north}'s lane 3 and strikes at c3.");
    expect(lines).toContain("{south}'s torpedo runs down {east}'s lane b and strikes at b1.");
    expect(lines).toContain("{west}'s torpedo runs down {east}'s lane 1 and strikes at a1.");
  });

  test('a torpedo passes shot cells: hits, misses, its own shots; it stops only at a ship cell unhit when the volley began', () => {
    let s = holding('west', ['torpedo']);
    preHit(s, 'east', ['a1', 'b1'], 'north');
    preHit(s, 'east', ['c1'], 'west');
    s = use(s, 'west', { fire: 'torpedo', at: 'east', lane: '1' });
    s = volley(s, { north: ['east', 'd1'] }); // north's shell lands on d1 the same volley: the torpedo still stops there
    expect(s.lastVolley!.items).toEqual([{ item: 'torpedo', from: 'west', sea: 'east', lane: '1', path: ['a1', 'b1', 'c1', 'd1'], struck: 'd1' }]);
    expect(s.shots.east.a1).toEqual({ result: 'hit', by: ['north', 'west'] });
    expect(s.shots.east.c1).toEqual({ result: 'hit', by: ['west'] });
    expect(s.shots.east.d1).toEqual({ result: 'hit', by: ['north', 'west'] });
    expect(s.lastVolley!.blasts).toEqual([]);
    expect(s.lastVolley!.sunk).toEqual([{ sea: 'east', ship: 'cruiser', by: ['north', 'west'] }]);
    // North runs down column a from a8: a miss of its own, a hit someone else landed, then the frigate at a5.
    let t = holding('north', ['torpedo']);
    preHit(t, 'east', ['a8'], 'north');
    preHit(t, 'east', ['a7'], 'south');
    t = volley(use(t, 'north', { fire: 'torpedo', at: 'east', lane: 'a' }), {});
    expect(t.lastVolley!.items[0]).toMatchObject({ path: ['a8', 'a7', 'a6', 'a5'], struck: 'a5' });
    expect(t.shots.east.a8).toEqual({ result: 'miss', by: ['north'] });
    expect(t.shots.east.a7).toEqual({ result: 'hit', by: ['north', 'south'] });
    expect(t.shots.east.a6).toEqual({ result: 'miss', by: ['north'] });
    expect(t.shots.east.a5).toEqual({ result: 'hit', by: ['north'] });
  });

  test('an item shot is told like a shell before the reveal: "fires", "is ready"; the volley lists none when none is used', () => {
    const s = holding('north', ['cluster', 'torpedo']);
    for (const cmd of [{ fire: 'cluster', at: 'east', cell: 'b3' }, { fire: 'torpedo', at: 'east', lane: 'c' }]) {
      expect(turn.describe!(cmd)).toBe('fires');
      expect(turn.narrate!(s, use(s, 'north', cmd), 'north', cmd)).toBe('is ready');
    }
    expect(volley(deployed(), {}).lastVolley!.items).toEqual([]);
  });
});

describe('repair and decoy', () => {
  /** STANDARD fleets everywhere; `seat` holds `items`. */
  function holding(seat: string, items: ItemId[], s = deployed()): SalvoState {
    s.arsenal[seat] = items;
    return s;
  }
  const use = (s: SalvoState, seat: string, cmd: Record<string, unknown>) => turn.apply(s, seat, cmd);
  const repair = (s: SalvoState, seat: string, cell: string) => use(s, seat, { use: 'repair', cell });
  const lay = (s: SalvoState, seat: string, at: string, facing: 'east' | 'north' = 'east') => use(s, seat, { use: 'decoy', at, facing });
  const usesOf = (s: SalvoState, seat: string) => (turn.legal(s, seat) as SalvoCommand[]).filter((c) => 'use' in c);
  const targetOf = (s: SalvoState, viewer: string | null, sea: string) => viewOf(s, viewer).targets.find((t) => t.sea === sea)!;
  /** East's decoy at e5–f5, laid in round 1 (the fillers never reach east's sea: see `salvo`). */
  function decoyed(): SalvoState {
    return volley(lay(holding('east', ['decoy']), 'east', 'e5'), {});
  }
  /** As `preHit` for a live decoy's cell: north landed it earlier (a volley's fillers would run out of column). */
  function decoyHit(s: SalvoState, cell = 'e5', by = 'north'): SalvoState {
    s.shots.east[cell] = { result: 'hit', by: [by] };
    s.decoys.east[0].hits.push(cell);
    return s;
  }

  test('repair: legal on each hit cell of a ship afloat that you own; refusals carry precise codes', () => {
    const s = holding('east', ['repair', 'cluster']);
    preHit(s, 'east', ['a1', 'c1', 'a7', 'b7', 'e5']); // the submarine (a7–b7) is sunk; e5 is a miss
    expect(usesOf(s, 'east')).toEqual([
      { use: 'repair', cell: 'a1' },
      { use: 'repair', cell: 'c1' },
    ]);
    expect(codeOf(() => repair(s, 'east', 'a1'))).toBeNull();
    expect(codeOf(() => repair(s, 'east', 'b1'))).toBe('NOT_HIT'); // a ship cell, unhit
    expect(codeOf(() => repair(s, 'east', 'e5'))).toBe('NOT_HIT'); // water
    expect(codeOf(() => repair(s, 'east', 'a7'))).toBe('SHIP_SUNK');
    expect(codeOf(() => repair(s, 'east', 'z9'))).toBe('BAD_CELL');
    expect(codeOf(() => use(s, 'east', { use: 'repair' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => use(s, 'east', { use: 'jammer', cell: 'a1' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => repair(deployed(), 'east', 'a1'))).toBe('NO_ITEM');
    // North's hits on its own sea are no business of east's repair; and it never repairs another sea.
    const other = holding('east', ['repair']);
    preHit(other, 'north', ['a1']);
    expect(codeOf(() => repair(other, 'east', 'a1'))).toBe('NOT_HIT');
    expect(usesOf(other, 'east')).toEqual([]);
    // One item a round.
    const after = use(s, 'east', { fire: 'cluster', at: 'north', cell: 'e5' });
    expect(usesOf(after, 'east')).toEqual([]);
    expect(codeOf(() => repair(after, 'east', 'a1'))).toBe('ONE_ITEM');
    // Queued: yours in myOrders, out of your hand, still counted by the table, one gun used.
    const queued = repair(s, 'east', 'c1');
    expect(queued.arsenal.east).toEqual(['cluster']);
    expect(viewOf(queued, 'east').myOrders).toEqual([{ fire: 'repair', at: 'east', cell: 'c1' }]);
    expect(viewOf(queued, 'north').myOrders).toEqual([]);
    expect(viewOf(queued, 'north').holding.east).toBe(2);
    expect(shellsOf(queued, 'east').length).toBeGreaterThan(0);
    expect(codeOf(() => use(queued, 'east', { fire: 'cluster', at: 'north', cell: 'e5' }))).toBe('ONE_ITEM');
  });

  test('repair lands before the shells: a cell repaired and shelled the same volley is hit again, the shooter credited', () => {
    let s = holding('east', ['repair']);
    preHit(s, 'east', ['d1'], 'west');
    const before = s;
    const scrap = s.scrap.north;
    s = repair(s, 'east', 'd1');
    s = volley(s, { north: ['east', 'd1'] }); // north never shot d1; west did
    expect(s.shots.east.d1).toEqual({ result: 'hit', by: ['north'] });
    expect(s.fleets.east.find((x) => x.id === 'cruiser')!.hits).toEqual(['d1']);
    expect(s.lastVolley!.shells.find((x) => x.from === 'north' && x.cell === 'd1')!.result).toBe('hit');
    expect(s.hitsLanded.north).toBe(1);
    expect(s.scrap.north - scrap).toBe(1);
    expect(s.lastVolley!.items).toEqual([{ item: 'repair', from: 'east', cell: 'd1' }]);
    expect(s.repairs.east).toEqual([]); // shot again at once: no spark
    expect(targetOf(s, 'south', 'east').repaired).toEqual([]);
    const lines = roundSummary(before, s);
    expect(lines).toContain('{east} welds the hit at d1 back together.');
    expect(lines[0]).toContain('{north} hits {east} at d1');
  });

  test('a repair: the cell is unhit and unshot, afloat rises, the spark shows to everyone until the cell is shot again', () => {
    let s = holding('east', ['repair']);
    preHit(s, 'east', ['b1', 'c1'], 'west');
    expect(targetOf(s, 'north', 'east').afloat).toBe(10);
    s = volley(repair(s, 'east', 'c1'), {});
    expect(s.shots.east.c1).toBeUndefined();
    expect(s.fleets.east.find((x) => x.id === 'cruiser')!.hits).toEqual(['b1']);
    expect(s.repairs.east).toEqual([{ cell: 'c1', round: 1 }]);
    for (const viewer of ['north', 'south', 'west', null]) {
      const t = targetOf(s, viewer, 'east');
      expect(t.repaired).toEqual(['c1']);
      expect(t.hits).toEqual(['b1']);
      expect(t.afloat).toBe(11);
    }
    expect(viewOf(s, 'east').mySea!.repaired).toEqual(['c1']);
    expect(viewOf(s, 'east').mySea!.shots.c1).toBeUndefined();
    expect(targetOf(s, 'west', 'east').mine.map((x) => x.cell)).toEqual(['b1']); // west's hit is gone
    expect(shellsOf(s, 'west')).toContainEqual({ fire: 'shell', at: 'east', cell: 'c1' }); // anyone may shoot it again
    expect(viewOf(s, 'north').ascii).toContain('r = a repaired cell');
    expect(viewOf(s, 'north').ascii.split('\n')).toContain('1 . X r . . . . .');
    expect(viewOf(s, 'east').ascii.split('\n')).toContain('1 C X r C . . . .');
    s = volley(s, { west: ['east', 'c1'] });
    expect(s.repairs.east).toEqual([]);
    expect(targetOf(s, 'north', 'east').repaired).toEqual([]);
    expect(targetOf(s, 'north', 'east').hits).toEqual(['b1', 'c1']);
  });

  test('decoy: legal placements on your own sea; refusals carry precise codes', () => {
    const s = holding('east', ['decoy']);
    preHit(s, 'east', ['e5'], 'north'); // a shot cell
    const offered = usesOf(s, 'east');
    expect(offered).toContainEqual({ use: 'decoy', at: 'e4', facing: 'east' });
    expect(offered).toContainEqual({ use: 'decoy', at: 'h1', facing: 'north' });
    expect(offered).not.toContainEqual({ use: 'decoy', at: 'h1', facing: 'east' }); // off the sea
    expect(offered).not.toContainEqual({ use: 'decoy', at: 'd1', facing: 'east' }); // on the cruiser
    expect(offered).not.toContainEqual({ use: 'decoy', at: 'e4', facing: 'north' }); // over e5
    expect(offered.every((c) => 'use' in c && c.use === 'decoy')).toBe(true);
    expect(codeOf(() => lay(s, 'east', 'e4'))).toBeNull();
    expect(codeOf(() => lay(s, 'east', 'h1'))).toBe('DECOY_PLACE');
    expect(codeOf(() => lay(s, 'east', 'd1'))).toBe('DECOY_PLACE');
    expect(codeOf(() => lay(s, 'east', 'e4', 'north'))).toBe('DECOY_PLACE');
    expect(codeOf(() => lay(s, 'east', 'd5'))).toBe('DECOY_PLACE');
    expect(codeOf(() => use(s, 'east', { use: 'decoy', at: 'e4', facing: 'west' }))).toBe('BAD_FACING');
    expect(codeOf(() => use(s, 'east', { use: 'decoy', at: 'e4' }))).toBe('BAD_FACING');
    expect(codeOf(() => use(s, 'east', { use: 'decoy', facing: 'east' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => lay(s, 'east', 'z9'))).toBe('BAD_CELL');
    expect(codeOf(() => lay(deployed(), 'east', 'e4'))).toBe('NO_ITEM');
    // Queued: yours in myOrders with its facing; the table sees nothing new.
    const queued = lay(s, 'east', 'e4');
    expect(viewOf(queued, 'east').myOrders).toEqual([{ fire: 'decoy', at: 'east', cell: 'e4', facing: 'east' }]);
    expect(viewOf(queued, 'east').mySea!.decoy).toBeNull(); // laid at the reveal
    expect(viewOf(queued, 'north').holding.east).toBe(1);
    // One live decoy a sea: a second waits until the first is found.
    const live = decoyed();
    live.arsenal.east = ['decoy'];
    expect(usesOf(live, 'east')).toEqual([]);
    expect(codeOf(() => lay(live, 'east', 'e7'))).toBe('ONE_DECOY');
  });

  test('a decoy hit looks like any hit to everyone; its owner sees the truth', () => {
    const laid = lay(holding('east', ['decoy']), 'east', 'e5');
    let s = volley(laid, {});
    expect(s.decoys.east).toEqual([{ cells: ['e5', 'f5'], hits: [], revealed: false }]);
    expect(viewOf(s, 'east').mySea!.decoy).toEqual({ cells: ['e5', 'f5'], hits: [] });
    expect(viewOf(s, 'north').mySea!.decoy).toBeNull();
    expect(viewOf(s, 'north').holding.east).toBe(0);
    // Laying one is told at the reveal, never where.
    expect(s.lastVolley!.items).toEqual([{ item: 'decoy-laid', from: 'east' }]);
    const told = roundSummary(laid, s);
    expect(told).toContain('{east} slips a decoy into the water.');
    expect(told.find((x) => x.includes('decoy'))).not.toMatch(/\b[a-h][1-8]\b/);
    expect(JSON.stringify(viewOf(s, 'north').targets.find((t) => t.sea === 'east'))).not.toMatch(/e5|f5/);
    expect(viewOf(s, 'east').ascii.split('\n')).toContain('5 F F F . d d . .');
    const before = s;
    const scrap = s.scrap.north;
    s = volley(s, { north: ['east', 'e5'] });
    expect(s.shots.east.e5).toEqual({ result: 'hit', by: ['north'] });
    expect(s.lastVolley!.shells.find((x) => x.from === 'north' && x.cell === 'e5')).toMatchObject({ result: 'hit', ship: null });
    expect(s.scrap.north - scrap).toBe(1);
    expect(s.hitsLanded.north).toBe(1);
    for (const viewer of ['north', 'south', 'west', null]) {
      const t = targetOf(s, viewer, 'east');
      expect(t.hits).toEqual(['e5']);
      expect(t.afloat).toBe(11);
      expect(t.decoys).toEqual([]);
    }
    expect(targetOf(s, 'north', 'east').mine).toEqual([{ cell: 'e5', result: 'hit' }]);
    expect(viewOf(s, 'north').ascii.split('\n')).toContain('5 . . . . X . . .');
    expect(viewOf(s, 'east').mySea!.decoy).toEqual({ cells: ['e5', 'f5'], hits: ['e5'] });
    expect(viewOf(s, 'east').ascii.split('\n')).toContain('5 F F F . x d . .');
    expect(viewOf(s, 'east').ascii).not.toContain('driftwood'); // live: the owner's legend must not call it found
    expect(roundSummary(before, s)[0]).toContain('{north} hits {east} at e5');
    expect(roundSummary(before, s).join(' ')).not.toContain('DECOY');
    // Guns and fleets never count a decoy.
    expect(viewOf(s, 'north').guns.east).toBe(4);
  });

  test('fog counts and sonar readings count real ship cells only: a decoy is invisible to them', () => {
    let s = decoyed();
    s = volley(s, { north: [['east', 'e5'], ['east', 'f5', 'buoy']] });
    // The buoy at f5 hears e4–g6: the decoy (one cell hit, one not) is all there is, and it hears nothing.
    expect(targetOf(s, 'north', 'east').sonar).toEqual([{ cell: 'f5', round: 2, cells: buoyCells('f5'), afloat: 0 }]);
    expect(targetOf(s, 'north', 'east').afloat).toBe(11); // the public count is fooled
    // A decoy in a lifted row: the count is the real ships' alone.
    let t = holding('east', ['decoy']);
    t = volley(lay(t, 'east', 'e8'), {});
    t.round = FOG_FROM; // row 8 lifts
    expect(targetOf(t, 'north', 'east').lifted).toEqual([{ row: 8, afloat: 0 }]);
    let u = holding('east', ['decoy']);
    u = volley(lay(u, 'east', 'c7'), {}); // beside the submarine (a7–b7)
    u.round = FOG_FROM + 1; // rows 8 and 1
    u = { ...u };
    expect(targetOf(u, 'north', 'east').lifted).toEqual([
      { row: 8, afloat: 0 },
      { row: 1, afloat: 4 },
    ]);
    u.round = FOG_FROM + 2; // and row 7: the submarine's two cells, never the decoy's
    expect(targetOf(u, 'north', 'east').lifted.find((x) => x.row === 7)).toEqual({ row: 7, afloat: 2 });
  });

  test('both cells hit: the decoy is revealed — told, result decoy, no sinking scrap, no crate, afloat back', () => {
    let s = decoyHit(decoyed());
    s.hitsLanded.north = 1;
    const before = s;
    const scrap = s.scrap.north;
    s = volley(s, { north: ['east', 'f5'] });
    const v = s.lastVolley!;
    expect(v.items).toEqual([{ item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north'] }]);
    expect(v.shells.find((x) => x.from === 'north' && x.cell === 'f5')).toMatchObject({ result: 'decoy', ship: null });
    expect(v.sunk).toEqual([]);
    expect(s.scrap.north - scrap).toBe(1); // the hit, nothing for the "sinking"
    expect(s.hitsLanded.north).toBe(2);
    expect(s.crates.north).toEqual([]);
    expect(s.decoys.east).toEqual([{ cells: ['e5', 'f5'], hits: ['e5', 'f5'], revealed: true }]);
    for (const viewer of ['north', 'south', null]) {
      const t = targetOf(s, viewer, 'east');
      expect(t.decoys).toEqual([['e5', 'f5']]);
      expect(t.hits).toEqual([]);
      expect(t.misses).toEqual([]);
      expect(t.afloat).toBe(12);
    }
    expect(targetOf(s, 'north', 'east').mine).toEqual([
      { cell: 'e5', result: 'decoy' },
      { cell: 'f5', result: 'decoy' },
    ]);
    expect(viewOf(s, 'east').mySea!.decoy).toBeNull();
    expect(viewOf(s, 'north').ascii.split('\n')).toContain('5 . . . . ~ ~ . .');
    expect(viewOf(s, 'north').ascii).toContain('~ = a decoy, found: driftwood');
    expect(viewOf(s, 'east').ascii.split('\n')).toContain('5 F F F . ~ ~ . .');
    const lines = roundSummary(before, s);
    expect(lines).toContain("{north}'s shell finds {east}'s DECOY — nothing but driftwood.");
    expect(lines.join(' ')).not.toContain('crate');
    expect(lines[0]).toBe('Round 2: 15 misses.'); // the fillers; the finding shell is told on its own line, never as a miss
    // Found, it frees the sea for another decoy; a shell on driftwood is a miss.
    s.arsenal.east = ['decoy'];
    expect(usesOf(s, 'east')).toContainEqual({ use: 'decoy', at: 'e7', facing: 'east' });
    // The fillers' columns (open water on every other sea) are nearly spent after three volleys: free them.
    for (const sea of ['north', 'south', 'west']) for (const c of Object.keys(s.shots[sea])) if ('efgh'.includes(c[0])) delete s.shots[sea][c];
    s = volley(s, { south: ['east', 'e5'] });
    expect(s.lastVolley!.shells.find((x) => x.from === 'south' && x.cell === 'e5')!.result).toBe('miss');
    expect(s.shots.east.e5).toEqual({ result: 'hit', by: ['north', 'south'] });
    expect(targetOf(s, 'west', 'east')).toMatchObject({ decoys: [['e5', 'f5']], hits: [], afloat: 12 });
  });

  test('two shooters finish a decoy together; a cluster or a torpedo is named when it did', () => {
    let s = decoyed();
    const before = s;
    s = volley(s, { north: ['east', 'e5'], south: ['east', 'f5'] });
    expect(s.lastVolley!.items).toEqual([{ item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north', 'south'] }]);
    expect(s.lastVolley!.shells.filter((x) => x.sea === 'east').map((x) => x.result)).toEqual(['decoy', 'decoy']);
    expect(roundSummary(before, s)).toContain("{north} and {south}'s shells find {east}'s DECOY — nothing but driftwood.");
    let c = decoyed();
    c.arsenal.north = ['cluster'];
    const cBefore = c;
    c = volley(use(c, 'north', { fire: 'cluster', at: 'east', cell: 'e5' }), {});
    expect(c.lastVolley!.items).toEqual([
      { item: 'cluster', from: 'north', sea: 'east', cell: 'e5', cells: ['e5', 'e4', 'd5', 'f5', 'e6'], hits: ['e5', 'f5'] },
      { item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north'] },
    ]);
    expect(roundSummary(cBefore, c)).toContain("{north}'s cluster finds {east}'s DECOY — nothing but driftwood.");
    let t = holding('east', ['decoy']);
    t = volley(lay(t, 'east', 'e5', 'north'), {}); // e5–e6
    t.arsenal.north = ['torpedo'];
    t = decoyHit(t);
    const tBefore = t;
    t = volley(use(t, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }), {}); // down column e: e6 is the first unhit target
    expect(t.lastVolley!.items[0]).toMatchObject({ item: 'torpedo', path: ['e8', 'e7', 'e6'], struck: 'e6' });
    expect(roundSummary(tBefore, t)).toContain("{north}'s torpedo finds {east}'s DECOY — nothing but driftwood.");
  });

  test('a decoy finished in the volley that also sinks a real ship: the real sinking is credited and crated, the decoy only told', () => {
    const s0 = decoyHit(decoyed());
    preHit(s0, 'east', ['a7'], 'north');
    let s = s0;
    const before = s;
    const scrap = s.scrap.north;
    s = volley(s, { north: [['east', 'b7'], ['east', 'f5']] });
    const v = s.lastVolley!;
    expect(v.sunk).toEqual([{ sea: 'east', ship: 'submarine', by: ['north'] }]);
    expect(v.items).toEqual([{ item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north'] }]);
    expect(v.shells.find((x) => x.cell === 'b7' && x.sea === 'east')).toMatchObject({ result: 'sunk', ship: 'submarine' });
    expect(v.shells.find((x) => x.cell === 'f5' && x.sea === 'east')).toMatchObject({ result: 'decoy', ship: null });
    expect(s.scrap.north - scrap).toBe(1 + 3 + 1); // b7, the sinking, f5
    expect(s.crates.north).toHaveLength(1);
    expect(viewOf(s, 'north').guns.east).toBe(3);
    const lines = roundSummary(before, s);
    expect(lines[0]).toContain("{north} sinks {east}'s submarine");
    expect(lines).toContain("{north}'s shell finds {east}'s DECOY — nothing but driftwood.");
    expect(lines.filter((x) => x.includes('crate'))).toEqual(['{north} pulls a crate from the wreck.']);
  });

  test("a fleet whose ships are all sunk is out, its live decoy notwithstanding", () => {
    let s = decoyed();
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'), 'north');
    s = volley(s, { north: ['east', 'b7'] });
    expect(isOut(s, 'east')).toBe(true);
    expect(s.lastVolley!.eliminated).toEqual(['east']);
  });

  test('a torpedo stops at a decoy cell; a decoy or a repair landed the same volley stops it too', () => {
    // A decoy laid last round.
    let s = decoyed();
    s.arsenal.north = ['torpedo'];
    s = volley(use(s, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }), {});
    expect(s.lastVolley!.items[0]).toMatchObject({ item: 'torpedo', path: ['e8', 'e7', 'e6', 'e5'], struck: 'e5' });
    expect(s.shots.east.e5).toEqual({ result: 'hit', by: ['north'] });
    expect(s.decoys.east[0].hits).toEqual(['e5']);
    expect(targetOf(s, 'south', 'east').afloat).toBe(11);
    // A decoy laid this very volley: decoys land before the torpedo reads the lane.
    let t = holding('east', ['decoy']);
    t.arsenal.north = ['torpedo'];
    t = lay(t, 'east', 'e5');
    t = volley(use(t, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }), {});
    expect(t.lastVolley!.items).toEqual([
      { item: 'torpedo', from: 'north', sea: 'east', lane: 'e', path: ['e8', 'e7', 'e6', 'e5'], struck: 'e5' },
      { item: 'decoy-laid', from: 'east' },
    ]);
    expect(t.decoys.east[0].hits).toEqual(['e5']);
    // A cell repaired this very volley: unhit again before the torpedo reads the lane.
    let r = holding('east', ['repair']);
    r.arsenal.west = ['torpedo'];
    preHit(r, 'east', ['a1'], 'north');
    r = repair(r, 'east', 'a1');
    r = volley(use(r, 'west', { fire: 'torpedo', at: 'east', lane: '1' }), {}); // east along row 1 from a1
    expect(r.lastVolley!.items).toEqual([
      { item: 'repair', from: 'east', cell: 'a1' },
      { item: 'torpedo', from: 'west', sea: 'east', lane: '1', path: ['a1'], struck: 'a1' },
    ]);
    expect(r.shots.east.a1).toEqual({ result: 'hit', by: ['west'] });
    expect(r.repairs.east).toEqual([]);
  });

  test('a Time on Target over a decoy hits it like a ship', () => {
    let s = decoyed();
    s = volley(s, { north: ['east', 'e4'], south: ['east', 'e4'] }); // the 3×3 takes e5 and f5
    expect(s.lastVolley!.blasts[0]).toMatchObject({ sea: 'east', cell: 'e4', hits: ['e5', 'f5'] });
    expect(s.lastVolley!.items).toEqual([{ item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north', 'south'] }]);
    expect(s.hitsLanded).toMatchObject({ north: 2, south: 2 });
  });

  test("a ghost's mine on a live decoy cell backfires the decoy: both cells for the shooter, revealed, no crate", () => {
    let s = withGhost(); // west is a ghost; north sank west's submarine
    s = turn.apply(s, 'north', { crate: 'pass' });
    s.arsenal.east = ['decoy'];
    s = lay(s, 'east', 'e5');
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e5' }); // the ghost can't know a decoy is landing there
    const before = s;
    const scrap = s.scrap.north;
    s = volley(s, { north: ['east', 'e5'] });
    // Never a boomerang: that would read "e5 is water" beside a hit at e5, and name the decoy's cell.
    expect(tricksIn(s)).toEqual([{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'e5', shooters: ['north'], result: 'backfire', ship: 'decoy' }]);
    expect(s.decoys.east[0]).toEqual({ cells: ['e5', 'f5'], hits: ['e5', 'f5'], revealed: true });
    expect(s.shots.east.e5).toEqual({ result: 'hit', by: ['north'] });
    expect(s.shots.east.f5).toEqual({ result: 'hit', by: ['north'] });
    expect(s.shots.north.c5).toBeUndefined(); // nothing came back on north
    expect(s.lastVolley!.items).toContainEqual({ item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north'] });
    expect(s.lastVolley!.sunk).toEqual([]);
    expect(s.scrap.north - scrap).toBe(2); // a hit each, nothing for the "sinking"
    expect(s.crates.north).toEqual([]);
    expect(s.mines).toEqual([]);
    expect(targetOf(s, 'south', 'east')).toMatchObject({ decoys: [['e5', 'f5']], hits: [], afloat: 12 });
    const lines = roundSummary(before, s);
    expect(lines).toContain("Backfire! {west}'s mine was sitting on {east}'s DECOY. {north}'s shell blows it out of the water.");
    expect(lines.join(' ')).not.toContain('driftwood'); // told once, by the backfire
    expect(lines).toContain('{east} slips a decoy into the water.');
  });

  test('a re-shot on a live decoy cell already hit, by another seat, reads hit and pays nothing, like a ship cell', () => {
    const s0 = decoyHit(decoyed()); // north hit e5 earlier
    const scrap = s0.scrap.south;
    const s = volley(s0, { south: ['east', 'e5'] });
    expect(s.lastVolley!.shells.find((x) => x.from === 'south' && x.cell === 'e5')).toMatchObject({ result: 'hit', ship: null });
    expect(s.shots.east.e5).toEqual({ result: 'hit', by: ['north', 'south'] });
    expect(s.scrap.south).toBe(scrap);
    expect(s.hitsLanded.south).toBe(0);
    expect(s.decoys.east[0]).toMatchObject({ hits: ['e5'], revealed: false });
    // The same on a real ship's hit cell.
    const r0 = deployed();
    preHit(r0, 'east', ['a1'], 'north');
    const r = volley(r0, { south: ['east', 'a1'] });
    expect(r.lastVolley!.shells.find((x) => x.from === 'south' && x.cell === 'a1')).toMatchObject({ result: 'hit', ship: null });
    expect(r.scrap.south).toBe(0);
  });

  test('the public afloat never reads below 1 for a living fleet, and reads 0 once it is out', () => {
    const s = decoyHit(decoyed());
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'), 'north'); // one real cell left, one decoy hit: 12 − 12
    expect(targetOf(s, 'north', 'east').afloat).toBe(1);
    const out = volley(s, { north: ['east', 'b7'] }); // the last real cell: out, with a decoy hit on show
    expect(isOut(out, 'east')).toBe(true);
    expect(targetOf(out, 'north', 'east').afloat).toBe(0);
    expect(targetOf(out, null, 'east').hits).toContain('e5');
  });

  test('a decoy found by a mix of weapons is told as "shots"; by the same kind, that kind', () => {
    let s = decoyed();
    s.arsenal.north = ['torpedo'];
    const before = s;
    s = use(s, 'north', { fire: 'torpedo', at: 'east', lane: 'e' }); // down column e: struck at e5
    s = volley(s, { south: ['east', 'f5'] });
    expect(s.lastVolley!.items).toContainEqual({ item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north', 'south'] });
    expect(roundSummary(before, s)).toContain("{north} and {south}'s shots find {east}'s DECOY — nothing but driftwood.");
    let t = decoyed();
    t.arsenal.north = ['cluster'];
    t.arsenal.south = ['cluster'];
    const tBefore = t;
    t = use(t, 'north', { fire: 'cluster', at: 'east', cell: 'e6' }); // e5 is its southern arm
    t = use(t, 'south', { fire: 'cluster', at: 'east', cell: 'f4' }); // f5 is its northern arm
    t = volley(t, {});
    expect(t.lastVolley!.items).toContainEqual({ item: 'decoy', sea: 'east', cells: ['e5', 'f5'], by: ['north', 'south'] });
    expect(roundSummary(tBefore, t)).toContain("{north} and {south}'s clusters find {east}'s DECOY — nothing but driftwood.");
  });

  test('a false splash reads the public afloat count: a sea fooled down to one by a decoy hit refuses it', () => {
    let s = withGhost();
    s = turn.apply(s, 'north', { crate: 'pass' });
    s.arsenal.east = ['decoy'];
    s = lay(s, 'east', 'e5');
    s = haunt(volley(s, {}));
    // East: every ship cell hit but a7 and b7 (two unhit), and its decoy hit once: the table reads one afloat.
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'a7' && c !== 'b7'), 'north');
    s = volley(s, { north: ['east', 'e5'] });
    s = haunt(s);
    expect(targetOf(s, 'north', 'east').afloat).toBe(1);
    expect(codeOf(() => trick(s, 'west', { trick: 'splash', fool: 'north', at: 'east', cell: 'h8' }))).toBe('LAST_CELL');
    expect(tricksOf(s, 'west').some((x) => x.trick === 'splash' && x.at === 'east')).toBe(false);
  });

  test('narration of a repair or a decoy never names it: "fires", "is ready"', () => {
    const s = holding('east', ['repair', 'decoy']);
    preHit(s, 'east', ['a1']);
    for (const cmd of [{ use: 'repair', cell: 'a1' }, { use: 'decoy', at: 'e5', facing: 'east' }]) {
      expect(turn.describe!(cmd)).toBe('fires');
      expect(turn.narrate!(s, use(s, 'east', cmd), 'east', cmd)).toBe('is ready');
    }
  });
});

// ── Whisper: a ghost auctions a sonar reading ──

const T0 = 1_700_000_000_000;
const clockAt = (s: SalvoState, now: number) => turn.clock!(s, now);
const bid = (s: SalvoState, seat: string, n: unknown, ghost?: string) => turn.apply(s, seat, ghost === undefined ? { bid: n } : { bid: n, ghost });
const tell = (s: SalvoState, seat: string, n: unknown) => turn.apply(s, seat, { tell: n });
/**
 * West (a ghost) lists a whisper on east's d4 (c3–e5: east's c3 and c5 are ship cells, so the truth is 2) in
 * round 2; the living fire (`shots`, fillers for the rest): round 3 opens with the auction open. North has 4
 * scrap (it sank west), the others none.
 */
function listed(shots: Record<string, Shot | Shot[]> = {}, cell = 'd4', sea = 'east'): SalvoState {
  let s = withGhost();
  s = trick(s, 'west', { trick: 'whisper', at: sea, cell });
  return volley(s, shots);
}
/** The same, with the auction stamped open at T0 and some scrap to bid with. */
function bidding(scrap: Record<string, number> = { north: 10, east: 10, south: 10 }): SalvoState {
  const s = clockAt(listed(), T0);
  Object.assign(s.scrap, scrap);
  return s;
}
const whisperOf = (s: SalvoState) => s.auctions.at(-1)!;
const bidsIn = (l: unknown[]) => (l as SalvoCommand[]).filter((c) => 'bid' in c);
const tellsIn = (l: unknown[]) => (l as SalvoCommand[]).filter((c) => 'tell' in c);

describe('whisper: the listing', () => {
  test("a ghost's tricks include a whisper on every buoy centre (b2–g7) of every living sea", () => {
    const s = withGhost();
    const whispers = (turn.legal(s, 'west') as SalvoCommand[]).filter((c) => 'trick' in c && c.trick === 'whisper') as { trick: 'whisper'; at: string; cell: string }[];
    expect(whispers.length).toBe(3 * 36);
    expect(whispers.every((c) => ['north', 'east', 'south'].includes(c.at) && isBuoyCentre(c.cell))).toBe(true);
    expect(whispers[0]).toEqual({ trick: 'whisper', at: 'north', cell: 'b2' });
    // Whispers come after the mines and the splashes.
    const legal = turn.legal(s, 'west') as SalvoCommand[];
    expect(legal.findIndex((c) => 'trick' in c && c.trick === 'whisper')).toBe(legal.length - 108);
  });

  test('illegal listings carry precise codes', () => {
    const s = withGhost();
    expect(codeOf(() => trick(s, 'west', { trick: 'whisper', at: 'east', cell: 'a1' }))).toBe('BAD_AREA');
    expect(codeOf(() => trick(s, 'west', { trick: 'whisper', at: 'east', cell: 'h8' }))).toBe('BAD_AREA');
    expect(codeOf(() => trick(s, 'west', { trick: 'whisper', at: 'east', cell: 'z9' }))).toBe('BAD_CELL');
    expect(codeOf(() => trick(s, 'west', { trick: 'whisper', at: 'west', cell: 'd4' }))).toBe('BAD_TARGET');
    expect(codeOf(() => trick(s, 'north', { trick: 'whisper', at: 'east', cell: 'd4' }))).toBe('NOT_A_GHOST');
    // A shot cell is no bar: the area is listed, not shot.
    const shot = structuredClone(s);
    preHit(shot, 'east', ['d4']);
    expect(codeOf(() => trick(shot, 'west', { trick: 'whisper', at: 'east', cell: 'd4' }))).toBeNull();
  });

  test('the listing is the round\'s trick: secret until the volley, then an open auction and a line', () => {
    let s = withGhost();
    const cmd = { trick: 'whisper', at: 'east', cell: 'd4' };
    const after = trick(s, 'west', cmd);
    expect(after.ready).toEqual(['west']);
    expect(viewOf(after, 'west').myTricks!.pending).toEqual({ trick: 'whisper', at: 'east', cell: 'd4' });
    expect(viewOf(after, 'west').ascii).toContain("Your trick this round: a whisper on east's c3–e5.");
    expect(turn.describe!(cmd)).toBe('plays a dirty trick');
    expect(turn.narrate!(s, after, 'west', cmd)).toBe('is up to something…');
    expect(viewOf(after, 'north').auctions).toEqual([]);
    const round = s.round;
    const before = after;
    s = volley(after, {});
    expect(s.round).toBe(round + 1);
    expect(s.auctions).toEqual([
      {
        ghost: 'west',
        sea: 'east',
        centre: 'd4',
        cells: ['c3', 'd3', 'e3', 'c4', 'd4', 'e4', 'c5', 'd5', 'e5'],
        truth: 2,
        tell: null,
        opensRound: round + 1,
        closesAt: null,
        bids: {},
        abstained: [],
        state: 'open',
        winner: null,
        price: 0,
        closedRound: null,
        closedAt: null,
      },
    ]);
    expect(roundSummary(before, s)).toContain("👻 {west} auctions a sonar reading on {east}'s sea, c3–e5 — 30 seconds.");
  });

  test('the truth counts real ship cells afloat after the listing volley: a hit in it counts, a decoy never does', () => {
    // North hits east's c3 in the listing volley: only c5 is left.
    expect(whisperOf(listed({ north: ['east', 'c3'] })).truth).toBe(1);
    // A live decoy on d4–e4 sits under the area: invisible to it, as to a buoy.
    let s = withGhost();
    s = turn.apply(s, 'north', { crate: 'pass' });
    s.arsenal.east = ['decoy'];
    s = turn.apply(s, 'east', { use: 'decoy', at: 'd4', facing: 'east' });
    s = trick(s, 'west', { trick: 'whisper', at: 'east', cell: 'd4' });
    s = volley(s, {});
    expect(s.decoys.east[0].cells).toEqual(['d4', 'e4']);
    expect(whisperOf(s).truth).toBe(2);
  });

  test('no whisper on offer in the last round (an auction listed then could never open)', () => {
    const s = withGhost();
    s.round = ROUND_CAP - 1;
    expect(tricksOf(s, 'west').some((c) => (c.trick as string) === 'whisper')).toBe(true);
    s.round = ROUND_CAP;
    expect(tricksOf(s, 'west').some((c) => (c.trick as string) === 'whisper')).toBe(false);
    expect(tricksOf(s, 'west').length).toBeGreaterThan(0); // mines and splashes still on offer
  });

  test('one open auction a ghost: no whisper on offer while it runs, and a second is refused', () => {
    const s = listed();
    expect(tricksOf(s, 'west').some((c) => (c.trick as string) === 'whisper')).toBe(false);
    expect(codeOf(() => trick(s, 'west', { trick: 'whisper', at: 'north', cell: 'd4' }))).toBe('AUCTION_OPEN');
    // The ghost still owes its trick for the round (a mine or a splash).
    expect(turn.toMove(s)).toContain('west');
  });

  test('a listing whose sea goes out in its own volley fizzles: no auction, told nothing', () => {
    let s = withGhost();
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = trick(s, 'west', { trick: 'whisper', at: 'east', cell: 'c6' });
    const before = s;
    s = volley(s, { north: ['east', 'b7'] });
    expect(s.eliminated.map((x) => x.seat)).toEqual(['west', 'east']);
    expect(s.auctions).toEqual([]);
    expect(roundSummary(before, s).some((l) => l.includes('auctions') || l.includes('whisper'))).toBe(false);
    // The ghost may list again next round.
    expect(codeOf(() => trick(s, 'west', { trick: 'whisper', at: 'north', cell: 'd4' }))).toBeNull();
  });

  test('a listing in the volley that ends the match never opens', () => {
    let s = deployed(3);
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['south', 'b7'] });
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = trick(s, 'south', { trick: 'whisper', at: 'north', cell: 'd4' });
    const before = s;
    s = volley(s, { north: ['east', 'b7'] });
    expect(s.phase).toBe('over');
    expect(s.auctions).toEqual([]);
    expect(roundSummary(before, s).some((l) => l.includes('auctions'))).toBe(false);
  });
});

describe('whisper: the clock', () => {
  test('the first clock in the opening round stamps closesAt; wakeAt asks for it; nothing due is the same object', () => {
    const s = listed();
    expect(turn.wakeAt!(s)).toBeNull();
    const stamped = clockAt(s, T0);
    expect(whisperOf(stamped).closesAt).toBe(T0 + 30_000);
    expect(turn.wakeAt!(stamped)).toBe(T0 + 30_000);
    expect(clockAt(stamped, T0 + 29_999)).toBe(stamped);
    expect(roundSummary(s, stamped)).toEqual([]);
    expect(viewOf(stamped, null).auctions[0].closesAt).toBe(T0 + 30_000);
  });

  test('a clock at or after closesAt closes it, told in a same-round summary', () => {
    let s = bidding();
    s = bid(s, 'north', 4);
    const closed = clockAt(s, T0 + 30_000);
    expect(closed.round).toBe(s.round);
    expect(whisperOf(closed)).toMatchObject({ state: 'sold', winner: 'north', price: 4, closedRound: s.round });
    expect(roundSummary(s, closed)).toEqual(["{north} wins {west}'s whisper for 4 scrap."]);
    expect(turn.wakeAt!(closed)).toBeNull();
    expect(clockAt(closed, T0 + 60_000)).toBe(closed);
  });

  test('a clock with no auction, or after the match, changes nothing', () => {
    const s = deployed();
    expect(clockAt(s, T0)).toBe(s);
    expect(turn.wakeAt!(s)).toBeNull();
    const over = { ...listed(), phase: 'over' as const };
    expect(clockAt(over, T0)).toBe(over);
    expect(turn.wakeAt!(over)).toBeNull();
  });

  test('wakeAt is the earliest closesAt among open auctions', () => {
    const s = bidding();
    s.auctions.push({ ...structuredClone(whisperOf(s)), ghost: 'north', closesAt: T0 + 10_000 });
    expect(turn.wakeAt!(s)).toBe(T0 + 10_000);
  });
});

describe('whisper: bids', () => {
  test('the living may act during the auction; the ghost may tell; nobody else', () => {
    let s = bidding();
    for (const seat of ['north', 'east', 'south', 'west']) expect(turn.mayAct!(s, seat)).toBe(true);
    expect(turn.mayAct!(withGhost(), 'north')).toBe(false);
    expect(turn.mayAct!(withGhost(), 'west')).toBe(false);
    s = clockAt(s, T0 + 30_000);
    for (const seat of ['north', 'east', 'south', 'west']) expect(turn.mayAct!(s, seat)).toBe(false);
  });

  test('a bid is sealed: the table sees bid / abstained / nothing, the bidder its own amount', () => {
    let s = bidding();
    s = bid(s, 'north', 3);
    s = bid(s, 'south', 0);
    const status: Record<string, 'bid' | 'abstained' | null> = { north: 'bid', east: null, south: 'abstained' };
    for (const seat of [null, 'north', 'east', 'south', 'west']) {
      const v = viewOf(s, seat);
      expect(v.auctions).toEqual([{ ghost: 'west', sea: 'east', centre: 'd4', cells: buoyCells('d4'), closesAt: T0 + 30_000, bids: status }]);
      expect(v.myBids).toEqual(seat === 'north' ? { west: 3 } : {});
      expect(v.whispers).toEqual([]);
      expect(v.truths).toBeNull();
    }
    // The amount and the truth are nowhere in another seat's view (north's 3 vs the other views).
    expect(JSON.stringify(viewOf(s, 'east'))).not.toContain('"truth"');
  });

  test('a bid never makes a seat owe or blocks the round; nor does a tell', () => {
    let s = bidding();
    const owing = turn.toMove(s);
    s = bid(s, 'east', 2);
    s = tell(s, 'west', 5);
    expect(turn.toMove(s)).toEqual(owing);
    expect(s.ready).toEqual([]);
    s = salvo(s, 'north');
    expect(s.ready).toEqual(['north']);
    s = bid(s, 'north', 1); // north owes nothing now: an optional move
    expect(s.ready).toEqual(['north']);
    expect(turn.toMove(s)).not.toContain('north');
  });

  test('a bid is replaced, withdrawn with 0, and ties go to the earliest time that amount was placed', () => {
    let s = bidding();
    s = bid(s, 'east', 5);
    s = bid(s, 'south', 5);
    s = bid(s, 'east', 5); // the same amount again keeps its place
    expect(whisperOf(s).bids.east!.at).toBeLessThan(whisperOf(s).bids.south!.at);
    expect(whisperOf(clockAt(s, T0 + 30_000))).toMatchObject({ winner: 'east', price: 5 });
    s = bid(s, 'east', 4);
    s = bid(s, 'east', 5); // a new time: now after south's
    expect(whisperOf(clockAt(s, T0 + 30_000))).toMatchObject({ winner: 'south', price: 5 });
    s = bid(s, 'south', 0); // withdrawn: abstains
    expect(viewOf(s, null).auctions[0].bids.south).toBe('abstained');
    expect(whisperOf(clockAt(s, T0 + 30_000))).toMatchObject({ winner: 'east', price: 5 });
    s = bid(s, 'south', 6); // back in: no longer abstaining
    expect(viewOf(s, null).auctions[0].bids.south).toBe('bid');
    expect(whisperOf(clockAt(s, T0 + 30_000))).toMatchObject({ winner: 'south', price: 6 });
  });

  test('a bid or tell that changes nothing hands back the very same state (no revision for a spinning agent)', () => {
    let s = bidding();
    s = bid(s, 'east', 3);
    expect(bid(s, 'east', 3)).toBe(s); // that bid already stands
    expect(bid(s, 'east', 4)).not.toBe(s);
    s = bid(s, 'south', 0);
    expect(bid(s, 'south', 0)).toBe(s); // already abstained
    expect(bid(s, 'north', 0)).not.toBe(s); // first abstention is news
    s = bid(s, 'east', 0); // withdrawn
    expect(bid(s, 'east', 0)).toBe(s);
    expect(bid(s, 'east', 3)).not.toBe(s); // back in at the same amount it withdrew
    s = tell(s, 'west', 4);
    expect(tell(s, 'west', 4)).toBe(s);
    expect(tell(s, 'west', 5)).not.toBe(s);
    // Errors still throw rather than no-op.
    expect(codeOf(() => bid(s, 'east', 99))).toBe('BAD_BID');
  });

  test("the winner pays the ghost; only the winner hears the ghost's word (the truth unless it told otherwise)", () => {
    let s = bidding({ north: 10, east: 8, south: 3 });
    s.scrap.west = 1;
    s = bid(s, 'east', 4);
    s = bid(s, 'south', 3);
    let closed = clockAt(s, T0 + 30_000);
    expect(closed.scrap).toMatchObject({ north: 10, east: 4, south: 3, west: 5 });
    expect(viewOf(closed, 'east').whispers).toEqual([{ ghost: 'west', sea: 'east', cells: buoyCells('d4'), said: 2, paid: 4, at: T0 + 30_000 }]);
    for (const seat of [null, 'north', 'south', 'west']) expect(viewOf(closed, seat).whispers).toEqual([]);
    expect(viewOf(closed, null).auctions).toEqual([]);
    s = tell(s, 'west', 7);
    closed = clockAt(s, T0 + 30_000);
    expect(viewOf(closed, 'east').whispers[0].said).toBe(7);
    expect(viewOf(closed, 'east').ascii).toContain('👻 west says 7 ship cells in east\'s c3–e5');
  });

  test('no bids: no sale, no scrap moves', () => {
    let s = bidding();
    s = bid(s, 'north', 0);
    const closed = clockAt(s, T0 + 30_000);
    expect(whisperOf(closed)).toMatchObject({ state: 'unsold', winner: null, price: 0 });
    expect(closed.scrap).toEqual(s.scrap);
    expect(roundSummary(s, closed)).toEqual(["Nobody bids on {west}'s whisper."]);
  });

  test('the sea\'s owner may bid to bury it', () => {
    let s = bidding();
    s = bid(s, 'east', 9);
    s = bid(s, 'north', 2);
    expect(whisperOf(clockAt(s, T0 + 30_000))).toMatchObject({ winner: 'east', price: 9 });
  });

  test('refused bids carry precise codes', () => {
    const s = bidding({ north: 4, east: 0, south: 10 });
    expect(codeOf(() => bid(withGhost(), 'north', 1))).toBe('NO_AUCTION');
    expect(codeOf(() => bid(s, 'west', 1))).toBe('OWN_WHISPER');
    expect(codeOf(() => bid(s, 'north', -1))).toBe('BAD_BID');
    expect(codeOf(() => bid(s, 'north', 1.5))).toBe('BAD_BID');
    expect(codeOf(() => bid(s, 'north', '3'))).toBe('BAD_BID');
    expect(codeOf(() => bid(s, 'north', 5))).toBe('BAD_BID'); // more than its scrap
    expect(codeOf(() => bid(s, 'east', 1))).toBe('BAD_BID');
    expect(codeOf(() => bid(s, 'east', 0))).toBeNull(); // abstaining costs nothing
    expect(codeOf(() => bid(s, 'north', 4))).toBeNull(); // all of it
    expect(codeOf(() => bid(s, 'north', 1, 'south'))).toBe('NO_AUCTION');
    expect(codeOf(() => bid(s, 'north', 1, 'west'))).toBeNull();
    expect(codeOf(() => turn.apply(s, 'north', { bid: 1, ghost: 7 }))).toBe('BAD_COMMAND');
  });

  test('refused tells carry precise codes', () => {
    const s = bidding();
    expect(codeOf(() => tell(s, 'north', 3))).toBe('NOT_YOUR_AUCTION');
    expect(codeOf(() => tell(withGhost(), 'west', 3))).toBe('NOT_YOUR_AUCTION');
    for (const n of [-1, 10, 2.5, '3', null]) expect(codeOf(() => tell(s, 'west', n))).toBe('BAD_TELL');
    for (const n of [0, 9]) expect(codeOf(() => tell(s, 'west', n))).toBeNull();
    const told = tell(tell(s, 'west', 0), 'west', 4); // changeable until the close
    expect(whisperOf(told).tell).toBe(4);
  });

  test("the ghost sees its truth and its tell; nobody else does", () => {
    let s = bidding();
    expect(viewOf(s, 'west').myTricks!.whisper).toEqual({ truth: 2, tell: null });
    s = tell(s, 'west', 6);
    expect(viewOf(s, 'west').myTricks!.whisper).toEqual({ truth: 2, tell: 6 });
    expect(viewOf(s, 'west').ascii).toContain('Your whisper on east\'s c3–e5: the truth is 2; you will tell 6.');
    for (const seat of [null, 'north', 'east', 'south']) {
      const v = viewOf(s, seat);
      expect(v.myTricks).toBeNull();
      expect(JSON.stringify(v)).not.toContain('"tell"');
      expect(v.ascii).not.toContain('truth');
    }
    expect(viewOf(withGhost(), 'west').myTricks!.whisper).toBeNull();
  });

  test('legal: a seat that owes nothing gets its bids only (0..min(scrap, 20)); an owing seat its owed commands first', () => {
    let s = bidding({ north: 3, east: 25, south: 0 });
    // Owing: shells and buoys first, then the bids.
    const north = turn.legal(s, 'north') as SalvoCommand[];
    expect(bidsIn(north)).toEqual([0, 1, 2, 3].map((n) => ({ bid: n, ghost: 'west' })));
    expect(north.slice(-4)).toEqual(bidsIn(north));
    expect('fire' in north[0]).toBe(true);
    expect(bidsIn(turn.legal(s, 'east')).length).toBe(21);
    expect(bidsIn(turn.legal(s, 'south'))).toEqual([{ bid: 0, ghost: 'west' }]);
    // Ready: the bids alone.
    s = salvo(s, 'north');
    expect(turn.legal(s, 'north')).toEqual([0, 1, 2, 3].map((n) => ({ bid: n, ghost: 'west' })));
    // Every one of them applies.
    for (const c of turn.legal(s, 'north')) expect(codeOf(() => turn.apply(s, 'north', c))).toBeNull();
    // The ghost: its owed tricks first, then its tells 0–9.
    const west = turn.legal(s, 'west') as SalvoCommand[];
    expect('trick' in west[0]).toBe(true);
    expect(tellsIn(west)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ tell: n })));
    expect(west.slice(-10)).toEqual(tellsIn(west));
    expect(bidsIn(west)).toEqual([]);
    // A ghost that has played its trick: its tells alone.
    s = trick(s, 'west', { trick: 'mine', at: 'south', cell: 'h1' });
    expect(turn.legal(s, 'west')).toEqual(tellsIn(west));
  });

  test('a bid from a seat that owes nothing applies (mayAct); after the close it is refused AUCTION_CLOSED', () => {
    let s = bidding();
    s = salvo(s, 'north');
    s = bid(s, 'north', 2);
    expect(whisperOf(s).bids.north!.n).toBe(2);
    const closed = clockAt(s, T0 + 30_000);
    expect(codeOf(() => bid(closed, 'north', 3))).toBe('AUCTION_CLOSED');
    expect(codeOf(() => bid(closed, 'east', 3))).toBe('AUCTION_CLOSED');
    expect(codeOf(() => bid(closed, 'east', 3, 'west'))).toBe('AUCTION_CLOSED');
    expect(codeOf(() => tell(closed, 'west', 3))).toBe('AUCTION_CLOSED');
    expect(turn.legal(closed, 'north')).toEqual([]);
    expect(bidsIn(turn.legal(closed, 'east'))).toEqual([]);
  });
});

describe('whisper: the close', () => {
  test('Review Focus 1: the round resolving before 30 s closes it with the bids so far, before the volley', () => {
    let s = bidding({ north: 10, east: 10, south: 10 });
    s = bid(s, 'south', 3);
    const before = s;
    s = haunt(volley(s, {}));
    expect(s.round).toBe(before.round + 1);
    expect(s.auctions[0]).toMatchObject({ state: 'sold', winner: 'south', price: 3, closedRound: before.round });
    expect(s.scrap.south).toBe(7);
    expect(s.scrap.west).toBe(3);
    const lines = roundSummary(before, s);
    expect(lines[0]).toBe("{south} wins {west}'s whisper for 3 scrap.");
    expect(turn.wakeAt!(s)).toBeNull();
    // Sold with no clock to hand: the clock right after the resolution stamps when, and closes nothing else.
    expect(s.auctions[0].closedAt).toBeNull();
    expect(viewOf(s, 'south').whispers[0]).toMatchObject({ paid: 3, at: null });
    const stamped = clockAt(s, T0 + 12_000);
    expect(stamped.auctions).toEqual([{ ...s.auctions[0], closedAt: T0 + 12_000 }]);
    expect(stamped.lastNow).toBe(T0 + 12_000);
    expect(viewOf(stamped, 'south').whispers).toEqual([{ ghost: 'west', sea: 'east', cells: buoyCells('d4'), said: 2, paid: 3, at: T0 + 12_000 }]);
    // …once: the next clock is no change.
    expect(clockAt(stamped, T0 + 31_000)).toBe(stamped);
  });

  test('a won whisper carries its close time (the clock that closed it) and the price paid', () => {
    let s = bidding({ north: 10, east: 10, south: 10 });
    expect(s.lastNow).toBe(T0);
    s = bid(s, 'north', 6);
    const closed = clockAt(s, T0 + 30_250);
    expect(whisperOf(closed).closedAt).toBe(T0 + 30_250);
    expect(viewOf(closed, 'north').whispers).toEqual([{ ghost: 'west', sea: 'east', cells: buoyCells('d4'), said: 2, paid: 6, at: T0 + 30_250 }]);
    // Unsold: no close time to tell (and nobody's whispers).
    const unsold = clockAt(bidding(), T0 + 30_000);
    expect(whisperOf(unsold)).toMatchObject({ state: 'unsold', closedAt: null });
  });

  test("a state saved before close times were kept reads at: null and isn't restamped on a sale it never had", () => {
    let s = bidding();
    s = bid(s, 'east', 2);
    const closed = clockAt(s, T0 + 30_000);
    const legacy = structuredClone(closed);
    delete legacy.auctions[0].closedAt;
    delete legacy.lastNow;
    expect(viewOf(legacy, 'east').whispers[0].at).toBeNull();
    // A later clock leaves it alone: no close time to invent.
    const later = clockAt(legacy, T0 + 60_000);
    expect(later).toBe(legacy);
    expect(viewOf(later, 'east').whispers[0].at).toBeNull();
  });

  test('an auction never stamped (no clock ran) still closes with its round', () => {
    let s = listed();
    s.scrap.north = 5;
    s = bid(s, 'north', 5);
    s = haunt(volley(s, {}));
    expect(s.auctions[0]).toMatchObject({ state: 'sold', winner: 'north', closesAt: null });
  });

  test('Review Focus 2: a stale bid after the clock closed it is refused, and scrap moves once', () => {
    let s = bidding({ north: 10, east: 10, south: 10 });
    s = bid(s, 'east', 6);
    const closed = clockAt(s, T0 + 30_000);
    expect(closed.scrap.east).toBe(4);
    expect(codeOf(() => bid(closed, 'east', 7))).toBe('AUCTION_CLOSED');
    // The round resolving later closes nothing again.
    const resolved = haunt(volley(closed, {}));
    expect(resolved.scrap.east).toBe(4);
    expect(resolved.scrap.west).toBe(6);
    expect(roundSummary(closed, resolved).some((l) => l.includes('whisper'))).toBe(false);
    // A second clock at the same time is no change.
    expect(clockAt(closed, T0 + 30_000)).toBe(closed);
  });

  test('Review Focus 3: scrap moves only at the close; a bid over your scrap is refused when made, and skipped at the close if you can no longer pay', () => {
    // Two ghosts, two auctions: east bids 5 on each with 6 scrap. The first close takes 5; the second bid is skipped.
    let s = deployed(4);
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['west', 'b7'], east: ['south', 'b7'] });
    expect(G.stillSeated!(s, 'south') && G.stillSeated!(s, 'west')).toBe(true);
    s = trick(s, 'south', { trick: 'whisper', at: 'north', cell: 'd4' });
    s = trick(s, 'west', { trick: 'whisper', at: 'north', cell: 'f6' });
    s = volley(s, {});
    expect(s.auctions.map((a) => a.ghost)).toEqual(['south', 'west']);
    s = clockAt(s, T0);
    s.scrap.east = 6;
    s.scrap.north = 1;
    expect(codeOf(() => bid(s, 'east', 2))).toBe('BAD_COMMAND'); // two open: name the ghost
    expect(codeOf(() => bid(s, 'east', 7, 'south'))).toBe('BAD_BID');
    s = bid(s, 'east', 5, 'south');
    s = bid(s, 'east', 5, 'west');
    s = bid(s, 'north', 1, 'west');
    expect(s.scrap.east).toBe(6); // nothing moves until the close
    expect(viewOf(s, 'east').myBids).toEqual({ south: 5, west: 5 });
    const before = s;
    s = clockAt(s, T0 + 30_000);
    expect(s.auctions.map((a) => [a.state, a.winner, a.price])).toEqual([
      ['sold', 'east', 5],
      ['sold', 'north', 1],
    ]);
    expect(s.scrap).toMatchObject({ east: 1, north: 0, south: 5, west: 1 });
    expect(roundSummary(before, s)).toEqual(["{east} wins {south}'s whisper for 5 scrap.", "{north} wins {west}'s whisper for 1 scrap."]);
    // A ghost may not bid on another ghost's auction.
    expect(codeOf(() => bid(before, 'south', 0, 'west'))).toBe('NO_AUCTION');
    expect(bidsIn(turn.legal(before, 'south'))).toEqual([]);
    expect(viewOf(before, null).auctions.map((a) => Object.keys(a.bids))).toEqual([['north', 'east'], ['north', 'east']]);
  });

  test("a ghost that fades takes its auction with it: no sale, told at the round's end", () => {
    let s = bidding();
    s = bid(s, 'north', 4);
    s = G.forfeit!(s, 'west', 'timeout');
    expect(whisperOf(s)).toMatchObject({ state: 'faded', winner: null });
    expect(s.scrap.north).toBe(10);
    expect(turn.wakeAt!(s)).toBeNull();
    expect(turn.mayAct!(s, 'north')).toBe(false);
    expect(viewOf(s, null).auctions).toEqual([]);
    const before = s;
    s = volley(s, {});
    expect(roundSummary(before, s)).toContain("{west}'s whisper fades with them.");
    // Faded in the same step that resolves the round: told then.
    let t = bidding();
    for (const seat of ['north', 'east', 'south']) t = salvo(t, seat);
    const tBefore = t;
    t = G.forfeit!(t, 'west', 'timeout');
    expect(t.round).toBe(tBefore.round + 1);
    expect(roundSummary(tBefore, t)).toContain("{west}'s whisper fades with them.");
  });

  test('an auction whose sea goes out before the close still closes', () => {
    let s = bidding();
    s = bid(s, 'north', 2);
    s = G.forfeit!(s, 'east', 'resign');
    expect(whisperOf(clockAt(s, T0 + 30_000))).toMatchObject({ state: 'sold', winner: 'north' });
  });

  test("a bidder who leaves before the close is out of it", () => {
    let s = bidding();
    s = bid(s, 'south', 5);
    s = bid(s, 'north', 2);
    s = G.forfeit!(s, 'south', 'resign');
    expect(whisperOf(clockAt(s, T0 + 30_000))).toMatchObject({ winner: 'north', price: 2 });
  });
});

describe('whisper: the end of the match', () => {
  /** North wins east's whisper (west told `told`), then sinks east's and south's last cells: north takes it. */
  function ended(told: number | null): { before: SalvoState; after: SalvoState } {
    let s = bidding();
    s = bid(s, 'north', 3);
    if (told !== null) s = tell(s, 'west', told);
    s = clockAt(s, T0 + 30_000);
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'), 'south');
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'), 'east');
    const before = s;
    return { before, after: haunt(volley(s, { north: [['east', 'b7'], ['south', 'b7']] })) };
  }

  test('every sold whisper is told with its truth in the final summary', () => {
    const lie = ended(3);
    expect(lie.after.phase).toBe('over');
    const lines = roundSummary(lie.before, lie.after);
    expect(lines.at(-1)).toBe("{west} told {north} 3 in {east}'s c3–e5. The truth was 2.");
    expect(lines.at(-2)).toBe('{north} is the last fleet afloat and takes it.');
    const honest = ended(null);
    expect(roundSummary(honest.before, honest.after).at(-1)).toBe("{west} told {north} 2 in {east}'s c3–e5. The truth was 2. An honest ghost!");
  });

  test('once the match is over every auction is public with its truth', () => {
    const { after } = ended(3);
    for (const seat of [null, 'north', 'east', 'west']) {
      expect(viewOf(after, seat).truths).toEqual([
        { ghost: 'west', sea: 'east', centre: 'd4', cells: buoyCells('d4'), truth: 2, said: 3, state: 'sold', winner: 'north', price: 3 },
      ]);
    }
    expect(viewOf(after, 'north').whispers).toEqual([{ ghost: 'west', sea: 'east', cells: buoyCells('d4'), said: 3, paid: 3, at: T0 + 30_000 }]);
    expect(viewOf(after, null).ascii).toContain("west told north 3 in east's c3–e5; the truth was 2.");
  });

  test('the match ending by forfeit while an auction runs closes it with its bids, and tells the truth', () => {
    let s = bidding();
    s = bid(s, 'east', 2);
    s = G.forfeit!(s, 'south', 'resign');
    const before = s;
    s = G.forfeit!(s, 'north', 'resign');
    expect(s.phase).toBe('over');
    expect(whisperOf(s)).toMatchObject({ state: 'sold', winner: 'east', price: 2 });
    // No clock follows the end: the sale takes the last clock time seen (the auction's opening stamp here).
    expect(viewOf(s, 'east').whispers[0]).toMatchObject({ paid: 2, at: T0 });
    expect(roundSummary(before, s)).toEqual([
      "{east} wins {west}'s whisper for 2 scrap.",
      'Everyone else is gone. {east} takes it.',
      "{west} told {east} 2 in {east}'s c3–e5. The truth was 2. An honest ghost!",
    ]);
  });
});

describe('whisper: narration and ascii', () => {
  test('a bid or a tell is described without its number', () => {
    const s = bidding();
    expect(turn.describe!({ bid: 7, ghost: 'west' })).toBe('bids on a whisper');
    expect(turn.describe!({ tell: 3 })).toBe('sets its whisper');
    expect(turn.narrate!(s, bid(s, 'north', 7), 'north', { bid: 7 })).toBe('bids on a whisper');
    expect(turn.narrate!(s, tell(s, 'west', 3), 'west', { tell: 3 })).toBe('sets its whisper');
  });

  test('the ascii lists the open auction with its seats, your own bid alone', () => {
    let s = bidding();
    s = bid(s, 'north', 3);
    s = bid(s, 'south', 0);
    const north = viewOf(s, 'north').ascii;
    expect(north).toContain("👻 30-second ghost intel auction: west's whisper on east's c3–e5. Bids: north bid, east —, south abstained. Your bid: 3.");
    const east = viewOf(s, 'east').ascii;
    expect(east).toContain("👻 30-second ghost intel auction: west's whisper on east's c3–e5. Bids: north bid, east —, south abstained.");
    expect(east).not.toContain('Your bid');
  });
});

describe('whisper: the autopilot', () => {
  /** The engine's autopilot for one seat: random entries of legal not flagged optional, until it owes nothing. */
  function autopilot(s: SalvoState, seat: string, seed: number): SalvoState {
    let rng = seed;
    const next = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
    const round = s.round;
    while (s.round === round && s.phase === 'fire' && turn.toMove(s).includes(seat)) {
      const legal = (turn.legal(s, seat) as unknown[]).filter((c) => !turn.optional!(s, c));
      s = turn.apply(s, seat, legal[Math.floor(next() * legal.length)]);
    }
    return s;
  }

  test('bids and tells are optional; nothing owed is', () => {
    const s = bidding();
    expect(turn.optional!(s, { bid: 3, ghost: 'west' })).toBe(true);
    expect(turn.optional!(s, { tell: 3 })).toBe(true);
    for (const c of [{ fire: 'shell', at: 'east', cell: 'e5' }, { trick: 'mine', at: 'east', cell: 'e5' }, { trick: 'whisper', at: 'east', cell: 'd4' }, { crate: 'pass' }]) {
      expect(turn.optional!(s, c)).toBe(false);
    }
  });

  test("a dozing living seat never bids; a dozing ghost's tell stands", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let s = bidding();
      s = tell(s, 'west', 7);
      // Every bid and tell sits after what's owed in legal: an unfiltered pick would find one often.
      expect(bidsIn(turn.legal(s, 'north')).length).toBe(11);
      for (const seat of ['north', 'east', 'south']) s = autopilot(s, seat, seed);
      expect(whisperOf(s).bids).toEqual({});
      expect(whisperOf(s).abstained).toEqual([]);
      s = autopilot(s, 'west', seed);
      // West's trick resolved the round: the auction closed unsold, west's word still 7.
      expect(whisperOf(s)).toMatchObject({ state: 'unsold', tell: 7 });
    }
  });
});

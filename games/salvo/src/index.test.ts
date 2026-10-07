import { describe, expect, test } from 'bun:test';
import {
  FOG_FROM,
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
 * Time on Target and never hit a STANDARD ship.
 */
function salvo(s: SalvoState, seat: string, shots: Shot[] = [], avoid: string[] = []): SalvoState {
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
    expect(roundSummary(deployed(2), s)).toEqual(["Round 1: {north} sinks {east}'s cruiser and 4 misses."]);
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
    expect(viewOf(s, 'west').myTricks).toEqual({ mines: [], splashes: [], pending: null });
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
    expect(tricksOf(s, 'west').every((c) => c.trick === 'splash')).toBe(true);
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
    expect(tricksOf(s, 'south').every((c) => c.trick === 'mine')).toBe(true);
  });

  test('a ghost with no trick sits out', () => {
    let s = deployed(3);
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['south', 'b7'] });
    s.mines = ['h1', 'h2', 'h3'].map((cell) => ({ ghost: 'south', sea: 'east', cell, round: 1 }));
    expect(turn.legal(s, 'south')).toEqual([]);
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

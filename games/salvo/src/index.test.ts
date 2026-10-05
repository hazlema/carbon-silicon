import { describe, expect, test } from 'bun:test';
import {
  FOG_FROM,
  ROUND_CAP,
  SEATS,
  SHIPS,
  TURN_SECONDS,
  cellIndex,
  cellName,
  hullCells,
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

/** Every living seat fires once, in seat order; `shots` maps seat → [sea, cell]. */
function volley(s: SalvoState, shots: Record<string, [string, string]>): SalvoState {
  for (const seat of s.seats) if (shots[seat]) s = fire(s, seat, shots[seat][0], shots[seat][1]);
  return s;
}

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
  test('the fog lifts one row a round from round 10, edges inward', () => {
    expect(FOG_FROM).toBe(10);
    expect(liftedRows(0)).toEqual([]);
    expect(liftedRows(9)).toEqual([]);
    expect(liftedRows(10)).toEqual([8]);
    expect(liftedRows(11)).toEqual([8, 1]);
    expect(liftedRows(12)).toEqual([8, 1, 7]);
    expect(liftedRows(17)).toEqual([8, 1, 7, 2, 6, 3, 5, 4]);
    expect(liftedRows(30)).toEqual([8, 1, 7, 2, 6, 3, 5, 4]);
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
        expect(s.pending[seat]).toBeNull();
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
  test('legal is one shell at each living opponent sea, per unshot cell', () => {
    const s = deployed();
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    expect(legal).toHaveLength(192);
    expect(legal[0]).toEqual({ fire: 'shell', at: 'east', cell: 'a1' });
    expect(legal[63]).toEqual({ fire: 'shell', at: 'east', cell: 'h8' });
    expect(legal[64]).toEqual({ fire: 'shell', at: 'south', cell: 'a1' });
    expect(turn.legal(deployed(3), 'north')).toHaveLength(128);
    expect(turn.legal(deployed(2), 'north')).toHaveLength(64);
    const next = volley(s, { north: ['east', 'h8'], east: ['north', 'h8'], south: ['north', 'h7'], west: ['north', 'h6'] });
    expect(turn.legal(next, 'north')).toHaveLength(191);
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
    const ready = fire(s, 'north', 'east', 'e5');
    expect(codeOf(() => fire(ready, 'north', 'east', 'e6'))).toBe('NOT_YOUR_TURN');
    expect(turn.legal(ready, 'north')).toEqual([]);
    const next = volley(s, { north: ['east', 'e5'], east: ['north', 'e5'], south: ['north', 'e6'] });
    expect(codeOf(() => fire(next, 'north', 'east', 'E5'))).toBe('ALREADY_FIRED');
    expect(fire(next, 'south', 'east', 'e5').pending.south).toEqual({ from: 'south', sea: 'east', cell: 'e5' });
  });
  test('a round resolves only when the last seat commits', () => {
    let s = deployed();
    s = fire(s, 'west', 'north', 'h8');
    s = fire(s, 'north', 'east', 'a1');
    s = fire(s, 'south', 'east', 'h8');
    expect(s.round).toBe(1);
    expect(s.ready).toEqual(['north', 'south', 'west']);
    expect(turn.toMove(s)).toEqual(['east']);
    expect(s.lastVolley).toBeNull();
    expect(s.shots.east).toEqual({});
    s = fire(s, 'east', 'north', 'a1');
    expect(s.round).toBe(2);
    expect(s.ready).toEqual([]);
    expect(Object.values(s.pending).every((p) => p === null)).toBe(true);
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south', 'west']);
    expect(s.lastVolley!.round).toBe(1);
    expect(s.lastVolley!.shells.map((x) => x.from)).toEqual(['north', 'east', 'south', 'west']);
  });
  test('hits, misses and a sinking', () => {
    let s = deployed(2);
    preHit(s, 'east', ['a7'], 'north');
    s = volley(s, { north: ['east', 'b7'], east: ['north', 'a1'] });
    expect(s.lastVolley!.shells).toEqual([
      { from: 'north', sea: 'east', cell: 'b7', result: 'sunk', ship: 'submarine', blast: false },
      { from: 'east', sea: 'north', cell: 'a1', result: 'hit', ship: null, blast: false },
    ]);
    expect(s.lastVolley!.sunk).toEqual([{ sea: 'east', ship: 'submarine', by: ['north'] }]);
    expect(s.fleets.east.find((x) => x.id === 'submarine')!.hits).toEqual(['a7', 'b7']);
    expect(s.shots.east.b7).toEqual({ result: 'hit', by: ['north'] });
    expect(s.scrap).toEqual({ north: 1 + 3, east: 1 });
    expect(s.hitsLanded).toEqual({ north: 1, east: 1 });
  });
  test('a miss, and a shell on a cell someone already hit lands as a hit with no new scrap', () => {
    let s = deployed(3);
    s = volley(s, { north: ['east', 'h8'], east: ['north', 'a1'], south: ['north', 'b2'] });
    expect(s.lastVolley!.shells[0].result).toBe('miss');
    expect(s.shots.east.h8).toEqual({ result: 'miss', by: ['north'] });
    expect(s.shots.north.a1).toEqual({ result: 'hit', by: ['east'] });
    s = volley(s, { north: ['east', 'g8'], east: ['north', 'b8'], south: ['north', 'a1'] });
    expect(s.lastVolley!.shells[2]).toEqual({ from: 'south', sea: 'north', cell: 'a1', result: 'hit', ship: null, blast: false });
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
    // a lone shell hits one cell only
    expect(s.shots.east.e5).toEqual({ result: 'miss', by: ['west'] });
    expect(Object.keys(s.shots.east)).toHaveLength(10);
    // blast cells leave the shooters' legal
    expect(turn.legal(s, 'north')).toHaveLength(192 - 9);
    expect(turn.legal(s, 'west')).toHaveLength(192 - 1);
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
    expect(turn.toMove(s)).toEqual(['north', 'south']);
    expect(codeOf(() => fire(s, 'north', 'east', 'e5'))).toBe('BAD_TARGET');
    expect(turn.legal(s, 'north')).toHaveLength(64);
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
    s = volley(s, { north: ['west', 'd1'], south: ['north', 'g7'], west: ['north', 'g6'] });
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = volley(s, { north: ['south', 'd1'], south: ['north', 'f7'] });
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
    s = fire(s, 'north', 'east', 'a1');
    s = fire(s, 'south', 'east', 'b1');
    expect(s.round).toBe(1);
    s = G.forfeit(s, 'east', 'disconnect');
    expect(s.round).toBe(2);
    expect(s.lastVolley!.shells.map((x) => [x.from, x.sea, x.cell, x.result])).toEqual([
      ['north', 'east', 'a1', 'hit'],
      ['south', 'east', 'b1', 'hit'],
    ]);
    expect(s.scrap).toEqual({ north: 1, east: 0, south: 1 });
    expect(s.eliminated).toEqual([{ seat: 'east', round: 1, reason: 'disconnect' }]);
    expect(turn.toMove(s)).toEqual(['north', 'south']);
  });
  test('a forfeiting seat that had fired loses its shell', () => {
    let s = deployed(3);
    s = fire(s, 'east', 'north', 'a1');
    s = G.forfeit(s, 'east', 'resign');
    expect(s.pending.east).toBeNull();
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
    f = volley(f, { north: ['east', 'b2'], east: ['north', 'a1'], south: ['east', 'b2'] });
    const mid = JSON.stringify(f);
    fire(f, 'west', 'north', 'a2');
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
    expect(roundSummary(before, s)).toEqual([
      "Round 1: {east} sinks {north}'s submarine, {west} misses {south}.",
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
      `Round ${FOG_FROM - 1}: {north} sinks {east}'s cruiser, {east} hits {north} at a1, {south} misses {north}.`,
      '{east} is out.',
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
      "Round 1: {north} sinks {east}'s cruiser, {east} sinks {north}'s cruiser.",
      'Both fleets go down together. {east} had more scrap. {east} takes it.',
    ]);
    const lone = deployed(2);
    preHit(lone, 'east', SHIP_CELLS.filter((c) => c !== 'd1'));
    const won = volley(lone, { north: ['east', 'd1'], east: ['north', 'h8'] });
    expect(roundSummary(lone, won).slice(-2)).toEqual(['{east} is out.', '{north} is the last fleet afloat and takes it.']);
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
    expect(east.misses).toEqual(['h8']);
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
  test('the fog lifts rows for everyone', () => {
    const s = deployed(2);
    s.round = FOG_FROM + 1;
    const v = viewOf(s, null);
    expect(v.liftedRows).toEqual([8, 1]);
    expect(v.targets[0].lifted).toEqual([
      { row: 8, cells: [] },
      { row: 1, cells: ['a1', 'b1', 'c1', 'd1'] },
    ]);
    expect(viewOf(s, 'north').targets[0].lifted[1].cells).toEqual(['a1', 'b1', 'c1', 'd1']);
  });
  test('everything is revealed once over, eliminated seas included', () => {
    let s = deployed(3);
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = volley(s, { north: ['east', 'd1'], east: ['north', 'a1'], south: ['north', 'h8'] });
    expect(viewOf(s, null).targets.map((t) => t.sea)).toEqual(['north', 'south']);
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
  test('a seat never sees another fleet or any pending shell, its own included', () => {
    let s = deployed();
    s = fire(s, 'north', 'east', 'e5');
    s = fire(s, 'south', 'east', 'e5');
    for (const seat of [null, ...s.seats]) {
      const v = viewOf(s, seat);
      expect(v).toEqual(viewOf({ ...s, pending: { north: null, east: null, south: null, west: null } }, seat));
      expect(JSON.stringify(v)).not.toContain('e5');
      expect(v.ready).toEqual(['north', 'south']);
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
    expect(lines).toContain('8 . . . . . . . o');
    expect(lines).toContain('7 S S . . . . . .');
    expect(lines).toContain('1 C C C C . . . .');
    expect(lines).toContain('1 X . . . . . . .');
    expect(v.ascii).toContain('X = hit');
    const spectator = viewOf(s, null).ascii;
    expect(spectator).not.toContain('(you)');
    for (const line of spectator.split('\n').filter((l) => /^[1-8] /.test(l))) expect(line).not.toMatch(/[CDFS]/);
  });
});

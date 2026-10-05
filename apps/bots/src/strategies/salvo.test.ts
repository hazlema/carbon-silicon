import { describe, expect, test } from 'bun:test';
import { createRng } from '@cs/game-api';
import { cellIndex, cellName, neighbours, salvoGame, type SalvoCommand, type SalvoView, type TargetView, type Volley } from '@cs/salvo';
import { chooseSalvoMove, heatmap, volleyMoment, type SalvoStrength } from './salvo';

const turn = salvoGame.turn;
const CELLS = Array.from({ length: 64 }, (_, i) => cellName(i));

const target = (sea: string, over: Partial<TargetView> = {}): TargetView => ({ sea, mine: [], hits: [], misses: [], sunk: [], lifted: [], afloat: 12, ...over });
const view = (targets: TargetView[], over: Partial<SalvoView> = {}): SalvoView => ({
  you: 'south',
  seats: ['north', 'east', 'south', 'west'],
  round: 3,
  phase: 'fire',
  ready: [],
  mySea: null,
  targets,
  lastVolley: null,
  scrap: { north: 0, east: 0, south: 0, west: 0 },
  eliminated: [],
  liftedRows: [],
  winner: null,
  endReason: null,
  ascii: '',
  ...over,
});
/** Every shell a seat may fire: each cell of each target it hasn't shot itself (R-P3). */
const legalFor = (v: SalvoView): SalvoCommand[] =>
  v.targets.flatMap((t) => CELLS.filter((c) => !t.mine.some((m) => m.cell === c)).map((cell) => ({ fire: 'shell' as const, at: t.sea, cell })));
const fire = (c: SalvoCommand) => c as Extract<SalvoCommand, { fire: 'shell' }>;
const argmax = (heat: Map<string, number>) => [...heat].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
const volley = (over: Partial<Volley>): Volley => ({ round: 2, shells: [], blasts: [], sunk: [], eliminated: [], ...over });

describe('heatmap', () => {
  test('an open sea: corners are cold, the middle is hot, and every placement is counted once per cell', () => {
    const heat = heatmap(target('east'));
    expect(heat.size).toBe(64);
    // a1: each of the four ships lies across it two ways (east and north).
    expect(heat.get('a1')).toBe(8);
    expect(heat.get('h8')).toBe(8);
    // d4: the cruiser 4+4, the two threes 3+3 each, the submarine 2+2.
    expect(heat.get('d4')).toBe(24);
    // Σ over ships of (2 facings × 8 lines × (9 − length) placements) × length.
    expect([...heat.values()].reduce((a, b) => a + b, 0)).toBe(1120);
  });
  test('a miss blocks every hull through it, and a shot cell is 0', () => {
    const heat = heatmap(target('east', { misses: ['b1'] }));
    expect(heat.get('b1')).toBe(0);
    expect(heat.get('a1')).toBe(4); // only the northward hulls are left
  });
  test('a sunk ship leaves the count and blocks its cells', () => {
    const heat = heatmap(target('east', { hits: ['a1', 'a2'], sunk: [{ ship: 'submarine', cells: ['a1', 'a2'] }], afloat: 10 }));
    expect(heat.get('a1')).toBe(0);
    expect(heat.get('a2')).toBe(0);
    // a3: the cruiser and both threes, one hull east and one north each; no submarine.
    expect(heat.get('a3')).toBe(6);
  });
  test('an unsunk hit makes its open side the hottest cell on the sea', () => {
    const heat = heatmap(target('east', { hits: ['e5'], misses: ['e4', 'e6', 'd5'], afloat: 11 }));
    expect(heat.get('e5')).toBe(0);
    expect(argmax(heat)).toBe('f5');
  });
  test('a lifted row: its open water is cold, the ship the fog showed is hot', () => {
    const heat = heatmap(target('east', { lifted: [{ row: 8, cells: ['c8', 'd8'] }] }));
    for (const c of ['a8', 'b8', 'e8', 'f8', 'g8', 'h8']) expect(heat.get(c)).toBe(0);
    expect(['c8', 'd8']).toContain(argmax(heat));
    expect(heat.get('c8')!).toBeGreaterThan(heat.get('c4')!);
  });
});

describe('chooseSalvoMove', () => {
  test('every strength plays whole games with entries of legal, from its own view only', () => {
    const strengths: (SalvoStrength | null)[] = ['easy', 'medium', 'hard', null];
    for (let g = 0; g < 4; g++) {
      const rng = createRng(40 + g);
      let s = salvoGame.setup({ seats: ['north', 'east', 'south', 'west'], seed: 7 + g });
      let guard = 0;
      while (s.phase !== 'over' && guard++ < 500) {
        const seat = turn.toMove(s)[0];
        const legal = turn.legal(s, seat) as SalvoCommand[];
        const strength = strengths[s.seats.indexOf(seat)];
        const cmd = strength ? chooseSalvoMove(salvoGame.view(s, seat) as SalvoView, legal, { strength, rng: rng.next }) : rng.pick(legal);
        expect(legal.includes(cmd)).toBe(true);
        s = turn.apply(s, seat, cmd);
      }
      expect(s.phase).toBe('over');
    }
  });
  test('deployment goes at random when that is offered', () => {
    const s = salvoGame.setup({ seats: ['north', 'east'], seed: 1 });
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      const cmd = chooseSalvoMove(salvoGame.view(s, 'north') as SalvoView, legal, { strength, rng: Math.random });
      expect(cmd).toEqual({ place: 'random' });
      expect(legal.includes(cmd)).toBe(true);
    }
  });
  test('a move that is not in legal is never returned', () => {
    // The view shows a sea that legal does not offer: the pick stays inside legal.
    const v = view([target('north'), target('east')]);
    const legal = legalFor(view([target('east')]));
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      for (let k = 0; k < 10; k++) expect(legal.includes(chooseSalvoMove(v, legal, { strength, rng: createRng(k).next }))).toBe(true);
    }
  });

  test('hard shoots the hottest cell', () => {
    const v = view([target('east', { hits: ['e5'], misses: ['e4', 'e6', 'd5'], afloat: 11 })]);
    for (let k = 0; k < 10; k++) expect(fire(chooseSalvoMove(v, legalFor(v), { strength: 'hard', rng: createRng(k).next })).cell).toBe('f5');
  });
  test('hard aims at the fleet closest to the bottom', () => {
    const v = view([target('north'), target('east', { hits: ['a1'], misses: ['b1', 'a2'], afloat: 11 }), target('west')]);
    for (let k = 0; k < 10; k++) expect(fire(chooseSalvoMove(v, legalFor(v), { strength: 'hard', rng: createRng(k).next })).at).toBe('east');
  });

  test('medium keeps to one colour of the checkerboard while it lasts, then takes the rest', () => {
    const rng = createRng(3);
    const shots: string[] = [];
    for (let k = 0; k < 40; k++) {
      const t = target('east', { mine: shots.map((cell) => ({ cell, result: 'miss' as const })), misses: [...shots] });
      const v = view([t]);
      const cell = fire(chooseSalvoMove(v, legalFor(v), { strength: 'medium', rng: rng.next })).cell;
      const i = cellIndex(cell)!;
      const even = ((i % 8) + Math.floor(i / 8)) % 2 === 0;
      expect(even).toBe(k < 32);
      shots.push(cell);
    }
  });
  test('medium chases a hit in line with it', () => {
    const v = view([target('east', { hits: ['e5'], afloat: 11 })]);
    for (let k = 0; k < 10; k++) expect(['e4', 'e6', 'd5', 'f5']).toContain(fire(chooseSalvoMove(v, legalFor(v), { strength: 'medium', rng: createRng(k).next })).cell);
  });
  test("medium's grudge: the sea of whoever hit him last, else the sea with most hits", () => {
    const targets = [target('north', { hits: ['a1', 'a2', 'a3'], afloat: 9 }), target('east'), target('west')];
    const hitMe = volley({
      shells: [
        { from: 'east', sea: 'south', cell: 'c3', result: 'hit', ship: null, blast: false },
        { from: 'west', sea: 'north', cell: 'h8', result: 'miss', ship: null, blast: false },
        { from: 'north', sea: 'south', cell: 'd3', result: 'miss', ship: null, blast: false },
      ],
    });
    const angry = view(targets, { lastVolley: hitMe });
    const calm = view(targets);
    for (let k = 0; k < 10; k++) {
      expect(fire(chooseSalvoMove(angry, legalFor(angry), { strength: 'medium', rng: createRng(k).next })).at).toBe('east');
      expect(fire(chooseSalvoMove(calm, legalFor(calm), { strength: 'medium', rng: createRng(k).next })).at).toBe('north');
    }
  });

  test('easy chases a neighbour after a hit', () => {
    const v = view([target('north'), target('east', { hits: ['e5'], afloat: 11 })]);
    for (let k = 0; k < 10; k++) {
      const c = fire(chooseSalvoMove(v, legalFor(v), { strength: 'easy', rng: createRng(k).next }));
      expect(c.at).toBe('east');
      expect(neighbours('e5')).toContain(c.cell);
    }
  });
  test('easy hunts at random among cells nobody has shot', () => {
    const v = view([target('east', { misses: CELLS.slice(0, 60) })]);
    for (let k = 0; k < 10; k++) expect(CELLS.slice(60)).toContain(fire(chooseSalvoMove(v, legalFor(v), { strength: 'easy', rng: createRng(k).next })).cell);
  });
});

describe('volleyMoment', () => {
  const shell = (from: string, sea: string, result: 'miss' | 'hit' | 'sunk') => ({ from, sea, cell: 'c3', result, ship: null, blast: false });
  test('a hit on my fleet, a blast on my fleet, my own sinking of a ship, and a quiet volley', () => {
    expect(volleyMoment(view([], { lastVolley: volley({ shells: [shell('east', 'south', 'hit')] }) }))).toBe('gotHit');
    expect(volleyMoment(view([], { lastVolley: volley({ shells: [shell('east', 'south', 'miss')] }) }))).toBeNull();
    expect(volleyMoment(view([], { lastVolley: volley({ blasts: [{ sea: 'south', cell: 'c3', by: ['east', 'west'], cells: [], hits: ['c4'] }] }) }))).toBe('gotHit');
    expect(volleyMoment(view([], { lastVolley: volley({ shells: [shell('south', 'east', 'sunk')], sunk: [{ sea: 'east', ship: 'frigate', by: ['south'] }] }) }))).toBe('bigCascade');
    expect(volleyMoment(view([], { lastVolley: null }))).toBeNull();
    expect(volleyMoment(view([], { you: null, lastVolley: volley({ shells: [shell('east', 'south', 'hit')] }) }))).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { createRng } from '@cs/game-api';
import { MINE_LIMIT, buoyCells, cellIndex, cellName, isBuoyCentre, neighbours, salvoGame, type SalvoCommand, type SalvoState, type SalvoView, type ShipId, type TargetView, type Volley } from '@cs/salvo';
import { chances, chooseGhostTrick, chooseSalvoMove, heatmap, seaWeights, volleyMoment, type SalvoStrength } from './salvo';

const turn = salvoGame.turn;
const CELLS = Array.from({ length: 64 }, (_, i) => cellName(i));

const target = (sea: string, over: Partial<TargetView> = {}): TargetView => ({ sea, mine: [], hits: [], misses: [], sunk: [], lifted: [], sonar: [], afloat: 12, out: false, ...over });
const view = (targets: TargetView[], over: Partial<SalvoView> = {}): SalvoView => ({
  you: 'south',
  seats: ['north', 'east', 'south', 'west'],
  round: 3,
  phase: 'fire',
  ready: [],
  ghosts: [],
  guns: { north: 4, east: 4, south: 4, west: 4 },
  myOrders: [],
  myTricks: null,
  holding: {},
  myArsenal: null,
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
/** One gun: the old single-shot round (a seat down to its last ship). */
const ONE_GUN = { guns: { north: 1, east: 1, south: 1, west: 1 } };
/** Every shell a seat may fire: each cell of each target it hasn't shot itself (R-P3) nor aimed at this round. */
const legalFor = (v: SalvoView): SalvoCommand[] =>
  v.targets.flatMap((t) =>
    CELLS.filter((c) => !t.mine.some((m) => m.cell === c) && !v.myOrders.some((o) => o.fire === 'shell' && o.at === t.sea && o.cell === c)).map((cell) => ({
      fire: 'shell' as const,
      at: t.sea,
      cell,
    })),
  );
/** The same, plus every buoy centre on each sea it hasn't buoyed itself, unless a buoy is in this round. */
const legalWithBuoys = (v: SalvoView): SalvoCommand[] => [
  ...legalFor(v),
  ...(v.myOrders.some((o) => o.fire === 'buoy')
    ? []
    : v.targets.flatMap((t) => CELLS.filter((c) => isBuoyCentre(c) && !t.sonar.some((x) => x.cell === c)).map((cell) => ({ fire: 'buoy' as const, at: t.sea, cell })))),
];
/** Plays south's whole salvo for one round, feeding each shot back through `myOrders`. */
const salvoRound = (v: SalvoView, strength: SalvoStrength, rng: () => number, buoys = true) => {
  const orders: SalvoView['myOrders'] = [];
  for (let k = 0; k < v.guns.south; k++) {
    const now = { ...v, myOrders: [...orders] };
    const legal = buoys ? legalWithBuoys(now) : legalFor(now);
    const c = chooseSalvoMove(now, legal, { strength, rng });
    expect(legal.includes(c)).toBe(true);
    orders.push(c as SalvoView['myOrders'][number]);
  }
  return orders;
};
const isBuoy = (c: SalvoCommand) => 'fire' in c && c.fire === 'buoy';
const reading = (cell: string, afloat: number, round = 2) => ({ cell, round, cells: buoyCells(cell), afloat });
const fire = (c: SalvoCommand) => c as Extract<SalvoCommand, { fire: 'shell' }>;
const argmax = (heat: Map<string, number>) => [...heat].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
const volley = (over: Partial<Volley>): Volley => ({ round: 2, shells: [], buoys: [], blasts: [], sunk: [], eliminated: [], tricks: [], items: [], ...over });

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
  test('a lifted row counting 0 is open water: its cells are cold and no hull crosses it', () => {
    const open = heatmap(target('east'));
    const heat = heatmap(target('east', { lifted: [{ row: 8, afloat: 0 }] }));
    for (const c of CELLS.filter((x) => x.endsWith('8'))) expect(heat.get(c)).toBe(0);
    // a7: only hulls that stop short of row 8 are left.
    expect(heat.get('a7')!).toBeLessThan(open.get('a7')!);
  });
  test('a zero row still lets a hull through a cell already hit there', () => {
    const heat = heatmap(target('east', { hits: ['d8'], lifted: [{ row: 8, afloat: 0 }], afloat: 11 }));
    // The hull through d8 can only run down the column, so d7 outranks its neighbours along row 7.
    expect(heat.get('d7')!).toBeGreaterThan(heat.get('c7')!);
    expect(heat.get('d7')!).toBeGreaterThan(heat.get('e7')!);
  });
  test('a lifted row whose count fills its unshot cells makes them sure hits, above everything', () => {
    const misses = ['a8', 'b8', 'c8', 'd8', 'e8', 'f8'];
    const heat = heatmap(target('east', { misses, lifted: [{ row: 8, afloat: 2 }] }));
    const top = Math.max(...[...heat].filter(([c]) => !['g8', 'h8'].includes(c)).map(([, h]) => h));
    expect(heat.get('g8')!).toBeGreaterThan(top);
    expect(heat.get('h8')!).toBeGreaterThan(top);
  });
  test('a dense lifted row runs hotter than the same row in fog, a sparse one colder', () => {
    const fog = heatmap(target('east')).get('d8')!;
    expect(heatmap(target('east', { lifted: [{ row: 8, afloat: 4 }] })).get('d8')!).toBeGreaterThan(fog);
    expect(heatmap(target('east', { lifted: [{ row: 8, afloat: 1 }] })).get('d8')!).toBeLessThan(fog);
  });
  test('when the lifted rows account for every ship cell, the rest of the sea is open water', () => {
    const heat = heatmap(target('east', { lifted: [{ row: 8, afloat: 6 }, { row: 1, afloat: 6 }] }));
    for (const c of CELLS.filter((x) => !x.endsWith('8') && !x.endsWith('1'))) expect(heat.get(c)).toBe(0);
    expect(heat.get('d8')!).toBeGreaterThan(0);
  });
  test('a sonar reading of 0 clears its 3×3; a full one makes it sure; a busy one runs hot', () => {
    const quiet = heatmap(target('east', { sonar: [reading('d4', 0)] }));
    for (const c of buoyCells('d4')) expect(quiet.get(c)).toBe(0);
    const misses = buoyCells('d4').filter((c) => c !== 'd4' && c !== 'd5');
    const full = heatmap(target('east', { misses, sonar: [reading('d4', 2)] }));
    expect(['d4', 'd5']).toContain(argmax(full));
    const fog = heatmap(target('east')).get('d4')!;
    expect(heatmap(target('east', { sonar: [reading('d4', 4)] })).get('d4')!).toBeGreaterThan(fog);
  });
});

describe('chooseSalvoMove', () => {
  test('every strength plays whole games with entries of legal, from its own view only', () => {
    const strengths: (SalvoStrength | null)[] = ['easy', 'medium', 'hard', null];
    for (let g = 0; g < 4; g++) {
      const rng = createRng(40 + g);
      let s = salvoGame.setup({ seats: ['north', 'east', 'south', 'west'], seed: 7 + g });
      let guard = 0;
      while (s.phase !== 'over' && guard++ < 3000) {
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
  test('hard aims where a ship is likeliest on any sea: a hit, or a dense lifted row on a healthy fleet', () => {
    const hit = view([target('north'), target('east', { hits: ['e5'], afloat: 11 }), target('west')]);
    for (let k = 0; k < 10; k++) expect(fire(chooseSalvoMove(hit, legalFor(hit), { strength: 'hard', rng: createRng(k).next })).at).toBe('east');
    // North is untouched, but its lifted row 1 holds 6 ship cells in 8: a far better bet than anywhere on east.
    const dense = view([target('north', { lifted: [{ row: 1, afloat: 6 }] }), target('east', { misses: ['a1', 'h8'], afloat: 12 })]);
    for (let k = 0; k < 10; k++) {
      const c = fire(chooseSalvoMove(dense, legalFor(dense), { strength: 'hard', rng: createRng(k).next }));
      expect([c.at, c.cell.slice(1)]).toEqual(['north', '1']);
    }
  });
  test('chances add up to the ship cells afloat, with sure cells certain and shot cells absent', () => {
    const t = target('east', { hits: ['e5'], misses: ['a1', 'b1'], lifted: [{ row: 8, afloat: 0 }], afloat: 11 });
    const odds = chances(t);
    expect(odds.has('e5')).toBe(false);
    expect(odds.has('a1')).toBe(false);
    expect([...odds.values()].reduce((n, x) => n + x, 0)).toBeCloseTo(11, 5);
    for (const c of CELLS.filter((c) => c.endsWith('8'))) expect(odds.get(c)).toBe(0);
    const full = chances(target('north', { misses: ['a1', 'b1', 'c1', 'd1'], lifted: [{ row: 1, afloat: 4 }], afloat: 12 }));
    for (const c of ['e1', 'f1', 'g1', 'h1']) expect(full.get(c)).toBe(1);
  });
  test('medium shoots one of its best few cells, never far below the best', () => {
    const v = view([target('north', { misses: CELLS.slice(0, 20) }), target('east', { hits: ['c3'], misses: ['c2'], afloat: 11 })]);
    const odds = new Map(v.targets.map((t) => [t.sea, chances(t)]));
    const best = Math.max(...v.targets.flatMap((t) => [...odds.get(t.sea)!.values()]));
    for (let k = 0; k < 30; k++) {
      const c = fire(chooseSalvoMove(v, legalFor(v), { strength: 'medium', rng: createRng(k).next }));
      expect(odds.get(c.at)!.get(c.cell)!).toBeGreaterThanOrEqual(best * 0.8 - 1e-9);
    }
  });
  test('medium chases a hit in line with it', () => {
    const v = view([target('east', { hits: ['e5'], afloat: 11 })]);
    for (let k = 0; k < 10; k++) expect(['e4', 'e6', 'd5', 'f5']).toContain(fire(chooseSalvoMove(v, legalFor(v), { strength: 'medium', rng: createRng(k).next })).cell);
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

describe('salvos', () => {
  test('successive shots in one round go to distinct cells, for every strength', () => {
    const seas = [
      view([target('north'), target('east')]),
      view([target('east', { hits: ['e5'], afloat: 11 })]),
      view([target('north', { misses: CELLS.slice(0, 50) }), target('east', { hits: ['a1', 'a2'], misses: ['a3'], afloat: 10 })]),
    ];
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      for (const v of seas) {
        for (let k = 0; k < 10; k++) {
          const shells = salvoRound(v, strength, createRng(k).next).filter((o) => o.fire === 'shell');
          expect(new Set(shells.map((o) => `${o.at}:${o.cell}`)).size).toBe(shells.length);
        }
      }
    }
  });
  test('a salvo chasing a lone hit spreads over the four cells in line with it', () => {
    const v = view([target('north'), target('east', { hits: ['e5'], afloat: 11 })]);
    for (const strength of ['medium', 'hard'] as const) {
      for (let k = 0; k < 10; k++) {
        const orders = salvoRound(v, strength, createRng(k).next);
        expect(orders.every((o) => o.fire === 'shell' && o.at === 'east')).toBe(true);
        expect(orders.map((o) => o.cell).sort()).toEqual(['d5', 'e4', 'e6', 'f5']);
      }
    }
  });
  test('with two hits in a row, hard runs the salvo along the line', () => {
    const v = view([target('east', { hits: ['d5', 'e5'], afloat: 10 })], { guns: { south: 2 } });
    for (let k = 0; k < 10; k++) expect(salvoRound(v, 'hard', createRng(k).next).map((o) => o.cell).sort()).toEqual(['c5', 'f5']);
  });
  test('a hunting salvo from hard takes the four likeliest cells, whichever seas they are on', () => {
    // East has lost its submarine (fewer, longer ships left) and north is untouched. No buoys on offer here.
    const sunk = target('east', { hits: ['a1', 'a2'], sunk: [{ ship: 'submarine', cells: ['a1', 'a2'] }], afloat: 10 });
    const v = view([target('north'), sunk], { round: 1 });
    const odds = [...v.targets.flatMap((t) => [...chances(t)].map(([cell, p]) => ({ key: `${t.sea}:${cell}`, p })))].sort((a, b) => b.p - a.p);
    const fourth = odds[3].p;
    for (let k = 0; k < 5; k++) {
      const shells = salvoRound(v, 'hard', createRng(k).next, false);
      for (const o of shells) expect(odds.find((x) => x.key === `${o.at}:${o.cell}`)!.p).toBeGreaterThanOrEqual(fourth - 1e-9);
    }
  });
  test('residents spread a salvo across seas when the odds say so', () => {
    // Open hits on two seas: hard's four shots go to both.
    const v = view([target('north', { hits: ['c3'], afloat: 11 }), target('east', { hits: ['f6'], afloat: 11 })]);
    for (let k = 0; k < 5; k++) expect(new Set(salvoRound(v, 'hard', createRng(k).next, false).map((o) => o.at))).toEqual(new Set(['north', 'east']));
  });
});

describe('sonar buoys', () => {
  const choose = (v: SalvoView, strength: SalvoStrength, k: number) => chooseSalvoMove(v, legalWithBuoys(v), { strength, rng: createRng(k).next });

  test('with one gun, hard drops a buoy where the heat is when it has nothing to chase, and shoots otherwise', () => {
    const idle = view([target('north'), target('east')], ONE_GUN);
    for (let k = 0; k < 10; k++) {
      const c = choose(idle, 'hard', k);
      expect(isBuoy(c)).toBe(true);
      // The middle of an open sea is hottest, so the buoy goes to one of the four centre cells.
      expect(['d4', 'e4', 'd5', 'e5']).toContain(fire(c).cell);
    }
    const chasing = view([target('north'), target('east', { hits: ['e5'], afloat: 11 })], ONE_GUN);
    const sure = view([target('east', { misses: ['a8', 'b8', 'c8', 'd8', 'e8', 'f8'], lifted: [{ row: 8, afloat: 2 }] })], ONE_GUN);
    const recent = view([target('east', { sonar: [reading('b2', 3, 1)] })], { round: 4, ...ONE_GUN });
    const due = view([target('east', { sonar: [reading('b2', 3, 1)] })], { round: 5, ...ONE_GUN });
    for (let k = 0; k < 10; k++) {
      expect(isBuoy(choose(chasing, 'hard', k))).toBe(false);
      expect(isBuoy(choose(sure, 'hard', k))).toBe(false);
      expect(isBuoy(choose(recent, 'hard', k))).toBe(false);
      expect(isBuoy(choose(due, 'hard', k))).toBe(true);
    }
  });
  test('a zero reading steers fire away from its 3×3', () => {
    const v = view([target('east', { sonar: [reading('d4', 0)] })], { round: 3 });
    const quiet = new Set(buoyCells('d4'));
    for (let k = 0; k < 30; k++) {
      for (const strength of ['medium', 'hard'] as const) {
        const c = chooseSalvoMove(v, legalFor(v), { strength, rng: createRng(k).next });
        expect(quiet.has(fire(c).cell)).toBe(false);
      }
    }
  });
  test('medium keeps clear of a zero row while it hunts', () => {
    const v = view([target('east', { lifted: [{ row: 8, afloat: 0 }] })], { round: 6 });
    for (let k = 0; k < 30; k++) expect(fire(chooseSalvoMove(v, legalFor(v), { strength: 'medium', rng: createRng(k).next })).cell.endsWith('8')).toBe(false);
  });
  test('with one gun, medium buoys now and then after round 2, never two rounds running, never while chasing', () => {
    const rng = createRng(11);
    let sonar: TargetView['sonar'] = [];
    let last = 0;
    let drops = 0;
    for (let round = 1; round <= 120; round++) {
      const v = view([target('east', { sonar })], { round, ...ONE_GUN });
      const c = chooseSalvoMove(v, legalWithBuoys(v), { strength: 'medium', rng: rng.next });
      expect(legalWithBuoys(v).some((x) => JSON.stringify(x) === JSON.stringify(c))).toBe(true);
      if (!isBuoy(c)) continue;
      expect(round).toBeGreaterThan(2);
      expect(round - last).toBeGreaterThan(1);
      last = round;
      drops++;
      sonar = [...sonar, reading(fire(c).cell, 3, round)];
    }
    // About one round in five, give or take.
    expect(drops).toBeGreaterThan(8);
    expect(drops).toBeLessThan(40);
    const chasing = view([target('east', { hits: ['e5'], afloat: 11 })], { round: 7, ...ONE_GUN });
    for (let k = 0; k < 30; k++) expect(isBuoy(choose(chasing, 'medium', k))).toBe(false);
  });
  test('with a salvo, hard spares its first shot for a buoy while it hunts, and shells the rest', () => {
    const idle = view([target('north'), target('east')]);
    for (let k = 0; k < 10; k++) {
      const orders = salvoRound(idle, 'hard', createRng(k).next);
      expect(orders.map((o) => o.fire)).toEqual(['buoy', 'shell', 'shell', 'shell']);
      expect(['d4', 'e4', 'd5', 'e5']).toContain(orders[0].cell);
    }
    // Not while chasing, and not with a buoy of its own from the last two rounds.
    const chasing = view([target('north'), target('east', { hits: ['e5'], afloat: 11 })]);
    const recent = view([target('east', { sonar: [reading('b2', 3, 2)] })], { round: 4 });
    const due = view([target('east', { sonar: [reading('b2', 3, 1)] })], { round: 4 });
    for (let k = 0; k < 10; k++) {
      expect(salvoRound(chasing, 'hard', createRng(k).next).some((o) => o.fire === 'buoy')).toBe(false);
      expect(salvoRound(recent, 'hard', createRng(k).next).some((o) => o.fire === 'buoy')).toBe(false);
      expect(salvoRound(due, 'hard', createRng(k).next)[0].fire).toBe('buoy');
    }
  });
  test('a buoy already in this round is never followed by another, whatever legal offers', () => {
    const v = view([target('north'), target('east')], { myOrders: [{ fire: 'buoy', at: 'east', cell: 'd4' }] });
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      // legalFor alone would hide it; offer buoys anyway to check the strategy's own guard.
      const legal = [...legalFor(v), { fire: 'buoy' as const, at: 'north', cell: 'e5' }];
      for (let k = 0; k < 20; k++) expect(isBuoy(chooseSalvoMove(v, legal, { strength, rng: createRng(k).next }))).toBe(false);
    }
  });
  test('across many salvos, at most one buoy a round; medium buoys some rounds, easy never', () => {
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      const rng = createRng(21);
      let sonar: TargetView['sonar'] = [];
      let drops = 0;
      for (let round = 1; round <= 60; round++) {
        const v = view([target('north'), target('east', { sonar })], { round });
        const orders = salvoRound(v, strength, rng.next);
        const buoys = orders.filter((o) => o.fire === 'buoy');
        expect(buoys.length).toBeLessThanOrEqual(1);
        drops += buoys.length;
        sonar = [...sonar, ...buoys.filter((b) => b.at === 'east').map((b) => reading(b.cell, 3, round))];
      }
      if (strength === 'easy') expect(drops).toBe(0);
      else expect(drops).toBeGreaterThan(5);
    }
  });
  test('easy never drops a buoy', () => {
    const rng = createRng(5);
    for (let k = 0; k < 60; k++) {
      const v = view([target('north'), target('east', k % 2 ? { hits: ['e5'], afloat: 11 } : {})], { round: 1 + (k % 12) });
      expect(isBuoy(chooseSalvoMove(v, legalWithBuoys(v), { strength: 'easy', rng: rng.next }))).toBe(false);
    }
  });
  test('the same rng gives the same choice', () => {
    const v = view([target('north'), target('east', { misses: ['a1', 'b2'], sonar: [reading('f6', 2)] })], { round: 8, liftedRows: [8, 1, 7] });
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      for (let k = 0; k < 5; k++) expect(choose(v, strength, k)).toEqual(choose(v, strength, k));
    }
  });
});

describe('residents at sea', () => {
  /** Plays two-seat matches, `a` in north and `b` in south (null = random fire), and counts north's wins. Each seat fires its whole salvo (it stays in toMove until every gun is in). */
  const duel = (a: SalvoStrength | null, b: SalvoStrength | null, games: number) => {
    let wins = 0;
    for (let g = 0; g < games; g++) {
      const rng = createRng(500 + g);
      let s = salvoGame.setup({ seats: ['north', 'south'], seed: 900 + g });
      let guard = 0;
      while (s.phase !== 'over' && guard++ < 2000) {
        const seat = turn.toMove(s)[0];
        const legal = turn.legal(s, seat) as SalvoCommand[];
        const strength = seat === 'north' ? a : b;
        const cmd = strength ? chooseSalvoMove(salvoGame.view(s, seat) as SalvoView, legal, { strength, rng: rng.next }) : rng.pick(legal.filter((x) => !isBuoy(x)));
        expect(legal.includes(cmd)).toBe(true);
        s = turn.apply(s, seat, cmd);
      }
      if (s.winner === 'north') wins++;
    }
    return wins;
  };
  test('hard beats random fire and easy most of the time; medium beats random fire', () => {
    expect(duel('hard', null, 20)).toBeGreaterThanOrEqual(17);
    expect(duel('hard', 'easy', 20)).toBeGreaterThanOrEqual(13);
    expect(duel('medium', null, 20)).toBeGreaterThanOrEqual(15);
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

// ── Ghosts, on real module states ──

/** The standard fleet: every ship along the west edge, one row apart. Cells: a1–d1, a3–c3, a5–c5, a7–b7 (columns e–h are open water). */
const STANDARD: [ShipId, string][] = [
  ['cruiser', 'a1'],
  ['destroyer', 'a3'],
  ['frigate', 'a5'],
  ['submarine', 'a7'],
];
const SHIP_CELLS = ['a1', 'b1', 'c1', 'd1', 'a3', 'b3', 'c3', 'a5', 'b5', 'c5', 'a7', 'b7'];
/** Four seats, every one on the standard fleet unless `fleets` says otherwise; the first round is open. */
function deployed(fleets: Record<string, [ShipId, string][]> = {}): SalvoState {
  let s = salvoGame.setup({ seats: ['north', 'east', 'south', 'west'], seed: 1 });
  for (const seat of s.seats) for (const [ship, at] of fleets[seat] ?? STANDARD) s = turn.apply(s, seat, { place: ship, at, facing: 'east' });
  return s;
}
/** Mark cells of a sea as already hit (setup only; keeps `shots` and ship hits in step). */
function preHit(s: SalvoState, sea: string, cells: string[], by = 'north') {
  for (const cell of cells) {
    const ship = s.fleets[sea].find((x) => x.cells.includes(cell));
    if (ship && !ship.hits.includes(cell)) ship.hits.push(cell);
    s.shots[sea][cell] = { result: ship ? 'hit' : 'miss', by: [by] };
  }
}
const isOutIn = (s: SalvoState, seat: string) => s.eliminated.some((x) => x.seat === seat);
const gunsOf = (s: SalvoState, seat: string) => s.fleets[seat].filter((x) => x.hits.length < x.cells.length).length;
/** Each seat's filler column (open water in the standard fleet; one each, so fillers never meet). */
const FILL_COLUMN: Record<string, string> = { north: 'e', east: 'f', south: 'g', west: 'h' };
/**
 * Every living seat still owing fires: the shots given, then fillers down its own column of its last living
 * opponent from row 8 (open water, never a Time on Target). Ghosts must have played their tricks first.
 */
function volleyOf(s: SalvoState, shots: Record<string, [string, string][]>): SalvoState {
  const round = s.round;
  for (const seat of s.seats) {
    if (s.round !== round || isOutIn(s, seat) || !turn.toMove(s).includes(seat)) continue;
    // A crate from an earlier sinking is owed too: pass it.
    while (s.round === round && s.crates[seat].length > 0 && turn.toMove(s).includes(seat)) s = turn.apply(s, seat, { crate: 'pass' });
    if (s.round !== round) break;
    for (const [sea, cell] of shots[seat] ?? []) s = turn.apply(s, seat, { fire: 'shell', at: sea, cell });
    if (s.round !== round) break;
    const sea = s.seats.filter((x) => x !== seat && !isOutIn(s, x)).at(-1)!;
    for (let row = 8; s.round === round && s.pending[seat].length < gunsOf(s, seat); row--) {
      const cell = `${FILL_COLUMN[seat]}${row}`;
      if (!s.shots[sea][cell]?.by.includes(seat)) s = turn.apply(s, seat, { fire: 'shell', at: sea, cell });
    }
  }
  return s;
}
/** West's fleet all but sunk, then north sinks its last cell (b7): west is a ghost, three fleets afloat. */
function withGhost(fleets: Record<string, [ShipId, string][]> = {}): SalvoState {
  const s = deployed(fleets);
  preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
  return volleyOf(s, { north: [['west', 'b7']] });
}
const viewOf = (s: SalvoState, seat: string) => salvoGame.view(s, seat) as SalvoView;
const legalOf = (s: SalvoState, seat: string) => turn.legal(s, seat) as SalvoCommand[];
type SplashCmd = Extract<SalvoCommand, { trick: 'splash' }>;

describe('seaWeights: residents spread their fire', () => {
  const shells = (from: string, sea: string, n: number) => Array.from({ length: n }, (_, i) => ({ from, sea, cell: `a${i + 1}`, result: 'miss' as const, ship: null, blast: false }));
  test("a sea the others hammered last volley draws less; one they left alone draws in full", () => {
    const v = view([target('east'), target('south'), target('west')], { you: 'north', lastVolley: volley({ shells: [...shells('east', 'west', 4), ...shells('south', 'west', 4)] }) });
    const w = seaWeights(v);
    expect(w('west')).toBeCloseTo(0.1);
    expect(w('east')).toBe(1);
  });
  test('a grudge leans on whoever hit me; a finisher on the weakest fleet; a wanderer has a whim per round', () => {
    const hitMe = volley({ shells: [{ from: 'east', sea: 'north', cell: 'a1', result: 'hit', ship: null, blast: false }] });
    const v = view([target('east'), target('south', { afloat: 3 })], { you: 'north', lastVolley: hitMe });
    expect(seaWeights(v, 'grudge')('east')).toBeCloseTo(1.6);
    expect(seaWeights(v, 'grudge')('south')).toBe(1);
    expect(seaWeights(v, 'finisher')('south')).toBeCloseTo(1.75);
    expect(seaWeights(v, 'finisher')('east')).toBe(1);
    const whims = [1, 2, 3].map((round) => seaWeights({ ...v, round }, 'wanderer')('east'));
    for (const x of whims) expect(x).toBeGreaterThanOrEqual(0.6), expect(x).toBeLessThan(1.4);
    expect(new Set(whims).size).toBeGreaterThan(1);
    expect(seaWeights(v, 'wanderer')('east')).toBe(seaWeights(v, 'wanderer')('east'));
  });
});

describe('ghost tricks', () => {
  test('a ghost always returns an entry of legal', () => {
    // Random tables: fleets placed at random, scattered shots, west sunk by north (and east too, now and then: two
    // living seats, mines only), then a few rounds of residents everywhere, the ghosts asked at every turn.
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      let asked = 0;
      for (let k = 0; k < 20; k++) {
        const rng = createRng(300 + k);
        let s = salvoGame.setup({ seats: ['north', 'east', 'south', 'west'], seed: 60 + k });
        for (const seat of s.seats) s = turn.apply(s, seat, { place: 'random' });
        const sunk = rng.next() < 0.3 ? ['west', 'east'] : ['west'];
        for (const sea of s.seats) {
          const ship = s.fleets[sea].flatMap((x) => x.cells);
          if (sunk.includes(sea)) preHit(s, sea, ship.slice(1));
          else preHit(s, sea, CELLS.filter((c) => !ship.includes(c) && rng.next() < 0.25));
        }
        const last = Object.fromEntries(sunk.map((sea) => [sea, s.fleets[sea].flatMap((x) => x.cells)[0]]));
        for (let guard = 0; s.phase === 'fire' && s.round <= 4 + (k % 3) && guard < 400; guard++) {
          const seat = turn.toMove(s)[0];
          const legal = legalOf(s, seat);
          // North's first shots sink the doomed fleets.
          const doomed = s.round === 1 && seat === 'north' ? sunk.find((x) => !s.pending.north.some((o) => o.sea === x)) : undefined;
          let cmd: SalvoCommand;
          if (doomed) cmd = { fire: 'shell', at: doomed, cell: last[doomed] };
          else if ('trick' in legal[0]) {
            cmd = chooseGhostTrick(viewOf(s, seat), legal, { strength, rng: rng.next });
            expect(legal.includes(cmd)).toBe(true);
            asked++;
          } else cmd = chooseSalvoMove(viewOf(s, seat), legal, { strength: 'medium', rng: rng.next });
          s = turn.apply(s, seat, cmd);
        }
      }
      expect(asked).toBeGreaterThanOrEqual(20);
    }
  });

  test('hard mines a likely-shot, unlikely-ship cell: next to an open hit, not on the line', () => {
    // East's cruiser lies c4–f4 (the rest of its fleet along rows 1, 6 and 8). Hits at d4 and e4 open an
    // east–west line: c4/f4 are hot for ships; d3, d5, e3 and e5 are as likely to be shot (the chase reaches them) but cold.
    const s = withGhost({ east: [['cruiser', 'c4'], ['destroyer', 'a1'], ['frigate', 'a6'], ['submarine', 'a8']] });
    preHit(s, 'east', ['d4', 'e4']);
    const v = viewOf(s, 'west');
    const east = v.targets.find((t) => t.sea === 'east')!;
    expect([east.hits, east.afloat]).toEqual([['d4', 'e4'], 10]);
    const odds = chances(east);
    // Hard plays a splash some rounds (three fleets afloat); every round it mines, the mine goes here.
    let mined = 0;
    for (let k = 0; k < 20; k++) {
      const c = chooseGhostTrick(v, legalOf(s, 'west'), { strength: 'hard', rng: createRng(k).next });
      if (!('trick' in c) || c.trick !== 'mine') continue;
      mined++;
      expect(c.at).toBe('east');
      expect(['d3', 'd5', 'e3', 'e5']).toContain(c.cell);
      // Colder than either end of the line.
      expect(odds.get(c.cell)!).toBeLessThan(Math.min(odds.get('c4')!, odds.get('f4')!));
    }
    expect(mined).toBeGreaterThanOrEqual(10);
  });

  test("a ghost never splashes the same cell again while its splash there is still on show", () => {
    // Same table as below: the coldest cell on south is the pick, unless the ghost's live splash already sits there.
    let s = deployed();
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
    preHit(s, 'east', ['a1', 'b1']);
    preHit(s, 'south', ['a1', 'b1', 'c1']);
    s = volleyOf(s, { north: [['west', 'b7'], ['south', 'h8'], ['south', 'h7'], ['south', 'h6']] });
    s.mines = ['e2', 'f2', 'g2'].map((cell) => ({ ghost: 'west', sea: 'north', cell, round: 1 }));
    const legal = legalOf(s, 'west');
    const first = chooseGhostTrick(viewOf(s, 'west'), legal, { strength: 'hard', rng: createRng(1).next }) as SplashCmd;
    s.splashes = [{ ghost: 'west', fool: first.fool, sea: first.at, cell: first.cell, round: s.round - 1, as: 'east' }];
    for (const strength of ['medium', 'hard'] as const) {
      for (let k = 0; k < 10; k++) {
        const c = chooseGhostTrick(viewOf(s, 'west'), legal, { strength, rng: createRng(k).next }) as SplashCmd;
        expect(c.trick === 'splash' && c.at === first.at && c.cell === first.cell).toBe(false);
      }
    }
  });

  test('the splash fools the fleet with most cells afloat, on a sea it fires at, in cold water', () => {
    // East has lost two cells and south three, north none; in the volley that sank west, north fired three
    // shells at south and one at west. West's three mines are down, so splashes are all it has.
    let s = deployed();
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
    preHit(s, 'east', ['a1', 'b1']);
    preHit(s, 'south', ['a1', 'b1', 'c1']);
    s = volleyOf(s, { north: [['west', 'b7'], ['south', 'h8'], ['south', 'h7'], ['south', 'h6']] });
    expect(viewOf(s, 'west').ghosts).toEqual(['west']);
    s.mines = ['e2', 'f2', 'g2'].map((cell) => ({ ghost: 'west', sea: 'north', cell, round: 1 }));
    expect(s.mines.length).toBe(MINE_LIMIT);
    const legal = legalOf(s, 'west');
    expect(legal.every((c) => 'trick' in c && c.trick === 'splash')).toBe(true);
    const v = viewOf(s, 'west');
    const afloat = Object.fromEntries(v.targets.map((t) => [t.sea, t.afloat]));
    expect([afloat.north, afloat.east, afloat.south]).toEqual([12, 10, 9]);
    const odds = chances(v.targets.find((t) => t.sea === 'south')!);
    const coldest = Math.min(...legal.filter((c) => (c as SplashCmd).at === 'south').map((c) => odds.get((c as SplashCmd).cell)!));
    for (const strength of ['medium', 'hard'] as const) {
      for (let k = 0; k < 10; k++) {
        const c = chooseGhostTrick(v, legal, { strength, rng: createRng(k).next }) as SplashCmd;
        expect([c.trick, c.fool, c.at]).toEqual(['splash', 'north', 'south']);
        expect(odds.get(c.cell)).toBe(coldest);
      }
    }
  });

  test('a resident ghost plays its trick through chooseSalvoMove', () => {
    const s = withGhost();
    const legal = legalOf(s, 'west');
    for (const strength of ['easy', 'medium', 'hard'] as const) {
      const c = chooseSalvoMove(viewOf(s, 'west'), legal, { strength, rng: createRng(1).next });
      expect('trick' in c).toBe(true);
      expect(legal.includes(c)).toBe(true);
    }
  });
});

describe('volleyMoment for ghosts', () => {
  test('my own sinking is the ghost moment, while the match goes on', () => {
    const s = withGhost();
    expect(s.lastVolley!.eliminated).toEqual(['west']);
    expect(volleyMoment(viewOf(s, 'west'))).toBe('ghost');
    // The others: north sank the submarine; east and south saw nothing land on them.
    expect(volleyMoment(viewOf(s, 'north'))).toBe('bigCascade');
    expect(volleyMoment(viewOf(s, 'south'))).toBeNull();
    // Sunk in the volley that ends the match: no ghost to be, only the hit.
    expect(volleyMoment(view([], { you: 'west', phase: 'over', lastVolley: volley({ shells: [{ from: 'north', sea: 'west', cell: 'b7', result: 'sunk', ship: 'submarine', blast: false }], eliminated: ['west'] }) }))).toBe('gotHit');
  });

  test('my mine backfiring is backfire; my trick landing is trick', () => {
    // Backfire: west's mine sits on east's cruiser (a1), and north's shell sends the cruiser down.
    let s = withGhost();
    s = turn.apply(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' });
    s = volleyOf(s, { north: [['east', 'a1']] });
    expect(s.lastVolley!.tricks).toMatchObject([{ kind: 'mine', ghost: 'west', result: 'backfire', ship: 'cruiser' }]);
    expect(volleyMoment(viewOf(s, 'west'))).toBe('backfire');
    expect(volleyMoment(viewOf(s, 'north'))).toBe('bigCascade');
    // Boomerang: west's mine on open water at east e2 comes back on north's d1.
    s = withGhost();
    s = turn.apply(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    s = volleyOf(s, { north: [['east', 'e2']] });
    expect(s.lastVolley!.tricks).toMatchObject([{ kind: 'mine', ghost: 'west', result: 'boomerang', hits: [{ sea: 'north', cell: 'd1' }] }]);
    expect(volleyMoment(viewOf(s, 'west'))).toBe('trick');
    expect(volleyMoment(viewOf(s, 'north'))).toBe('gotHit');
    // A splash told: the ghost's trick, never the fool's.
    s = withGhost();
    s = turn.apply(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volleyOf(s, {});
    s = turn.apply(s, 'west', { trick: 'mine', at: 'north', cell: 'h1' });
    s = volleyOf(s, {});
    expect(s.lastVolley!.tricks).toEqual([{ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' }]);
    expect(volleyMoment(viewOf(s, 'west'))).toBe('trick');
    expect(volleyMoment(viewOf(s, 'south'))).toBeNull();
  });

  test('a boomerang that lands nothing is no trick; ghost outranks backfire, backfire outranks trick, trick outranks a sinking', () => {
    const mine = { kind: 'mine' as const, ghost: 'south', sea: 'east', cell: 'e2', shooters: ['north'] };
    const boomerang = (hits: { sea: string; cell: string }[]) => ({ ...mine, result: 'boomerang' as const, hits });
    const backfire = { ...mine, result: 'backfire' as const, ship: 'cruiser' as const };
    expect(volleyMoment(view([], { lastVolley: volley({ tricks: [boomerang([])] }) }))).toBeNull();
    expect(volleyMoment(view([], { lastVolley: volley({ tricks: [{ ...boomerang([]), ghost: 'west', hits: [{ sea: 'north', cell: 'd1' }] }] }) }))).toBeNull();
    expect(volleyMoment(view([], { lastVolley: volley({ tricks: [boomerang([{ sea: 'north', cell: 'd1' }])], sunk: [{ sea: 'north', ship: 'cruiser', by: ['south'] }] }) }))).toBe('trick');
    expect(volleyMoment(view([], { lastVolley: volley({ tricks: [boomerang([{ sea: 'north', cell: 'd1' }]), backfire] }) }))).toBe('backfire');
    expect(volleyMoment(view([], { lastVolley: volley({ tricks: [backfire], eliminated: ['south'] }) }))).toBe('ghost');
  });
});

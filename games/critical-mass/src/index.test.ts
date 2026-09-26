import { describe, expect, test } from 'bun:test';
import { createRng } from '@cs/game-api';
import { criticalMassGame as G, SEATS, cellIndex, stateFromView, type CMCommand, type CMState, type CMView } from './index';

const turn = G.turn!;
const fresh = (n = 2): CMState => G.setup({ seats: SEATS.slice(0, n), seed: 1 });
const play = (s: CMState, seat: string, cell: string) => turn.apply(s, seat, { cell });
const at = (s: CMState, cell: string) => s.cells[cellIndex(s.cols, s.rows, cell)!];
const put = (s: CMState, cell: string, owner: string | null, orbs: number) => {
  const c = at(s, cell);
  c.owner = owner;
  c.orbs = orbs;
};
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return null;
};

describe('setup', () => {
  test('two players get a 6x9 board and red moves first', () => {
    const s = fresh();
    expect([s.cols, s.rows, s.cells.length]).toEqual([6, 9, 54]);
    expect(s.turn).toBe('red');
    expect(turn.toMove(s)).toEqual(['red']);
  });
  test('three or four players get 8x10', () => {
    expect([fresh(3).cols, fresh(4).rows]).toEqual([8, 10]);
  });
  test('rejects 1 or 5 players', () => {
    expect(codeOf(() => G.setup({ seats: ['red'], seed: 1 }))).toBe('BAD_SEATS');
  });
});

describe('moves', () => {
  test('placing passes the turn', () => {
    const s = play(fresh(), 'red', 'c3');
    expect(at(s, 'c3')).toEqual({ owner: 'red', orbs: 1 });
    expect(s.turn).toBe('blue');
    expect(s.lastMove).toEqual({ seat: 'red', cell: 'c3', waves: [] });
  });
  test('apply does not mutate its input', () => {
    const s = fresh();
    const before = JSON.stringify(s);
    play(s, 'red', 'c3');
    expect(JSON.stringify(s)).toBe(before);
  });
  test('illegal moves carry precise codes', () => {
    const s = play(fresh(), 'red', 'c3');
    expect(codeOf(() => play(fresh(), 'blue', 'a1'))).toBe('NOT_YOUR_TURN');
    expect(codeOf(() => play(fresh(), 'red', 'z9'))).toBe('BAD_CELL');
    expect(codeOf(() => play(fresh(), 'red', 'a10'))).toBe('BAD_CELL');
    expect(codeOf(() => turn.apply(fresh(), 'red', { cell: 5 }))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(fresh(), 'red', null))).toBe('BAD_COMMAND');
    expect(codeOf(() => play(s, 'blue', 'c3'))).toBe('OCCUPIED');
  });
  test('cell names are case-insensitive', () => {
    expect(at(play(fresh(), 'red', 'C3'), 'c3').orbs).toBe(1);
  });
});

describe('explosions', () => {
  test('a corner explodes at 2 and captures its neighbours', () => {
    let s = play(fresh(), 'red', 'a1');
    s = play(s, 'blue', 'f9');
    s = play(s, 'red', 'a1');
    expect(s.lastMove?.waves).toEqual([['a1']]);
    expect(at(s, 'a1')).toEqual({ owner: null, orbs: 0 });
    expect(at(s, 'a2')).toEqual({ owner: 'red', orbs: 1 });
    expect(at(s, 'b1')).toEqual({ owner: 'red', orbs: 1 });
    expect(s.turn).toBe('blue');
  });
  test('cascades resolve in waves and capture enemy cells', () => {
    const s = fresh();
    s.moved = ['red', 'blue'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    put(s, 'f9', 'blue', 1);
    const n = play(s, 'red', 'a1');
    expect(n.lastMove?.waves).toEqual([['a1'], ['b1']]);
    expect(at(n, 'b1')).toEqual({ owner: null, orbs: 0 });
    for (const c of ['a1', 'a2', 'b2', 'c1']) expect(at(n, c)).toEqual({ owner: 'red', orbs: 1 });
    expect(at(n, 'f9')).toEqual({ owner: 'blue', orbs: 1 });
    expect(n.winner).toBeNull();
    expect(n.turn).toBe('blue');
  });
  test('wiping out the last opponent wins immediately and stops the cascade', () => {
    const s = fresh();
    s.moved = ['red', 'blue'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    const n = play(s, 'red', 'a1');
    expect(n.lastMove?.waves).toEqual([['a1']]);
    expect(n.winner).toBe('red');
    expect(n.turn).toBeNull();
    expect(G.outcome(n)).toEqual({ winners: ['red'], placement: [['red'], ['blue']], reason: 'last-standing' });
    expect(turn.legal(n, 'red')).toEqual([]);
    expect(turn.toMove(n)).toEqual([]);
  });
  test('nobody is eliminated before everyone has moved', () => {
    const s = play(fresh(), 'red', 'c3');
    expect(s.eliminated).toEqual([]);
    expect(s.winner).toBeNull();
  });
  test('with three players an eliminated seat is skipped', () => {
    const s = fresh(3);
    s.moved = ['red', 'blue', 'green'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    put(s, 'h10', 'green', 1);
    const n = play(s, 'red', 'a1');
    expect(n.eliminated).toEqual(['blue']);
    expect(n.turn).toBe('green');
    expect(n.winner).toBeNull();
  });
});

describe('forfeit, legal, view', () => {
  test('forfeit hands the win to the last seat standing', () => {
    const s = play(fresh(), 'red', 'c3');
    const n = G.forfeit(s, 'red', 'resign');
    expect(n.winner).toBe('blue');
    expect(at(n, 'c3')).toEqual({ owner: null, orbs: 0 });
    expect(G.outcome(n)).toEqual({ winners: ['blue'], placement: [['blue'], ['red']], reason: 'resign' });
  });
  test('legal lists empty and own cells only, and nothing off-turn', () => {
    let s = play(fresh(), 'red', 'c3');
    s = play(s, 'blue', 'd4');
    expect(turn.legal(s, 'red')).toHaveLength(53);
    expect(turn.legal(s, 'blue')).toEqual([]);
  });
  test('the view is agent-friendly', () => {
    const s = play(fresh(), 'red', 'c3');
    const v = G.view(s, 'blue') as CMView;
    expect(v.you).toBe('blue');
    expect(v.board).toHaveLength(54);
    expect(v.board.find((b) => b.cell === 'a1')?.critical).toBe(2);
    expect(v.board.find((b) => b.cell === 'a3')?.critical).toBe(3);
    expect(v.board.find((b) => b.cell === 'c3')).toEqual({ cell: 'c3', owner: 'red', orbs: 1, critical: 4 });
    expect(v.counts.red).toEqual({ cells: 1, orbs: 1 });
    expect(v.ascii.split('\n')[0].startsWith(' 9 ')).toBe(true);
    expect(v.ascii).toContain('R1');
    expect(turn.describe!({ cell: 'c3' })).toBe('c3');
    expect(stateFromView(v)).toEqual(s);
  });
});

describe('random playouts', () => {
  test('games always finish and orbs are conserved', () => {
    for (let g = 0; g < 60; g++) {
      const rng = createRng(g + 1);
      let s = fresh(g % 3 === 0 ? 3 : 2);
      let guard = 0;
      while (!s.winner) {
        const seat = s.turn!;
        s = turn.apply(s, seat, rng.pick(turn.legal(s, seat) as CMCommand[]));
        const orbs = s.cells.reduce((n, c) => n + c.orbs, 0);
        if (orbs !== s.moveCount) throw new Error(`orbs ${orbs} != moves ${s.moveCount} in game ${g}`);
        if (++guard > 3000) throw new Error(`game ${g} did not finish`);
      }
      expect(G.outcome(s)?.winners).toEqual([s.winner]);
    }
  });
});

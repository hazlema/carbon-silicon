import { describe, expect, test } from 'bun:test';
import { criticalMassGame, cellIndex, type CMCommand, type CMState } from '@cs/critical-mass';
import { createRng } from '@cs/game-api';
import { chooseCriticalMassMove, evaluate } from './critical-mass';

const turn = criticalMassGame.turn!;
const fresh = () => criticalMassGame.setup({ seats: ['red', 'blue'], seed: 1 });
const put = (s: CMState, cell: string, owner: string, orbs: number) => {
  s.cells[cellIndex(s.cols, s.rows, cell)!] = { owner, orbs };
};

describe('chooseCriticalMassMove', () => {
  test('always takes a winning move, even when told to be random', () => {
    const s = fresh();
    s.moved = ['red', 'blue'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    const rng = createRng(1);
    for (const depth of [1, 2] as const) {
      expect(chooseCriticalMassMove(s, 'red', { depth, randomness: 1, rng: rng.next })).toEqual({ cell: 'a1' });
    }
  });
  test('always returns a legal move through whole games', () => {
    const rng = createRng(5);
    let s = fresh();
    let guard = 0;
    while (!s.winner && guard++ < 400) {
      const seat = s.turn!;
      const move =
        seat === 'red'
          ? chooseCriticalMassMove(s, seat, { depth: 2, randomness: 0.15, rng: rng.next })
          : rng.pick(turn.legal(s, seat) as CMCommand[]);
      expect(turn.legal(s, seat)).toContainEqual(move);
      s = turn.apply(s, seat, move);
    }
    expect(s.winner).not.toBeNull();
  });
  test('the depth-2 bot beats a random player most of the time', () => {
    let wins = 0;
    for (let g = 0; g < 10; g++) {
      const rng = createRng(100 + g);
      let s = fresh();
      while (!s.winner) {
        const seat = s.turn!;
        const move =
          seat === 'red'
            ? chooseCriticalMassMove(s, seat, { depth: 2, randomness: 0, rng: rng.next })
            : rng.pick(turn.legal(s, seat) as CMCommand[]);
        s = turn.apply(s, seat, move);
      }
      if (s.winner === 'red') wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(8);
  });
  test('evaluate favours the side with more material', () => {
    const s = fresh();
    put(s, 'c3', 'red', 3);
    put(s, 'd4', 'blue', 1);
    expect(evaluate(s, 'red')).toBeGreaterThan(0);
    expect(evaluate(s, 'blue')).toBeLessThan(0);
  });
});

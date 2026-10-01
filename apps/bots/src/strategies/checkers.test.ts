import { describe, expect, test } from 'bun:test';
import { checkersGame, type CheckersState } from '@cs/checkers';
import { chooseCheckersMove, evaluate } from './checkers';

const piece = (id: string, side: 'red' | 'blue', square: string, king = false) => ({ id, side, square, king });
function position(pieces: ReturnType<typeof piece>[], turn: 'red' | 'blue' = 'red'): CheckersState {
  return { pieces, turn, forcedPiece: null, winner: null, revision: 0, history: [], quietMoves: 0, positions: {}, moveCount: 0, endReason: null };
}
const best = (s: CheckersState) => chooseCheckersMove(s, s.turn, { randomness: 0, rng: () => 0.5 }).steps;

describe('evaluate', () => {
  test('material, kings worth more, men nearer the crown worth a little more', () => {
    const s = position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'f6', true)]);
    expect(evaluate(s, 'red')).toBeLessThan(0);
    expect(evaluate(position([piece('r1', 'red', 'c7'), piece('b1', 'blue', 'h8')]), 'red')).toBeGreaterThan(evaluate(position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'h8')]), 'red'));
  });
  test('a decided game is decisive', () => {
    expect(evaluate({ ...position([piece('r1', 'red', 'c3')]), winner: 'red' }, 'red')).toBe(1000);
    expect(evaluate({ ...position([piece('r1', 'red', 'c3')]), winner: 'red' }, 'blue')).toBe(-1000);
  });
});

describe('chooseCheckersMove', () => {
  test('one legal command (a forced capture) is played as is', () => {
    const s = position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'd4'), piece('b2', 'blue', 'h8')]);
    expect(best(s)).toEqual(['c3', 'e5']);
  });
  test("doesn't march a man into a free capture when a safe square exists", () => {
    // d4 would be jumped by e5 (landing c3, empty once we leave); b4 is safe.
    const s = position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'e5'), piece('b2', 'blue', 'h8')]);
    expect(best(s)).toEqual(['c3', 'b4']);
  });
  test('crowns when it can', () => {
    const s = position([piece('r1', 'red', 'b7'), piece('r2', 'red', 'a1'), piece('b1', 'blue', 'h4')]);
    expect(best(s)[0]).toBe('b7');
  });
  test('a winning move scores as a win, even with no reply to search', () => {
    // Two captures, both taking blue's last piece: the search must score them without an opponent reply.
    const s = position([piece('r1', 'red', 'c3'), piece('r2', 'red', 'e3'), piece('b1', 'blue', 'd4')]);
    expect([['c3', 'e5'], ['e3', 'c5']]).toContainEqual(best(s));
  });
  test('randomness 1 still plays something legal', () => {
    const s = checkersGame.setup({ seats: ['red', 'blue'] } as never);
    const legal = checkersGame.turn.legal(s, 'red').map((c) => c.steps.join());
    for (let i = 0; i < 20; i++) expect(legal).toContain(chooseCheckersMove(s, 'red', { randomness: 1, rng: Math.random }).steps.join());
  });
  test('fast enough to think between moves', () => {
    const s = checkersGame.setup({ seats: ['red', 'blue'] } as never);
    let t = performance.now();
    chooseCheckersMove(s, 'red', { randomness: 0, rng: Math.random });
    expect(performance.now() - t).toBeLessThan(50);
    // a busier middle game: play 10 random plies first
    let g = s;
    for (let i = 0; i < 10 && !g.winner; i++) {
      const moves = checkersGame.turn.legal(g, g.turn);
      g = checkersGame.turn.apply(g, g.turn, moves[i % moves.length]);
    }
    t = performance.now();
    if (!g.winner) chooseCheckersMove(g, g.turn, { randomness: 0, rng: Math.random });
    expect(performance.now() - t).toBeLessThan(50);
  });
});

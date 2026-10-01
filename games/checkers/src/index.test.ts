import {describe, expect, test} from 'bun:test';
import {createRng, GameRuleError, type GameModule} from '@cs/game-api';
import checkersGame, {type CheckersState, type CheckersCommand} from './index';
import {type Piece} from './rules';

const turn = checkersGame.turn;
const setup = () => checkersGame.setup({seats: ['red', 'blue'], seed: 42});
const piece = (id: string, side: 'red' | 'blue', square: string, king = false): Piece => ({id, side, square, king});
const fixture = (pieces: Piece[]): CheckersState => ({...setup(), pieces, positions: {}});
function ruleError(action: () => unknown, code: string) {
  try { action(); throw new Error('Expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(GameRuleError); expect((error as GameRuleError).code).toBe(code); }
}

describe('Carbon & Silicon contract', () => {
  test('sets up two armies deterministically and exposes only the active seat’s commands', () => {
    const module: GameModule<CheckersState> = checkersGame;
    const s = setup();
    expect(module.setup({seats: ['red', 'blue'], seed: 99})).toEqual(s);
    expect(s.pieces.filter(p => p.side === 'red')).toHaveLength(12);
    expect(s.pieces.filter(p => p.side === 'blue')).toHaveLength(12);
    expect(turn.toMove(s)).toEqual(['red']);
    expect(turn.legal(s, 'red')).toHaveLength(7);
    expect(turn.legal(s, 'blue')).toEqual([]);
    expect(turn.legal(s, 'spectator')).toEqual([]);
    expect(checkersGame.outcome(s)).toBeNull();
    for (const seats of [[], ['red'], ['blue', 'red'], ['red', 'red'], ['red', 'black'], ['red', 'blue', 'green']]) {
      ruleError(() => module.setup({seats, seed: 0}), 'BAD_SEATS');
    }
  });

  test('enumerates complete branching chains and rejects partial or extra hops atomically', () => {
    const s = fixture([piece('r', 'red', 'a1'), piece('b1', 'blue', 'b2'), piece('b2', 'blue', 'b4'), piece('b3', 'blue', 'd4'), piece('b4', 'blue', 'h8')]);
    const before = structuredClone(s);
    expect(turn.legal(s, 'red')).toEqual([{steps: ['a1', 'c3', 'a5']}, {steps: ['a1', 'c3', 'e5']}]);
    ruleError(() => turn.apply(s, 'red', {steps: ['a1', 'c3']}), 'ILLEGAL_MOVE');
    ruleError(() => turn.apply(s, 'red', {steps: ['a1', 'c3', 'e5', 'f6']}), 'ILLEGAL_MOVE');
    const n = turn.apply(s, 'red', {steps: ['a1', 'c3', 'e5']});
    expect(n.pieces.map(p => p.square)).toEqual(['e5', 'b4', 'h8']);
    expect(n.forcedPiece).toBeNull();
    expect(turn.toMove(n)).toEqual(['blue']);
    expect(n.moveCount).toBe(1);
    expect(n.history).toHaveLength(2);
    expect(s).toEqual(before);
  });

  test('promotion ends the command even when the new king could jump backward', () => {
    const s = fixture([piece('r', 'red', 'b6'), piece('b1', 'blue', 'c7'), piece('b2', 'blue', 'e7')]);
    expect(turn.legal(s, 'red')).toEqual([{steps: ['b6', 'd8']}]);
    const n = turn.apply(s, 'red', {steps: ['b6', 'd8']});
    expect(n.pieces[0].king).toBe(true);
    expect(turn.toMove(n)).toEqual(['blue']);
    ruleError(() => turn.apply(s, 'red', {steps: ['b6', 'd8', 'f6']}), 'ILLEGAL_MOVE');
  });

  test('validates untrusted commands and seat ownership with the platform error class', () => {
    const s = setup();
    ruleError(() => turn.apply(s, 'blue', {steps: ['b6', 'a5']}), 'NOT_YOUR_TURN');
    ruleError(() => turn.apply(s, 'visitor', {steps: ['a3', 'b4']}), 'BAD_SEAT');
    for (const command of [null, undefined, 2, [], 'a3', {}, {from: 'a3', to: 'b4'}, {steps: []}, {steps: ['a3']}, {steps: ['a3', 1]}, {steps: ['a3', 'i9']}, {steps: ['a3', 'b4'], extra: true}]) {
      ruleError(() => turn.apply(s, 'red', command), 'BAD_COMMAND');
    }
    ruleError(() => turn.apply(s, 'red', {steps: ['a3', 'a4']}), 'ILLEGAL_MOVE');
  });

  test('reports capture and blocked wins, stops the clock, and rejects post-game play', () => {
    for (const [pieces, command, reason] of [
      [[piece('r', 'red', 'a1'), piece('b', 'blue', 'b2')], {steps: ['a1', 'c3']}, 'last-piece'],
      [[piece('r', 'red', 'a3'), piece('r2', 'red', 'g1'), piece('b', 'blue', 'h2')], {steps: ['a3', 'b4']}, 'no-moves'],
    ] as const) {
      const n = turn.apply(fixture([...pieces]), 'red', command);
      expect(checkersGame.outcome(n)).toEqual({winners: ['red'], placement: [['red'], ['blue']], reason});
      expect(turn.toMove(n)).toEqual([]);
      expect(turn.legal(n, 'blue')).toEqual([]);
      expect(checkersGame.isOut(n, 'blue')).toBe(true);
      expect(checkersGame.isOut(n, 'red')).toBe(false);
      ruleError(() => turn.apply(n, 'blue', {steps: ['h2', 'g1']}), 'GAME_OVER');
    }
  });

  test('reports both automatic draws as tied placements', () => {
    const start = () => fixture([piece('r', 'red', 'a1', true), piece('b', 'blue', 'h8', true)]);
    const quiet = turn.apply({...start(), quietMoves: 79}, 'red', {steps: ['a1', 'b2']});
    expect(checkersGame.outcome(quiet)).toEqual({winners: [], placement: [['red', 'blue']], reason: 'quiet-moves'});
    let s = start();
    for (let i = 0; i < 3 && !s.winner; i++) {
      for (const steps of [['a1', 'b2'], ['h8', 'g7'], ['b2', 'a1'], ['g7', 'h8']]) {
        if (!s.winner) s = turn.apply(s, s.turn, {steps});
      }
    }
    expect(checkersGame.outcome(s)).toEqual({winners: [], placement: [['red', 'blue']], reason: 'repetition'});
    expect(turn.toMove(s)).toEqual([]);
    expect(checkersGame.isOut(s, 'red')).toBe(false);
  });

  test('forfeits either seat, preserves the reason, and cannot overturn a finished result', () => {
    for (const seat of ['red', 'blue'] as const) for (const reason of ['resign', 'timeout', 'disconnect']) {
      const s = setup(), before = structuredClone(s);
      const n = checkersGame.forfeit(s, seat, reason), winner = seat === 'red' ? 'blue' : 'red';
      expect(checkersGame.outcome(n)).toEqual({winners: [winner], placement: [[winner], [seat]], reason});
      expect(n.pieces.some(p => p.side === seat)).toBe(false);
      expect(turn.toMove(n)).toEqual([]);
      expect(checkersGame.isOut(n, seat)).toBe(true);
      expect(checkersGame.forfeit(n, winner, 'resign')).toEqual(n);
      expect(s).toEqual(before);
    }
    ruleError(() => checkersGame.forfeit(setup(), 'visitor', 'resign'), 'BAD_SEAT');
  });

  test('views are detached JSON for both players and spectators', () => {
    const s = setup();
    for (const seat of ['red', 'blue', null] as const) {
      const view = checkersGame.view(s, seat);
      expect(view.you).toBe(seat);
      expect(view.pieces).toHaveLength(24);
      expect(JSON.parse(JSON.stringify(view))).toEqual(view);
      view.pieces[0].square = 'h8';
      view.positions.changed = 1;
      expect(s.pieces[0].square).toBe('a1');
      expect(s.positions.changed).toBeUndefined();
    }
    expect(turn.describe({steps: ['a1', 'c3', 'e5']})).toBe('a1→c3→e5');
  });

  test('legal/apply agree across seeded complete games and JSON persistence', () => {
    const rng = createRng(12345);
    for (let run = 0; run < 100; run++) {
      let s = setup();
      for (let ply = 0; ply < 500 && !s.winner; ply++) {
        const before = structuredClone(s);
        const commands = turn.legal(s, s.turn);
        expect(commands.length).toBeGreaterThan(0);
        for (const command of commands) {
          const n = turn.apply(s, s.turn, JSON.parse(JSON.stringify(command)));
          expect(n.forcedPiece).toBeNull();
          expect(n.turn).not.toBe(s.turn);
          expect(JSON.parse(JSON.stringify(n))).toEqual(n);
        }
        expect(s).toEqual(before);
        s = turn.apply(s, s.turn, rng.pick(commands) as CheckersCommand);
      }
      expect(checkersGame.outcome(s)).not.toBeNull();
    }
  }, 60000);
});

import { describe, expect, test } from 'bun:test';
import type { MatchEnvelope } from '@cs/shared/protocol';
import { CELLS, KNIGHTS, ranksLine, ROUNDS, standingLine, tableContext } from './table-context';

const seat = (s: string, handle: string, kind: 'human' | 'agent') => ({ seat: s, identity: { id: handle, handle, kind } });
const env = (over: Partial<MatchEnvelope> & { gameId: string; view: unknown; seats: ReturnType<typeof seat>[]; toMove?: string[]; status?: string }): MatchEnvelope =>
  ({
    match: { id: 'm_1', gameId: over.gameId, status: over.status ?? 'live', revision: 9, seats: over.seats, toMove: over.toMove ?? [], deadline: null, startsAt: '', outcome: null, endReason: null, tableId: 't_1' },
    you: over.you ?? null,
    view: over.view,
    legal: [],
    recent: over.recent,
    ...(over.realtime ? { realtime: over.realtime } : {}),
  }) as unknown as MatchEnvelope;
const three = [seat('red', 'Frosty', 'human'), seat('blue', 'Fable', 'agent'), seat('green', 'OLD_IRON', 'agent')];

describe('standingLine', () => {
  const e = (handle: string, value: number, you = false, out = false, note?: string) => ({ handle, value, you, out, note });
  test('leader first, the bot as you, the last of three as down to', () => {
    expect(standingLine([e('Frosty', 5), e('Fable', 14), e('OLD_IRON', 11, true)], CELLS)).toBe('Fable leads with 14 cells, you hold 11, Frosty is down to 5');
  });
  test('you in front, a tie at the top, someone out', () => {
    expect(standingLine([e('Fable', 3), e('OLD_IRON', 8, true)], KNIGHTS)).toBe('you lead with 8 knights, Fable has 3');
    expect(standingLine([e('Fable', 2), e('OLD_IRON', 2, true), e('Frosty', 0, false, true)], ROUNDS)).toBe('Fable and you are level at 2 rounds, Frosty is out');
  });
  test('one is singular: "1 cell", not "1 cells"', () => {
    expect(standingLine([e('Fable', 1), e('OLD_IRON', 0, true)], CELLS)).toBe('Fable leads with 1 cell, you hold 0');
    expect(standingLine([e('Fable', 1), e('OLD_IRON', 1, true)], ROUNDS)).toBe('Fable and you are level at 1 round');
    expect(standingLine([e('Fable', 1), e('OLD_IRON', 0, true)], KNIGHTS)).toBe('Fable leads with 1 knight, you hold 0');
  });
  test('round wins only go up: the last of three "has", never "is down to"', () => {
    expect(standingLine([e('Frosty', 0), e('Fable', 2), e('OLD_IRON', 1, true)], ROUNDS)).toBe('Fable leads with 2 rounds, you hold 1, Frosty has 0');
  });
  test('notes ride along', () => {
    expect(standingLine([e('Fable', 9, false, false, '2 crowned'), e('OLD_IRON', 7, true)], KNIGHTS)).toBe('Fable leads with 9 knights (2 crowned), you hold 7');
  });
});

describe('tableContext', () => {
  test('Critical Mass: players with you, whose turn, cells, the last ten moves', () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({ number: i + 25, seat: 'red', handle: 'Frosty', text: `places at c${(i % 9) + 1}` }));
    const ctx = tableContext(
      env({
        gameId: 'critical-mass',
        seats: three,
        you: 'green',
        toMove: ['blue'],
        recent,
        view: { counts: { red: { cells: 5, orbs: 6 }, blue: { cells: 14, orbs: 20 }, green: { cells: 11, orbs: 13 } }, eliminated: [] },
      }),
    );
    expect(ctx.players).toBe('@Frosty (human), @Fable (machine), @OLD_IRON (you)');
    expect(ctx.turn).toBe('Turn 37 — @Fable to move');
    expect(ctx.standing).toBe('Fable leads with 14 cells, you hold 11, Frosty is down to 5');
    expect(ctx.moves).toHaveLength(10);
    expect(ctx.moves[0]).toBe('27. Frosty places at c3');
    expect(ctx.moves.at(-1)).toBe('36. Frosty places at c3');
  });
  test('your own turn, and a round nobody survived prints without a name', () => {
    const ctx = tableContext(
      env({ gameId: 'critical-mass', seats: three.slice(0, 2), you: 'red', toMove: ['red'], recent: [{ number: 1, seat: null, handle: null, text: 'Round 1: nobody survives' }], view: { counts: {}, eliminated: [] } }),
    );
    expect(ctx.turn).toBe('Turn 2 — your move');
    expect(ctx.moves).toEqual(['1. Round 1: nobody survives']);
  });
  test('the turn number comes from the game (moveCount), so a log emptied by a restart still says the right turn', () => {
    const ctx = tableContext(
      env({ gameId: 'critical-mass', seats: three.slice(0, 2), you: 'red', toMove: ['blue'], recent: [], view: { moveCount: 36, counts: {}, eliminated: [] } }),
    );
    expect(ctx.turn).toBe('Turn 37 — @Fable to move');
  });
  test('Crown & Steel counts knights and crowns', () => {
    const p = (side: string, king = false) => ({ side, king });
    const ctx = tableContext(
      env({ gameId: 'checkers', seats: [seat('red', 'Frosty', 'human'), seat('blue', 'GAME_OVER', 'agent')], you: 'blue', toMove: ['red'], recent: [], view: { pieces: [p('red'), p('red', true), p('red', true), p('blue')] } }),
    );
    expect(ctx.standing).toBe('Frosty leads with 3 knights (2 crowned), you hold 1');
    expect(ctx.moves).toEqual([]);
  });
  test('Lightline: the round and the round wins', () => {
    const ctx = tableContext(
      env({ gameId: 'lightline', seats: three.slice(0, 2), you: 'blue', recent: [], realtime: { tick: 4, fired: {} }, view: { round: 3, score: { red: 1, blue: 2 } } } as never),
    );
    expect(ctx.turn).toBe('Round 3');
    expect(ctx.standing).toBe('you lead with 2 rounds, Frosty has 1');
  });
  test('Salvo: ship cells afloat with scrap, my own sea from my fleet, who the round waits for', () => {
    const seats = [seat('north', 'Frosty', 'human'), seat('east', 'Fable', 'agent'), seat('south', 'OLD_IRON', 'agent'), seat('west', 'Sprocket', 'agent')];
    const view = {
      round: 4,
      // g8 is a hit on my live decoy: it costs my fleet nothing.
      mySea: {
        ships: [
          { id: 'cruiser', cells: ['a1', 'b1', 'c1', 'd1'], hits: ['a1'] },
          { id: 'destroyer', cells: ['a3', 'a4', 'a5'], hits: ['a3'] },
        ],
        port: [],
        shots: { a1: 'hit', a2: 'miss', a3: 'hit', g8: 'hit' },
        decoy: { cells: ['g8', 'h8'], hits: ['g8'] },
      },
      targets: [
        { sea: 'north', afloat: 12 },
        { sea: 'east', afloat: 7 },
      ],
      scrap: { north: 2, east: 9, south: 4, west: 1 },
      eliminated: ['west'],
    };
    const ctx = tableContext(env({ gameId: 'salvo', seats, you: 'south', toMove: ['north', 'south'], recent: [], view }));
    expect(ctx.standing).toBe('Frosty leads with 12 ship cells afloat (2 scrap), you hold 10 (4 scrap), Fable is down to 7 (9 scrap), Sprocket is out');
    expect(ctx.turn).toBe('Round 4 — waiting for @Frosty, you');
    expect(tableContext(env({ gameId: 'salvo', seats, you: 'south', toMove: ['east'], recent: [], view: { ...view, round: 0 } })).turn).toBe('Deployment — waiting for @Fable');
  });
  test('before the start and after the end; an unknown game has no standing', () => {
    expect(tableContext(env({ gameId: 'mystery', seats: three, status: 'countdown', view: {} })).turn).toBe('The match is about to start');
    const over = tableContext(env({ gameId: 'mystery', seats: three, status: 'over', view: {} }));
    expect(over.turn).toBe('The match is over');
    expect(over.standing).toBeNull();
  });
});

describe('ranksLine', () => {
  const seats = [
    { seat: 'red', identity: { id: 'f', handle: 'Frosty' } },
    { seat: 'blue', identity: { id: 'o', handle: 'OLD_IRON' } },
    { seat: 'green', identity: { id: 'n', handle: 'newbie' } },
  ];
  const rows = [
    { rank: 1, elo: 1184, identity: { id: 'o', handle: 'OLD_IRON' } },
    { rank: 3, elo: 1062, identity: { id: 'f', handle: 'Frosty' } },
  ];
  test('you first, then the others in seat order; players with no rated games say so', () => {
    expect(ranksLine('Crown & Steel', rows, seats, 'blue')).toBe(
      'This month in Crown & Steel: you are 1st (Elo 1184), @Frosty is 3rd (1062), @newbie has no ranked games yet.',
    );
  });
  test('you without a rank, and a spectator’s view', () => {
    expect(ranksLine('Lightline', [], seats.slice(0, 2), 'red')).toBe('This month in Lightline: you have no ranked games yet, @OLD_IRON has no ranked games yet.');
    expect(ranksLine('Lightline', rows, seats.slice(0, 2), null)).toBe('This month in Lightline: @Frosty is 3rd (1062), @OLD_IRON is 1st (1184).');
  });
  test('no seats, no line', () => {
    expect(ranksLine('Lightline', rows, [], null)).toBeNull();
  });
});

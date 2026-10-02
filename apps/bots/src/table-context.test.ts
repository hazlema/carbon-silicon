import { describe, expect, test } from 'bun:test';
import type { MatchEnvelope } from '@cs/shared/protocol';
import { standingLine, tableContext } from './table-context';

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
    expect(standingLine([e('Frosty', 5), e('Fable', 14), e('OLD_IRON', 11, true)], 'cells')).toBe('Fable leads with 14 cells, you hold 11, Frosty is down to 5');
  });
  test('you in front, a tie at the top, someone out', () => {
    expect(standingLine([e('Fable', 3), e('OLD_IRON', 8, true)], 'knights')).toBe('you lead with 8 knights, Fable has 3');
    expect(standingLine([e('Fable', 2), e('OLD_IRON', 2, true), e('Frosty', 0, false, true)], 'rounds')).toBe('Fable and you are level at 2 rounds, Frosty is out');
  });
  test('notes ride along', () => {
    expect(standingLine([e('Fable', 9, false, false, '2 crowned'), e('OLD_IRON', 7, true)], 'knights')).toBe('Fable leads with 9 knights (2 crowned), you hold 7');
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
  test('before the start and after the end; an unknown game has no standing', () => {
    expect(tableContext(env({ gameId: 'mystery', seats: three, status: 'countdown', view: {} })).turn).toBe('The match is about to start');
    const over = tableContext(env({ gameId: 'mystery', seats: three, status: 'over', view: {} }));
    expect(over.turn).toBe('The match is over');
    expect(over.standing).toBeNull();
  });
});

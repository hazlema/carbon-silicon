import { describe, expect, test } from 'bun:test';
import { verdictLine } from './verdict';

const handles: Record<string, string> = { red: 'Frosty', blue: 'Fable', green: 'OLD_IRON' };
const handleOf = (seat: string) => handles[seat] ?? seat;

describe('verdictLine', () => {
  test('known reasons read as English', () => {
    expect(verdictLine({ winners: ['red'], placement: [['red'], ['blue']], reason: 'last-standing' }, handleOf)).toBe('@Frosty wins, last one standing. GG.');
    expect(verdictLine({ winners: ['blue'], placement: [['blue'], ['red']], reason: 'no-moves' }, handleOf)).toBe('@Fable wins: @Frosty has no moves left. GG.');
    expect(verdictLine({ winners: ['blue'], placement: [['blue'], ['red']], reason: 'last-piece' }, handleOf)).toBe('@Fable wins, taking the last knight. GG.');
    expect(verdictLine({ winners: ['red'], placement: [['red'], ['blue']], reason: 'resign' }, handleOf)).toBe('@Frosty wins by resignation. GG.');
    expect(verdictLine({ winners: ['red'], placement: [['red'], ['blue']], reason: 'timeout' }, handleOf)).toBe('@Frosty wins on time. GG.');
    expect(verdictLine({ winners: ['red'], placement: [['red'], ['blue']], reason: 'forfeit' }, handleOf)).toBe('@Frosty wins by forfeit. GG.');
    expect(verdictLine({ winners: [], placement: [['red', 'blue']], reason: 'repetition' }, handleOf)).toBe('Draw: the same position came up three times.');
    expect(verdictLine({ winners: [], placement: [['red', 'blue']], reason: 'quiet-moves' }, handleOf)).toBe('Draw: too many moves without a capture or a crowning.');
  });
  test('Lightline: the round score with names, winner first', () => {
    expect(
      verdictLine({ winners: ['blue'], placement: [['blue'], ['green'], ['red']], reason: 'rounds', score: { red: 0, blue: 2, green: 1 } }, handleOf),
    ).toBe('@Fable wins on rounds: Fable 2, OLD_IRON 1, Frosty 0. GG.');
    expect(verdictLine({ winners: [], placement: [['red', 'blue']], reason: 'rounds', score: { red: 1, blue: 1 } }, handleOf)).toBe(
      'Draw on rounds: Frosty 1, Fable 1.',
    );
  });
  test('two winners share it; an unknown reason still shows, dashes as spaces', () => {
    expect(verdictLine({ winners: ['red', 'blue'], placement: [['red', 'blue'], ['green']], reason: 'house-rules' }, handleOf)).toBe('@Frosty & @Fable win (house rules). GG.');
    expect(verdictLine({ winners: [], placement: [['red', 'blue']], reason: 'odd-end' }, handleOf)).toBe('Draw (odd end).');
  });
});

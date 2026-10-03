import { describe, expect, test } from 'bun:test';
import { rankLines, rateSeason, resultOf, type RatedMatch, type SeasonLine } from './ratings';

let n = 0;
/** A match from a best-first placement of player ids; seats are s0, s1, … in that order. */
function match(placement: string[][], winners?: string[]): RatedMatch {
  const seats = placement.flat().map((playerId, i) => ({ seat: `s${i}`, playerId }));
  const seatOf = (p: string) => seats.find((s) => s.playerId === p)!.seat;
  const groups = placement.map((g) => g.map(seatOf));
  return { id: `m${++n}`, outcome: { winners: (winners ?? (groups.length > 1 ? groups[0].map((s) => s) : [])).map((x) => x), placement: groups }, seats };
}
const by = (lines: SeasonLine[]) => Object.fromEntries(lines.map((l) => [l.playerId, l]));

describe('resultOf', () => {
  test('sole first is a win, shared first or no winners a draw, the rest losses', () => {
    expect(resultOf({ winners: ['a'], placement: [['a'], ['b']] }, 'a')).toBe('win');
    expect(resultOf({ winners: ['a'], placement: [['a'], ['b']] }, 'b')).toBe('loss');
    expect(resultOf({ winners: ['a', 'b'], placement: [['a', 'b'], ['c']] }, 'b')).toBe('draw');
    expect(resultOf({ winners: ['a', 'b'], placement: [['a', 'b'], ['c']] }, 'c')).toBe('loss');
    expect(resultOf({ winners: [], placement: [['a', 'b']] }, 'a')).toBe('draw');
  });
});

describe('rateSeason', () => {
  test('a two-player win at 1000 each: +16 and −16, 3 points and 0', () => {
    const r = by(rateSeason([match([['A'], ['B']])]));
    expect(r.A).toEqual({ playerId: 'A', points: 3, wins: 1, draws: 0, losses: 0, games: 1, elo: 1016 });
    expect(r.B).toEqual({ playerId: 'B', points: 0, wins: 0, draws: 0, losses: 1, games: 1, elo: 984 });
  });
  test('a draw between equals moves nothing and is worth 1 point each', () => {
    const r = by(rateSeason([match([['A', 'B']], [])]));
    expect(r.A).toMatchObject({ points: 1, draws: 1, elo: 1000 });
    expect(r.B).toMatchObject({ points: 1, draws: 1, elo: 1000 });
  });
  test('four players by placement, a tied middle: K/3 per pair', () => {
    const r = by(rateSeason([match([['A'], ['B', 'C'], ['D']])]));
    expect(r.A.elo).toBeCloseTo(1016, 9);
    expect(r.B.elo).toBeCloseTo(1000, 9);
    expect(r.C.elo).toBeCloseTo(1000, 9);
    expect(r.D.elo).toBeCloseTo(984, 9);
    expect([r.A.points, r.B.points, r.C.points, r.D.points]).toEqual([3, 0, 0, 0]);
  });
  test('K is 32 through a player’s 10th game and 16 from the 11th', () => {
    const draws = (k: number) => Array.from({ length: k }, () => match([['A', 'B']], []));
    const tenth = by(rateSeason([...draws(9), match([['A'], ['B']])]));
    expect(tenth.A.elo).toBeCloseTo(1016, 9);
    const eleventh = by(rateSeason([...draws(10), match([['A'], ['B']])]));
    expect(eleventh.A.elo).toBeCloseTo(1008, 9);
    expect(eleventh.A.games).toBe(11);
  });
  test('each player uses their own K', () => {
    const r = by(rateSeason([...Array.from({ length: 10 }, () => match([['A', 'B']], [])), match([['A'], ['C']])]));
    expect(r.A.elo).toBeCloseTo(1008, 9);
    expect(r.C.elo).toBeCloseTo(984, 9);
  });
  test('an empty season has no lines', () => {
    expect(rateSeason([])).toEqual([]);
  });
});

describe('rankLines', () => {
  const line = (playerId: string, points: number, wins: number, elo: number): SeasonLine => ({ playerId, points, wins, draws: 0, losses: 0, games: 1, elo });
  test('points, then wins, then Elo, then handle (case-insensitive); ranks are unique', () => {
    const handles: Record<string, string> = { p: 'zed', q: 'Amy', r: 'bob', s: 'cat', t: 'ann' };
    const ranked = rankLines([line('p', 3, 1, 1000), line('q', 4, 1, 990), line('r', 4, 2, 980), line('s', 4, 2, 1010), line('t', 3, 1, 1000)], (id) => handles[id]);
    expect(ranked.map((l) => [l.rank, l.playerId])).toEqual([[1, 's'], [2, 'r'], [3, 'q'], [4, 't'], [5, 'p']]);
  });
});

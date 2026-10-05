import { describe, expect, test } from 'bun:test';
import { createRng, validateDoctrine, type Action } from '@cs/game-api';
import { CATALOG, DEFAULT_DOCTRINE, H, W, lightlineGame as game, type LLState } from './index';

const rt = game.realtime!;
const rng = createRng(1);
const at = (s: LLState, x: number, y: number) => s.cells[y * W + x];
const two = () => game.setup({ seats: ['red', 'blue'], seed: 1 });
const step = (s: LLState, actions: Record<string, Action> = {}) => rt.step(s, actions, rng);
const run = (s: LLState, n: number, actions: Record<string, Action> = {}) => {
  for (let i = 0; i < n; i++) s = step(s, actions);
  return s;
};
/** A copy with some cycles moved by hand. */
const place = (s: LLState, moves: Record<string, Partial<LLState['cycles'][number]>>): LLState => {
  const cells = new Array<string>(W * H).fill('.');
  const cycles = s.cycles.map((c) => ({ ...c, ...(moves[c.seat] ?? {}) }));
  for (const c of cycles) if (c.alive) cells[c.y * W + c.x] = c.seat === 'red' ? 'R' : c.seat === 'blue' ? 'B' : c.seat === 'green' ? 'G' : 'Y';
  return { ...s, cells, cycles };
};

describe('setup', () => {
  test('two cycles start mid-edge, 8 cells in, facing each other; their head cells are marked', () => {
    const s = two();
    expect(s.cycles.map(({ seat, x, y, heading }) => ({ seat, x, y, heading }))).toEqual([
      { seat: 'red', x: 8, y: 20, heading: 'e' },
      { seat: 'blue', x: 55, y: 20, heading: 'w' },
    ]);
    expect(at(s, 8, 20)).toBe('R');
    expect(s).toMatchObject({ round: 1, phase: 'play', roundTick: 0, score: { red: 0, blue: 0 } });
  });
  test('four cycles pinwheel from the corners', () => {
    const s = game.setup({ seats: ['red', 'blue', 'green', 'gold'], seed: 1 });
    expect(s.cycles.map(({ x, y, heading }) => [x, y, heading])).toEqual([[8, 8, 'e'], [55, 31, 'w'], [55, 8, 's'], [8, 31, 'n']]);
  });
  test('the default doctrine passes validation', () => {
    expect(() => validateDoctrine(DEFAULT_DOCTRINE, CATALOG)).not.toThrow();
  });
});

describe('moving and crashing', () => {
  test('one cell a tick, leaving trail; turns and headings; a reversal is ignored', () => {
    let s = step(two());
    expect(s.cycles[0]).toMatchObject({ x: 9, y: 20 });
    expect(at(s, 8, 20)).toBe('R');
    s = step(s, { red: { act: 'turn', dir: 'left' } });
    expect(s.cycles[0]).toMatchObject({ x: 9, y: 19, heading: 'n' });
    s = step(s, { red: { act: 'head', dir: 's' } });
    expect(s.cycles[0]).toMatchObject({ x: 9, y: 18, heading: 'n' });
    s = step(s, { red: { act: 'head', dir: 'w' } });
    expect(s.cycles[0]).toMatchObject({ x: 8, y: 18, heading: 'w' });
  });
  test('the edge, a trail, the same cell, and a head-on swap all crash', () => {
    let s = step(place(two(), { red: { x: 0, y: 5, heading: 'w' } }));
    expect(s.cycles[0].alive).toBe(false);
    s = place(two(), { red: { x: 10, y: 10, heading: 'e' }, blue: { x: 12, y: 10, heading: 'w' } });
    s = step(s);
    expect(s.cycles.map((c) => c.alive)).toEqual([false, false]); // both wanted (11,10)
    s = place(two(), { red: { x: 10, y: 10, heading: 'e' }, blue: { x: 11, y: 10, heading: 'w' } });
    expect(step(s).cycles.map((c) => c.alive)).toEqual([false, false]); // head-on swap
    s = place(two(), { red: { x: 10, y: 10, heading: 'e' }, blue: { x: 11, y: 20, heading: 'n' } });
    s = { ...s, cells: s.cells.map((c, i) => (i === 10 * W + 11 ? 'B' : c)) };
    expect(step(s).cycles[0].alive).toBe(false); // a trail
  });
  test('a boost moves two cells a tick for 8 ticks, uses one of 3, and cannot start while running', () => {
    let s = step(two(), { red: { act: 'straight', boost: true } });
    expect(s.cycles[0]).toMatchObject({ x: 10, boosts: 2 });
    s = run(s, 7, { red: { act: 'straight', boost: true } });
    expect(s.cycles[0]).toMatchObject({ x: 24, boosts: 2, boostTicks: 0 });
    s = step(s, { red: { act: 'straight' } });
    expect(s.cycles[0].x).toBe(25);
  });
});

describe('rounds', () => {
  test('from tick 450 the arena closes a ring every 20 ticks; a cycle on the ring crashes', () => {
    let s = { ...place(two(), { red: { x: 20, y: 0, heading: 'e' }, blue: { x: 30, y: 20, heading: 'n' } }), roundTick: 449 };
    s = step(s, { red: { act: 'straight' }, blue: { act: 'straight' } });
    expect(s.roundTick).toBe(450);
    expect(at(s, 0, 0)).toBe('#');
    expect(at(s, 63, 39)).toBe('#');
    expect(s.cycles[0].alive).toBe(false);
  });
  test('the survivor takes the round, an intermission follows, then a fresh arena', () => {
    let s = step(place(two(), { red: { x: 0, y: 5, heading: 'w' } }));
    expect(s).toMatchObject({ phase: 'intermission', score: { red: 0, blue: 1 }, lastWinner: 'blue' });
    expect(rt.roundEvent!(two(), s)).toEqual({ round: 1, ended: true, winner: 'blue', score: { red: 0, blue: 1 } });
    const before = run(s, 49);
    expect(before.phase).toBe('intermission');
    s = step(before);
    expect(s).toMatchObject({ phase: 'play', round: 2, roundTick: 0 });
    expect(s.cycles.every((c) => c.alive)).toBe(true);
    expect(rt.roundEvent!(before, s)).toEqual({ round: 2, ended: false, winner: null, score: { red: 0, blue: 1 } });
  });
  test('two round wins take the match; a crash on both sides draws the round', () => {
    let s = two();
    s = { ...s, score: { red: 1, blue: 0 }, roundsPlayed: 1, round: 2 };
    s = step(place(s, { blue: { x: 0, y: 5, heading: 'w' } }));
    expect(s.phase).toBe('over');
    expect(game.outcome(s)).toEqual({ winners: ['red'], placement: [['red'], ['blue']], reason: 'rounds', score: { red: 2, blue: 0 } });
    const drawn = step(place(two(), { red: { x: 10, y: 10, heading: 'e' }, blue: { x: 12, y: 10, heading: 'w' } }));
    expect(drawn).toMatchObject({ phase: 'intermission', lastWinner: null, score: { red: 0, blue: 0 } });
  });
  test('after 3 rounds the most wins take it; all tied is a draw', () => {
    const three = game.setup({ seats: ['red', 'blue', 'green'], seed: 1 });
    const done = { ...three, phase: 'over' as const, roundsPlayed: 3, score: { red: 1, blue: 1, green: 0 }, endReason: 'rounds' };
    expect(game.outcome(done)).toEqual({ winners: ['red', 'blue'], placement: [['red', 'blue'], ['green']], reason: 'rounds', score: { red: 1, blue: 1, green: 0 } });
    expect(game.outcome({ ...done, score: { red: 1, blue: 1, green: 1 } })?.winners).toEqual([]);
  });
  test('resigning crashes you for good; the last one standing wins; the resigned place last', () => {
    const four = game.setup({ seats: ['red', 'blue', 'green', 'gold'], seed: 1 });
    let s = game.forfeit(four, 'green', 'resign');
    expect(game.isOut!(s, 'green')).toBe(true);
    expect(s.phase).toBe('play');
    s = run(s, 3);
    expect(s.cycles[2].alive).toBe(false);
    const two2 = game.forfeit(two(), 'blue', 'resign');
    expect(two2.phase).toBe('over');
    expect(game.outcome(two2)).toEqual({ winners: ['red'], placement: [['red'], ['blue']], reason: 'forfeit', score: { red: 0, blue: 0 } });
  });
  test('the same inputs give the same game', () => {
    const script = (s: LLState) => run(s, 60, { red: { act: 'turn', dir: 'left' }, blue: { act: 'straight', boost: true } });
    expect(JSON.stringify(script(two()))).toBe(JSON.stringify(script(two())));
  });
});

test('Lightline is paused between rounds only, and its steer keys make valid doctrine actions', () => {
  const rt = game.realtime!;
  const s = game.setup({ seats: ['red', 'blue'], seed: 1 });
  expect(rt.paused!(s)).toBe(false);
  expect(rt.paused!({ ...s, phase: 'intermission' })).toBe(true);
  expect(rt.steer!.action('w', ['boost'])).toEqual({ act: 'head', dir: 'w', boost: true });
  expect(rt.steer!.action(null, [])).toEqual({ act: 'straight' });
});

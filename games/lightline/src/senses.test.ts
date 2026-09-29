import { describe, expect, test } from 'bun:test';
import { H, W, lightlineGame as game, type LLState } from './index';

const senses = (s: LLState, seat: string) => game.realtime!.senses(s, seat);

describe('senses', () => {
  test('rays and open space, relative to the heading', () => {
    const s = game.setup({ seats: ['red', 'blue'], seed: 1 });
    const red = senses(s, 'red');
    expect(red).toMatchObject({ heading: 'e', left: 20, right: 19, boosts: 3, boosting: false, round: 1, round_tick: 0, enemies_alive: 1, shrinking: false });
    expect(red.ahead).toBe(40); // blue's head is 47 cells away; the ray stops at 40
    expect(red.open_ahead).toBe(600);
    expect(red.enemy_dist).toBe(47);
    expect(red.enemy_bearing).toBe('ahead');
  });
  test('a blocked neighbour has no open space; no enemies means none and 999', () => {
    let s = game.setup({ seats: ['red', 'blue'], seed: 1 });
    s = { ...s, cells: s.cells.map((c, i) => (i === 20 * W + 9 ? '#' : c)) };
    const red = senses(s, 'red');
    expect(red.ahead).toBe(0);
    expect(red.open_ahead).toBe(0);
    s = { ...s, cycles: s.cycles.map((c) => (c.seat === 'blue' ? { ...c, alive: false } : c)) };
    expect(senses(s, 'red')).toMatchObject({ enemy_dist: 999, enemy_bearing: 'none', enemies_alive: 0 });
    expect(H).toBe(40);
  });
  test('enemy bearing turns with you', () => {
    const s = game.setup({ seats: ['red', 'blue'], seed: 1 });
    const north = { ...s, cycles: s.cycles.map((c) => (c.seat === 'red' ? { ...c, heading: 'n' as const } : c)) };
    expect(senses(north, 'red').enemy_bearing).toBe('right');
  });
});

import { describe, expect, test } from 'bun:test';
import type { ShellResult, Volley } from '@cs/salvo';
import { FLIGHT_MS, MAX_TOTAL_MS, planVolley, sideOf } from './volley';

const shell = (from: string, sea: string, cell: string, more: Partial<ShellResult> = {}): ShellResult => ({
  from,
  sea,
  cell,
  result: 'miss',
  ship: null,
  blast: false,
  ...more,
});
const volley = (shells: ShellResult[], blasts: Volley['blasts'] = []): Volley => ({ round: 3, shells, blasts, sunk: [], eliminated: [] });

describe('sideOf', () => {
  test('you are always south, and the others keep their places around the table', () => {
    expect(sideOf('north', 'north')).toBe('south');
    expect(sideOf('east', 'north')).toBe('west');
    expect(sideOf('south', 'north')).toBe('north');
    expect(sideOf('west', 'north')).toBe('east');
    expect(sideOf('east', 'east')).toBe('south');
    expect(sideOf('south', 'east')).toBe('west');
    expect(sideOf('north', 'east')).toBe('east');
    expect(sideOf('west', 'west')).toBe('south');
    expect(sideOf('north', 'west')).toBe('west');
    for (const you of ['north', 'east', 'south', 'west']) expect(sideOf(you, you)).toBe('south');
  });
  test("spectators see north's view", () => {
    expect(sideOf('north', null)).toBe('south');
    expect(sideOf('south', null)).toBe('north');
    expect(sideOf('east', null)).toBe('west');
  });
});

describe('planVolley', () => {
  test("each shell starts from its attacker's side, staggered, and lands after one flight", () => {
    const plan = planVolley(
      volley([shell('north', 'east', 'e5'), shell('east', 'north', 'a1', { result: 'hit' }), shell('south', 'east', 'b2')]),
      (s) => sideOf(s, 'north'),
    );
    expect(plan.round).toBe(3);
    expect(plan.shells.map((x) => x.side)).toEqual(['south', 'west', 'north']);
    expect(plan.shells[0].delay).toBe(0);
    expect(plan.shells[1].delay).toBeGreaterThan(plan.shells[0].delay);
    expect(plan.shells[2].delay).toBeGreaterThan(plan.shells[1].delay);
    for (const x of plan.shells) {
      expect(x.flightMs).toBe(FLIGHT_MS);
      expect(x.landAt).toBe(x.delay + x.flightMs);
    }
    expect(plan.flashes).toEqual([]);
    expect(plan.total).toBeGreaterThanOrEqual(Math.max(...plan.shells.map((x) => x.landAt)));
    expect(plan.total).toBeLessThanOrEqual(MAX_TOTAL_MS);
  });

  test('a Time on Target lands together and flashes once over its nine cells', () => {
    const cells = ['e5', 'd4', 'e4', 'f4', 'd5', 'f5', 'd6', 'e6', 'f6'];
    const plan = planVolley(
      volley(
        [shell('north', 'east', 'e5', { blast: true }), shell('south', 'east', 'e5', { blast: true }), shell('west', 'north', 'h8')],
        [{ sea: 'east', cell: 'e5', by: ['north', 'south'], cells, hits: ['e4'] }],
      ),
      (s) => sideOf(s, 'north'),
    );
    const [a, b, c] = plan.shells;
    expect(a.delay).toBe(b.delay);
    expect(a.landAt).toBe(b.landAt);
    expect(c.delay).toBeGreaterThan(a.delay);
    expect(plan.flashes).toHaveLength(1);
    expect(plan.flashes[0]).toEqual({ sea: 'east', cell: 'e5', cells, at: a.landAt });
  });

  test('a sinking starts when the shell that sank it lands, or with the blast that took it', () => {
    const plan = planVolley(
      {
        round: 4,
        shells: [
          shell('north', 'east', 'e5', { blast: true }),
          shell('south', 'east', 'e5', { blast: true }),
          shell('west', 'north', 'h8', { result: 'sunk', ship: 'submarine' }),
        ],
        blasts: [{ sea: 'east', cell: 'e5', by: ['north', 'south'], cells: ['e5', 'e4'], hits: ['e4'] }],
        sunk: [
          { sea: 'east', ship: 'frigate', by: ['north', 'south'] },
          { sea: 'north', ship: 'submarine', by: ['west'] },
        ],
        eliminated: [],
      },
      (s) => sideOf(s, 'north'),
    );
    expect(plan.sinkings).toEqual([
      { sea: 'east', ship: 'frigate', at: plan.shells[0].landAt },
      { sea: 'north', ship: 'submarine', at: plan.shells[2].landAt },
    ]);
  });

  test('a crowded volley still fits in four seconds', () => {
    const shells = Array.from({ length: 16 }, (_, i) => shell(['north', 'east', 'south', 'west'][i % 4], 'east', `a${(i % 8) + 1}`));
    const plan = planVolley(volley(shells), (s) => sideOf(s, 'south'));
    expect(plan.total).toBeLessThanOrEqual(MAX_TOTAL_MS);
    expect(plan.shells.at(-1)!.landAt).toBeLessThanOrEqual(MAX_TOTAL_MS);
    for (let i = 1; i < plan.shells.length; i++) expect(plan.shells[i].delay).toBeGreaterThan(plan.shells[i - 1].delay);
  });

  test('reduced motion: everything lands at once', () => {
    const plan = planVolley(
      volley(
        [shell('north', 'east', 'e5', { blast: true }), shell('south', 'east', 'e5', { blast: true }), shell('west', 'east', 'a1')],
        [{ sea: 'east', cell: 'e5', by: ['north', 'south'], cells: ['e5'], hits: [] }],
      ),
      (s) => sideOf(s, 'north'),
      { reducedMotion: true },
    );
    for (const x of plan.shells) {
      expect(x.delay).toBe(0);
      expect(x.flightMs).toBe(0);
      expect(x.landAt).toBe(0);
    }
    expect(plan.flashes[0].at).toBe(0);
    expect(plan.total).toBe(0);
  });

  test('an empty volley plans nothing', () => {
    const plan = planVolley(volley([]), (s) => sideOf(s, 'north'));
    expect(plan.shells).toEqual([]);
    expect(plan.total).toBe(0);
  });
});

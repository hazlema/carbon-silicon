import { describe, expect, test } from 'bun:test';
import type { ShellResult, Volley } from '@cs/salvo';
import { BEAT_MS, FLIGHT_MS, IMPACT_MS, incoming, LEAD_MS, MAX_TOTAL_MS, planVolley, RETURN_MS, sideOf, TORPEDO_STEP_MS, type ItemPlan, type Side } from './volley';

const shell = (from: string, sea: string, cell: string, more: Partial<ShellResult> = {}): ShellResult => ({
  from,
  sea,
  cell,
  result: 'miss',
  ship: null,
  blast: false,
  ...more,
});
const volley = (shells: ShellResult[], blasts: Volley['blasts'] = [], buoys: Volley['buoys'] = []): Volley => ({ round: 3, shells, buoys, blasts, sunk: [], eliminated: [], tricks: [], items: [] });

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
        buoys: [],
        blasts: [{ sea: 'east', cell: 'e5', by: ['north', 'south'], cells: ['e5', 'e4'], hits: ['e4'] }],
        sunk: [
          { sea: 'east', ship: 'frigate', by: ['north', 'south'] },
          { sea: 'north', ship: 'submarine', by: ['west'] },
        ],
        eliminated: [],
        tricks: [],
        items: [],
      },
      (s) => sideOf(s, 'north'),
    );
    expect(plan.sinkings).toEqual([
      { sea: 'east', ship: 'frigate', at: plan.shells[0].landAt },
      { sea: 'north', ship: 'submarine', at: plan.shells[2].landAt },
    ]);
  });

  test('a full four-seat salvo (16 shells) still fits the cap, a readable beat apart', () => {
    const shells = Array.from({ length: 16 }, (_, i) => shell(['north', 'east', 'south', 'west'][i % 4], 'east', `a${(i % 8) + 1}`));
    const plan = planVolley(volley(shells), (s) => sideOf(s, 'south'));
    expect(plan.total).toBeLessThanOrEqual(MAX_TOTAL_MS);
    expect(plan.shells.at(-1)!.landAt).toBeLessThanOrEqual(MAX_TOTAL_MS);
    for (let i = 1; i < plan.shells.length; i++) expect(plan.shells[i].delay).toBeGreaterThan(plan.shells[i - 1].delay);
    // Not a blur: launches stay at least a fifth of a second apart.
    expect(plan.shells[1].delay - plan.shells[0].delay).toBeGreaterThanOrEqual(200);
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

  test("with you at the table: a warning first, then the shells at your sea fly last, after a beat", () => {
    const plan = planVolley(
      volley([shell('east', 'north', 'a1'), shell('south', 'west', 'b2'), shell('west', 'north', 'c3'), shell('north', 'east', 'd4')]),
      (s) => sideOf(s, 'north'),
      { you: 'north' },
    );
    expect(plan.lead).toBe(LEAD_MS);
    const [atMe1, other1, atMe2, other2] = plan.shells;
    expect(other1.delay).toBe(LEAD_MS);
    expect(other2.delay).toBeGreaterThan(other1.delay);
    expect(atMe1.delay).toBeGreaterThan(other2.delay + BEAT_MS - 1);
    expect(atMe2.delay).toBeGreaterThan(atMe1.delay);
    expect(plan.total - plan.lead - BEAT_MS).toBeLessThanOrEqual(MAX_TOTAL_MS);
  });

  test('no beat when every shell is at you, and no warning for a spectator or with reduced motion', () => {
    const v = volley([shell('east', 'north', 'a1'), shell('south', 'north', 'b2')]);
    expect(planVolley(v, (s) => sideOf(s, 'north'), { you: 'north' }).shells[0].delay).toBe(LEAD_MS);
    const watching = planVolley(v, (s) => sideOf(s, null));
    expect([watching.lead, watching.shells[0].delay]).toEqual([0, 0]);
    const still = planVolley(v, (s) => sideOf(s, 'north'), { you: 'north', reducedMotion: true });
    expect([still.lead, still.total, still.shells[1].landAt]).toEqual([0, 0, 0]);
  });
});

describe('incoming', () => {
  test('counts the shells at your sea (each Time on Target shell too) and names their senders once', () => {
    const v = volley([shell('east', 'north', 'a1'), shell('west', 'north', 'e5', { blast: true }), shell('east', 'south', 'b2'), shell('south', 'north', 'e5', { blast: true })]);
    expect(incoming(v, 'north')).toEqual({ count: 3, items: [], from: ['east', 'west', 'south'], buoys: 0 });
    expect(incoming(v, 'west')).toEqual({ count: 0, items: [], from: [], buoys: 0 });
    expect(incoming(v, null)).toEqual({ count: 0, items: [], from: [], buoys: 0 });
  });
  test('counts the sonar buoys that fell on your sea, apart from the shells', () => {
    const v = volley([shell('east', 'north', 'a1')], [], [
      { from: 'west', sea: 'north', cell: 'c3' },
      { from: 'south', sea: 'north', cell: 'f6' },
      { from: 'north', sea: 'east', cell: 'd4' },
    ]);
    expect(incoming(v, 'north')).toEqual({ count: 1, items: [], from: ['east'], buoys: 2 });
    expect(incoming(v, 'east')).toEqual({ count: 0, items: [], from: [], buoys: 1 });
    expect(incoming(v, 'west')).toEqual({ count: 0, items: [], from: [], buoys: 0 });
    expect(incoming(v, null)).toEqual({ count: 0, items: [], from: [], buoys: 0 });
  });
});

describe('planVolley: buoys', () => {
  test('each buoy splashes down on its sea once the warning is over, before any shell lands', () => {
    const v = volley([shell('east', 'north', 'a1')], [], [{ from: 'west', sea: 'east', cell: 'c3' }]);
    const plan = planVolley(v, (s) => sideOf(s, 'north'), { you: 'north' });
    expect(plan.buoys).toEqual([{ from: 'west', sea: 'east', cell: 'c3', at: LEAD_MS }]);
    expect(plan.buoys[0].at).toBeLessThan(plan.shells[0].landAt);
  });
  test('a volley of buoys alone fires no shells and still plans its splashes (at once, with reduced motion)', () => {
    const v = volley([], [], [{ from: 'west', sea: 'east', cell: 'c3' }]);
    const plan = planVolley(v, (s) => sideOf(s, 'north'), { reducedMotion: true });
    expect(plan.shells).toEqual([]);
    expect(plan.buoys).toEqual([{ from: 'west', sea: 'east', cell: 'c3', at: 0 }]);
  });
});

describe('planVolley: mines', () => {
  const boomerang = (): Volley => ({
    round: 3,
    shells: [shell('north', 'east', 'e2')],
    buoys: [],
    blasts: [],
    sunk: [],
    eliminated: [],
    tricks: [{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'e2', shooters: ['north'], result: 'boomerang', hits: [{ sea: 'north', cell: 'd1' }] }],
    items: [],
  });
  test('a mine goes off when its shell lands and comes back RETURN_MS later', () => {
    const p = planVolley(boomerang(), (s) => s as Side, {});
    const landed = p.shells[0].landAt;
    expect(p.mines).toEqual([{ ghost: 'west', sea: 'east', cell: 'e2', at: landed, result: 'boomerang', returns: [{ sea: 'north', cell: 'd1', at: landed + RETURN_MS }] }]);
    expect(p.total).toBe(landed + RETURN_MS + IMPACT_MS);
  });
  test('reduced motion: mines and returns land with everything else', () => {
    const p = planVolley(boomerang(), (s) => s as Side, { reducedMotion: true });
    expect(p.mines).toEqual([{ ghost: 'west', sea: 'east', cell: 'e2', at: 0, result: 'boomerang', returns: [{ sea: 'north', cell: 'd1', at: 0 }] }]);
    expect(p.total).toBe(0);
  });
  test('a ship a boomerang sinks goes down when the return lands', () => {
    const v = { ...boomerang(), sunk: [{ sea: 'north', ship: 'submarine' as const, by: ['west'] }] };
    const p = planVolley(v, (s) => s as Side, {});
    expect(p.sinkings).toEqual([{ sea: 'north', ship: 'submarine', at: p.mines[0].returns[0].at }]);
  });
  test('a backfire sinks its ship as the mine goes off, with no returns', () => {
    const v: Volley = {
      round: 3,
      shells: [shell('north', 'west', 'b2'), shell('north', 'east', 'c4', { result: 'hit' })],
      buoys: [],
      blasts: [],
      sunk: [{ sea: 'east', ship: 'cruiser', by: ['north'] }],
      eliminated: [],
      tricks: [{ kind: 'mine', ghost: 'south', sea: 'east', cell: 'c4', shooters: ['north'], result: 'backfire', ship: 'cruiser' }],
      items: [],
    };
    const p = planVolley(v, (s) => sideOf(s, 'north'));
    expect(p.mines).toEqual([{ ghost: 'south', sea: 'east', cell: 'c4', at: p.shells[1].landAt, result: 'backfire', returns: [] }]);
    expect(p.sinkings[0].at).toBe(p.shells[1].landAt);
  });
  test('a false splash plans no mine', () => {
    const v: Volley = { ...volley([shell('north', 'east', 'a1')]), tricks: [{ kind: 'splash', ghost: 'west', fool: 'north', sea: 'east', cell: 'b2' }] };
    expect(planVolley(v, (s) => sideOf(s, 'north')).mines).toEqual([]);
  });
});

describe('planVolley: items', () => {
  const cluster = { item: 'cluster' as const, from: 'north', sea: 'east', cell: 'c4', cells: ['c4', 'c5', 'b4', 'd4', 'c3'], hits: ['c5'] };
  const torpedo = { item: 'torpedo' as const, from: 'west', sea: 'east', lane: '3', path: ['a3', 'b3', 'c3', 'd3'], struck: 'd3' };
  const withItems = (items: Volley['items'], shells: ShellResult[] = [shell('south', 'east', 'a1')]): Volley => ({ ...volley(shells), items });
  const pick = <K extends ItemPlan['item']>(p: { items: ItemPlan[] }, k: K) => p.items.find((x) => x.item === k) as Extract<ItemPlan, { item: K }>;

  test('a cluster flies like a shell, from its own side in its own slot, and flashes its plus as it lands', () => {
    const p = planVolley(withItems([cluster]), (s) => sideOf(s, 'north'));
    const c = pick(p, 'cluster');
    expect(c.side).toBe('south');
    expect(c.delay).toBeGreaterThan(p.shells[0].delay);
    expect(c.flightMs).toBe(FLIGHT_MS);
    expect(c.landAt).toBe(c.delay + FLIGHT_MS);
    expect(c.at).toBe(c.landAt);
    expect(c.cells).toEqual(cluster.cells);
    expect(p.total).toBe(c.landAt + IMPACT_MS);
  });

  test('a torpedo sets off from its edge and runs its path a cell a step, ending where a shell sent with it lands', () => {
    const p = planVolley(withItems([torpedo]), (s) => sideOf(s, 'north'));
    const t = pick(p, 'torpedo');
    expect(t.steps).toHaveLength(4);
    for (let k = 0; k < 4; k++) expect(t.steps[k]).toBe(t.at + (k + 1) * TORPEDO_STEP_MS);
    expect(t.end).toBe(t.steps[3]);
    expect(t.at).toBeGreaterThan(p.shells[0].delay);
    // Its launch slot comes after the shell's: its run ends one stagger after that shell lands.
    expect(t.end).toBeGreaterThan(p.shells[0].landAt);
    expect(t.end - t.at).toBe(4 * TORPEDO_STEP_MS);
    expect(p.total).toBe(t.end + IMPACT_MS);
  });

  test('a torpedo that runs clean through ends off the far edge', () => {
    const lane = ['a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3'];
    const p = planVolley(withItems([{ ...torpedo, path: lane, struck: null }], []), (s) => sideOf(s, 'north'));
    const t = pick(p, 'torpedo');
    expect(t.struck).toBeNull();
    expect(t.end).toBe(t.at + lane.length * TORPEDO_STEP_MS);
  });

  test('a repair sparks as the volley opens, after the warning', () => {
    const p = planVolley(withItems([{ item: 'repair', from: 'north', cell: 'd1' }]), (s) => sideOf(s, 'north'), { you: 'north' });
    expect(pick(p, 'repair')).toEqual({ item: 'repair', from: 'north', cell: 'd1', at: LEAD_MS });
  });

  test('a laid decoy is never staged', () => {
    const p = planVolley(withItems([{ item: 'decoy-laid', from: 'east' }]), (s) => sideOf(s, 'north'));
    expect(p.items).toEqual([]);
  });

  test('a revealed decoy is stamped when the last shot on its cells lands: a shell, a cluster arm, a torpedo', () => {
    const byShell = planVolley(
      withItems([{ item: 'decoy', sea: 'east', cells: ['a1', 'a2'], by: ['south'] }], [shell('south', 'east', 'a1', { result: 'decoy' }), shell('north', 'east', 'h8')]),
      (s) => sideOf(s, 'north'),
    );
    expect(pick(byShell, 'decoy').at).toBe(byShell.shells[0].landAt);
    const byCluster = planVolley(withItems([cluster, { item: 'decoy', sea: 'east', cells: ['c5', 'c6'], by: ['north'] }]), (s) => sideOf(s, 'north'));
    expect(pick(byCluster, 'decoy').at).toBe(pick(byCluster, 'cluster').landAt);
    const byTorpedo = planVolley(withItems([torpedo, { item: 'decoy', sea: 'east', cells: ['d3', 'd4'], by: ['west'] }]), (s) => sideOf(s, 'north'));
    expect(pick(byTorpedo, 'decoy').at).toBe(pick(byTorpedo, 'torpedo').end);
  });

  test('a ship a cluster or torpedo sinks goes down when that hit lands', () => {
    const v: Volley = { ...withItems([torpedo]), sunk: [{ sea: 'east', ship: 'submarine', by: ['west'] }] };
    const p = planVolley(v, (s) => sideOf(s, 'north'));
    expect(p.sinkings).toEqual([{ sea: 'east', ship: 'submarine', at: pick(p, 'torpedo').end }]);
  });

  test('items at your sea come last, after the beat, and count as incoming', () => {
    const at = { ...cluster, from: 'east', sea: 'north' };
    const v = withItems([at], [shell('south', 'east', 'a1'), shell('west', 'south', 'b1')]);
    const p = planVolley(v, (s) => sideOf(s, 'north'), { you: 'north' });
    expect(pick(p, 'cluster').delay).toBeGreaterThan(p.shells[1].delay + BEAT_MS - 1);
    expect(incoming(v, 'north')).toEqual({ count: 0, items: ['cluster'], from: ['east'], buoys: 0 });
  });

  test('reduced motion: every item lands at once', () => {
    const v = withItems([cluster, torpedo, { item: 'repair', from: 'south', cell: 'b2' }, { item: 'decoy', sea: 'east', cells: ['d3', 'd4'], by: ['west'] }]);
    const p = planVolley(v, (s) => sideOf(s, 'north'), { reducedMotion: true, you: 'north' });
    for (const x of p.items) expect(x.at).toBe(0);
    expect(pick(p, 'torpedo').steps).toEqual([0, 0, 0, 0]);
    expect(pick(p, 'torpedo').end).toBe(0);
    expect(pick(p, 'cluster').landAt).toBe(0);
    expect(p.total).toBe(0);
  });

  test('a full salvo with items still fits the cap', () => {
    const shells = Array.from({ length: 14 }, (_, i) => shell(['north', 'east', 'south', 'west'][i % 4], 'east', `a${(i % 8) + 1}`));
    const p = planVolley(withItems([cluster, torpedo], shells), (s) => sideOf(s, 'south'));
    expect(p.total).toBeLessThanOrEqual(MAX_TOTAL_MS);
  });
});

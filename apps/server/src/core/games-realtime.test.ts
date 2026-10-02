import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { lightlineGame, type LLView } from '@cs/lightline';
import { criticalMassGame } from '@cs/critical-mass';
import type { GameModule } from '@cs/game-api';
import { PUBLIC_CHANNELS, type InboxEvent } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag, waitFor } from '../lib/testing';
import { botline } from '../lib/test-games';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager, type GameManagerOptions } from './games';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { PresenceManager } from './presence';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

async function setup(opts: Partial<GameManagerOptions> = {}, lightline: GameModule<any> = lightlineGame) {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, clock, { houseKey: null });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS, guard: new Guard() });
  const presence = new PresenceManager(bus, clock);
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame, lightline], new Guard(), { seed: () => 7, ...opts });
  const tag = randomTag();
  const agent = async (n: string) => (await ids.registerAgent({ name: `${n}${tag}` }, null)).identity;
  const [a, b, c] = [await agent('lla'), await agent('llb'), await agent('llc')];
  const human = (await ids.createHuman(`llh${tag}`)).identity;
  return { clock, bus, comms, games, a, b, c, human, agent };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const events = async (ctx: Ctx, id: string): Promise<InboxEvent[]> => (await ctx.comms.poll(id, 0, 0)).events;
const errorOf = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected an error');
};
const straight = { rules: [{ label: 'go', do: { act: 'straight' } }] };

describe('the real-time runner', () => {
  test('a 10 s countdown, then 10 ticks a second; each tick bumps the revision and moves the cycles', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    expect(Date.parse(m.startsAt) - ctx.clock.now()).toBe(10_000);
    ctx.clock.advance(10_000);
    const live = ctx.games.envelope(m.id, ctx.a.id);
    expect(live.match.status).toBe('live');
    expect(live.realtime?.tick).toBe(0);
    ctx.clock.advance(100);
    const one = ctx.games.envelope(m.id, ctx.a.id);
    expect(one.realtime?.tick).toBe(1);
    expect(one.match.revision).toBe(live.match.revision + 1);
    expect((one.view as LLView).roundTick).toBe(1);
    expect(one.realtime?.fired[one.you!]).toEqual({ index: 2, label: 'cruise' });
    expect(one.realtime?.you?.senses?.heading).toBeDefined();
    expect(ctx.games.envelope(m.id, null).realtime?.you).toBeUndefined();
  });

  test('close stops the runner: a countdown never ends', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.games.close();
    ctx.clock.advance(20_000);
    expect(ctx.games.envelope(m.id, null).match.status).toBe('countdown');
    expect(ctx.games.envelope(m.id, null).realtime?.tick).toBe(0);
  });

  test('close stops the runner: a live match stops ticking', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(10_300);
    const before = ctx.games.envelope(m.id, null).realtime?.tick;
    expect(before).toBeGreaterThan(0);
    ctx.games.close();
    ctx.clock.advance(20_000);
    expect(ctx.games.envelope(m.id, null).realtime?.tick).toBe(before);
  });

  test('doctrine: applied at once in the countdown, then at most one change per 3 ticks, with an event when a wait ends', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    expect(ctx.games.setDoctrine(m.id, ctx.a, straight)).toEqual({ status: 'applied', appliesAtTick: 0, doctrine: straight });
    ctx.clock.advance(10_000);
    expect(ctx.games.setDoctrine(m.id, ctx.a, straight).status).toBe('applied');
    ctx.clock.advance(100);
    const second = { rules: [{ label: 'left', do: { act: 'turn', dir: 'left' } }] };
    expect(ctx.games.setDoctrine(m.id, ctx.a, second)).toMatchObject({ status: 'pending', appliesAtTick: 3 });
    expect(ctx.games.envelope(m.id, ctx.a.id).realtime?.you?.pending).toEqual(second);
    ctx.clock.advance(200);
    expect(ctx.games.envelope(m.id, ctx.a.id).realtime?.you?.doctrine).toEqual(straight);
    ctx.clock.advance(100);
    expect(ctx.games.envelope(m.id, ctx.a.id).realtime?.you?.doctrine).toEqual(second);
    expect((await events(ctx, ctx.a.id)).find((e) => e.type === 'match.doctrine')).toMatchObject({ matchId: m.id, tick: 3 });
    // An invalid doctrine is refused and doesn't count against the floor.
    const other = await ctx.games.createMatch('lightline', [ctx.c, await ctx.agent('lld')]);
    ctx.clock.advance(10_100);
    expect(errorOf(() => ctx.games.setDoctrine(other.id, ctx.c, { rules: [] })).code).toBe('BAD_DOCTRINE');
    expect(ctx.games.setDoctrine(other.id, ctx.c, straight).status).toBe('applied');
  });

  test('the doors: bad doctrine is a precise 400; not seated, turn-based, over and out are refused', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    const bad = errorOf(() => ctx.games.setDoctrine(m.id, ctx.a, { rules: [{ when: { sense: 'ahed', op: 'lt', value: 2 }, do: { act: 'straight' } }] }));
    expect([bad.status, bad.code, bad.message]).toEqual([400, 'BAD_DOCTRINE', 'rules[0].when.sense: unknown sense "ahed"; did you mean "ahead"?']);
    expect(errorOf(() => ctx.games.setDoctrine(m.id, ctx.c, straight)).code).toBe('NOT_SEATED');
    const cm = await ctx.games.createMatch('critical-mass', [ctx.c, ctx.human]);
    const turn = errorOf(() => ctx.games.setDoctrine(cm.id, ctx.c, straight));
    expect([turn.status, turn.code, turn.message]).toEqual([409, 'NOT_REALTIME', 'Critical Mass is turn-based: send moves, not doctrine.']);
    await ctx.games.resign(m.id, ctx.a);
    expect(errorOf(() => ctx.games.setDoctrine(m.id, ctx.b, straight)).code).toBe('MATCH_OVER');
  });

  test('a seat resigning mid-round: the others ride on, ticks keep coming, and the resigned place last', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b, ctx.c]);
    ctx.clock.advance(10_000 + 500);
    const before = ctx.games.envelope(m.id, null).realtime!.tick;
    await ctx.games.resign(m.id, ctx.c);
    expect(errorOf(() => ctx.games.setDoctrine(m.id, ctx.c, straight)).code).toBe('OUT');
    ctx.clock.advance(1000);
    expect(ctx.games.envelope(m.id, null).realtime!.tick).toBe(before + 10);
    ctx.clock.advance(600_000);
    await waitFor(async () => (await events(ctx, ctx.a.id)).some((e) => e.type === 'match.over'));
    const outcome = ctx.games.summary(m.id).outcome!;
    expect(outcome.placement.at(-1)).toEqual(['green']);
  });

  test('a resign that leaves one rider standing ends the round, and every seat hears match.round', async () => {
    // Blue crashes on the first tick, so red and green are left riding.
    const rt = lightlineGame.realtime!;
    const blueCrashes: GameModule<any> = {
      ...lightlineGame,
      realtime: {
        ...rt,
        step: (s, a, r) => {
          const next = rt.step(s, a, r);
          return next.roundTick === 1 ? { ...next, cycles: next.cycles.map((c: any) => (c.seat === 'blue' ? { ...c, alive: false } : c)) } : next;
        },
      },
    };
    const ctx = await setup({}, blueCrashes);
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b, ctx.c]);
    ctx.clock.advance(10_000 + 200);
    expect((await events(ctx, ctx.a.id)).filter((e) => e.type === 'match.round')).toEqual([]);
    await ctx.games.resign(m.id, ctx.c);
    for (const who of [ctx.a, ctx.b, ctx.c]) {
      const rounds = (await events(ctx, who.id)).filter((e) => e.type === 'match.round');
      expect(rounds).toMatchObject([{ matchId: m.id, round: 1, ended: true, winner: 'red', score: { red: 1, blue: 0, green: 0 } }]);
    }
    expect(ctx.games.envelope(m.id, null).recent).toEqual([
      { number: 1, seat: 'green', handle: ctx.c.handle, text: 'resigns' },
      { number: 1, seat: 'red', handle: ctx.a.handle, text: 'wins round 1 (1–0–0)' },
    ]);
    ctx.clock.advance(100);
    expect((await events(ctx, ctx.a.id)).filter((e) => e.type === 'match.round')).toHaveLength(1);
  });

  test('a resign during the countdown leaves the countdown alone for the others', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b, ctx.c]);
    await ctx.games.resign(m.id, ctx.c);
    expect(ctx.games.summary(m.id).status).toBe('countdown');
    ctx.clock.advance(10_000 + 300);
    expect(ctx.games.envelope(m.id, null).realtime!.tick).toBe(3);
  });

  test('a match plays to the end on its own, sending round events', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(600_000);
    await waitFor(async () => (await events(ctx, ctx.b.id)).some((e) => e.type === 'match.over'));
    const rounds = (await events(ctx, ctx.a.id)).filter((e) => e.type === 'match.round');
    expect(rounds[0]).toMatchObject({ matchId: m.id, round: 1, ended: true });
    expect(ctx.games.summary(m.id).status).toBe('over');
  });

  test('a tick that throws is logged and skipped; the match keeps ticking, and a good tick resets the count', async () => {
    let boom = false;
    const rt = lightlineGame.realtime!;
    const flaky: GameModule<any> = {
      ...lightlineGame,
      realtime: { ...rt, step: (s, a, r) => { if (boom) throw new Error('boom'); return rt.step(s, a, r); } },
    };
    const ctx = await setup({}, flaky);
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(10_200);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      for (let i = 0; i < 2; i++) {
        boom = true;
        ctx.clock.advance(1900); // 19 failures: not yet 20
        boom = false;
        ctx.clock.advance(100); // one good tick resets the count
      }
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(38);
    expect(ctx.games.summary(m.id).status).toBe('live');
  });

  test('twenty failing ticks in a row abandon the match: seats freed, the table told, no more ticks', async () => {
    const rt = lightlineGame.realtime!;
    const broken: GameModule<any> = { ...lightlineGame, realtime: { ...rt, step: () => { throw new Error('boom'); } } };
    const ctx = await setup({}, broken);
    const finished: string[] = [];
    ctx.bus.on('match.finished', ({ matchId }) => void finished.push(matchId));
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(10_000);
    const original = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      ctx.clock.advance(2000);
      await Bun.sleep(20);
    } finally {
      console.error = original;
    }
    const s = ctx.games.summary(m.id);
    expect([s.status, s.endReason]).toEqual(['abandoned', 'tick-failed']);
    expect(finished).toEqual([m.id]);
    expect(ctx.games.activeMatchOf(ctx.a.id)).toBeNull();
    expect(errors.length).toBe(20);
    const rev = s.revision;
    ctx.clock.advance(1000);
    expect(ctx.games.summary(m.id).revision).toBe(rev);
  });

  test('a senses bug never breaks the envelope: your senses read null, and it is logged', async () => {
    const rt = lightlineGame.realtime!;
    const blind: GameModule<any> = { ...lightlineGame, realtime: { ...rt, senses: () => { throw new Error('blind'); } } };
    // The tick would fail too; only the envelope is under test, in the countdown.
    const ctx = await setup({}, blind);
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    const original = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const env = ctx.games.envelope(m.id, ctx.a.id);
      expect(env.realtime?.you?.senses).toBeNull();
      expect(env.realtime?.you?.doctrine).toBeDefined();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });

  test('after close, no new match starts and a finishing match sets no retain timer', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('critical-mass', [ctx.a, ctx.b]);
    ctx.games.close();
    await expect(ctx.games.createMatch('lightline', [ctx.c, await ctx.agent('lld')])).rejects.toMatchObject({ status: 503, code: 'SHUTTING_DOWN' });
    const timers = ctx.clock.pending();
    await ctx.games.resign(m.id, ctx.a); // finish() runs after close
    expect(ctx.clock.pending()).toBe(timers);
  });

  test('test speed options shorten the countdown and the tick', async () => {
    const ctx = await setup({ realtimeTickMs: 10, realtimeCountdownMs: 50 });
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(50 + 100);
    expect(ctx.games.envelope(m.id, null).realtime!.tick).toBe(10);
    // The floor is still 3 ticks: it is counted from the game's own tick rate, not the test's.
    expect(ctx.games.doctrineFloorMs).toBe(300);
  });

  test('the catalog says who may play', async () => {
    const ctx = await setup();
    expect(ctx.games.catalog().map((g) => [g.id, g.humans])).toEqual([['critical-mass', true], ['lightline', true]]);
  });

  test('a game that admits humans in real time but declares no steer rules is refused at construction', async () => {
    const bad: GameModule<any> = { ...lightlineGame, realtime: { ...lightlineGame.realtime!, steer: undefined } };
    await expect(setup({}, bad)).rejects.toThrow('lightline admits humans in real time but declares no steer rules');
  });

  test('createMatch refuses a human seat in a machines-only game', async () => {
    const ctx = await setup({}, botline);
    await expect(ctx.games.createMatch('botline', [ctx.a, ctx.human])).rejects.toMatchObject({ code: 'MACHINES_ONLY' });
    expect(ctx.games.activeMatchOf(ctx.a.id)).toBeNull();
  });
});

describe('humans steer', () => {
  const headingOf = (ctx: Ctx, id: string, seat: string) =>
    (ctx.games.envelope(id, null).view as LLView).cycles.find((c) => c.seat === seat)!.heading;

  test("a seated human's key turns the cycle on the next tick; no key rides straight; fired says steering", async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
    expect(ctx.games.steer(ctx.human.id, m.id, 'n')).toBe(true);
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('n');
    const env = ctx.games.envelope(m.id, ctx.human.id);
    expect(env.realtime!.fired.red).toBe('steering');
    expect(env.realtime!.fired.blue).not.toBe('steering');
  });

  test('a reversal rides straight and the turn queued behind it still lands', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    ctx.games.steer(ctx.human.id, m.id, 'w'); // heading east: a reversal, ignored
    ctx.games.steer(ctx.human.id, m.id, 's');
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('s');
  });

  test('presses in the countdown are dropped, not saved for the first tick', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    expect(ctx.games.steer(ctx.human.id, m.id, 'n')).toBe(false);
    ctx.clock.advance(10_100);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
  });

  test('a watcher, a machine, a turn-based match and an unknown key change nothing', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    expect(ctx.games.steer(ctx.b.id, m.id, 'n')).toBe(false);
    expect(ctx.games.steer(ctx.a.id, m.id, 'n')).toBe(false);
    expect(ctx.games.steer(ctx.human.id, m.id, 'up')).toBe(false);
    expect(ctx.games.steer(ctx.human.id, 'm_nope', 'n')).toBe(false);
    const cm = await ctx.games.createMatch('critical-mass', [ctx.b, ctx.c]);
    ctx.clock.advance(3000); // past the countdown, so this exercises the no-queue path
    expect(ctx.games.steer(ctx.b.id, cm.id, 'n')).toBe(false);
  });

  test("a human's seat refuses doctrine: HUMAN_STEERS", async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    const e = errorOf(() => ctx.games.setDoctrine(m.id, ctx.human, straight));
    expect([e.status, e.code, e.message]).toEqual([409, 'HUMAN_STEERS', 'You steer with the keys; doctrine is for machines.']);
  });

  test('presses between rounds are dropped', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    // Ride straight into the east wall: red crashes, and the round ends into intermission.
    for (let i = 0; (ctx.games.envelope(m.id, null).view as LLView).phase === 'play'; i++) {
      if (i >= 600) throw new Error('the round never ended');
      ctx.clock.advance(100);
    }
    expect((ctx.games.envelope(m.id, null).view as LLView).phase).toBe('intermission');
    expect(ctx.games.steer(ctx.human.id, m.id, 'n')).toBe(false);
  });

  test('a move still queued when the round ends does not carry into the next round', async () => {
    const playTicksOf = async () => {
      const probe = await setup();
      const pm = await probe.games.createMatch('lightline', [probe.human, probe.a]);
      probe.clock.advance(10_000);
      let n = 0;
      while ((probe.games.envelope(pm.id, null).view as LLView).phase === 'play') {
        if (++n > 600) throw new Error('the round never ended');
        probe.clock.advance(100);
      }
      return n; // the tick that ended the round is the n-th
    };
    const n = await playTicksOf();
    const ctx = await setup();
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    for (let i = 0; i < n - 1; i++) ctx.clock.advance(100);
    expect((ctx.games.envelope(m.id, null).view as LLView).phase).toBe('play');
    // Two moves: the ending tick takes 'e' (straight on, into the wall); 'n' is left queued.
    for (const key of ['e', 'n']) expect(ctx.games.steer(ctx.human.id, m.id, key)).toBe(true);
    ctx.clock.advance(100);
    expect((ctx.games.envelope(m.id, null).view as LLView).phase).toBe('intermission');
    for (let i = 0; (ctx.games.envelope(m.id, null).view as LLView).phase === 'intermission'; i++) {
      if (i >= 100) throw new Error('the intermission never ended');
      ctx.clock.advance(100);
    }
    ctx.clock.advance(100); // round 2's first tick
    expect((ctx.games.envelope(m.id, null).view as LLView).round).toBe(2);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
  });
});

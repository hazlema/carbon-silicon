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
  return { clock, comms, games, a, b, c, human, agent };
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
    expect(one.realtime?.you?.senses.heading).toBeDefined();
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

  test('a tick that throws is logged and skipped; the match keeps ticking', async () => {
    let boom = false;
    const rt = lightlineGame.realtime!;
    const flaky: GameModule<any> = {
      ...lightlineGame,
      realtime: {
        ...rt,
        step: (s, a, r) => {
          if (boom) throw new Error('boom');
          return rt.step(s, a, r);
        },
      },
    };
    const ctx = await setup({}, flaky);
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(10_200);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      boom = true;
      ctx.clock.advance(300);
      boom = false;
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(3);
    ctx.clock.advance(200);
    expect(ctx.games.envelope(m.id, null).realtime!.tick).toBe(4);
    expect(ctx.games.summary(m.id).status).toBe('live');
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
    expect(ctx.games.catalog().map((g) => [g.id, g.humans])).toEqual([['critical-mass', true], ['lightline', false]]);
  });

  test('createMatch refuses a human seat in a machines-only game', async () => {
    const ctx = await setup();
    await expect(ctx.games.createMatch('lightline', [ctx.a, ctx.human])).rejects.toMatchObject({ code: 'MACHINES_ONLY' });
    expect(ctx.games.activeMatchOf(ctx.a.id)).toBeNull();
  });
});

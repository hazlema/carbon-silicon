import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { criticalMassGame, type CMCommand, type CMView } from '@cs/critical-mass';
import { createRng } from '@cs/game-api';
import { PUBLIC_CHANNELS, type IdentityPublic } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import type { DB } from '../db';
import { matches, matchPlayers } from '../db/schema';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { randomTag, waitFor } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager } from './games';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { PresenceManager } from './presence';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

async function setup(gameDb: DB = database.db) {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, clock, { houseKey: null });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS, guard: new Guard() });
  const presence = new PresenceManager(bus, clock);
  const games = new GameManager(gameDb, bus, clock, comms, presence, [criticalMassGame], new Guard(), {
    countdownMs: 3000,
    seed: () => 12345,
  });
  const tag = randomTag();
  const red = (await ids.registerAgent({ name: `red${tag}` }, null)).identity;
  const blue = (await ids.createHuman(`blue${tag}`)).identity;
  const outsider = (await ids.createHuman(`out${tag}`)).identity;
  presence.agentSeen(red);
  presence.humanConnected(blue);
  return { clock, bus, ids, comms, presence, games, red, blue, outsider };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function liveMatch(ctx: Ctx): Promise<string> {
  const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
  ctx.clock.advance(3000);
  expect(ctx.games.summary(summary.id).status).toBe('live');
  return summary.id;
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

/** A view of the database whose transactions fail on demand, for "the database went away" tests. */
function flaky(db: DB) {
  const state = { failTransactions: false };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction' && state.failTransactions) return () => Promise.reject(new Error('database went away'));
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy as DB, state };
}
const matchRows = async () => (await database.db.select({ id: matches.id }).from(matches)).length;

const firstLegal = (ctx: Ctx, id: string, who: IdentityPublic) => ctx.games.envelope(id, who.id).legal[0] as CMCommand;

describe('creating a match', () => {
  test('starts in countdown, marks players as playing, and tells them', async () => {
    const ctx = await setup();
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
    expect(summary).toMatchObject({ status: 'countdown', revision: 1, gameId: 'critical-mass', toMove: [] });
    expect(summary.seats.map((s) => [s.seat, s.identity.id])).toEqual([['red', ctx.red.id], ['blue', ctx.blue.id]]);
    expect(ctx.presence.get(ctx.red.id)?.status).toBe('playing');
    expect(ctx.presence.get(ctx.blue.id)?.status).toBe('playing');
    const inbox = await ctx.comms.poll(ctx.blue.id, 0, 0);
    expect(inbox.events.map((e) => e.type)).toContain('match.started');
    const table = await ctx.comms.history(`match:${summary.id}`);
    expect(table[0].system).toBe(true);
    const [row] = await database.db.select().from(matches).where(eq(matches.id, summary.id));
    expect(row).toMatchObject({ status: 'countdown', season: '2026-09', rated: false });
    expect(ctx.games.activeMatchOf(ctx.red.id)).toBe(summary.id);
    const err = await errorOf(ctx.games.move(summary.id, ctx.red, 1, { cell: 'a1' }));
    expect([err.status, err.code]).toEqual([409, 'NOT_STARTED']);
  });
  test('a player can only be in one match; unknown games 404', async () => {
    const ctx = await setup();
    await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
    expect((await errorOf(ctx.games.createMatch('critical-mass', [ctx.red, ctx.outsider]))).code).toBe('IN_MATCH');
    expect((await errorOf(ctx.games.createMatch('chess', [ctx.outsider, ctx.blue]))).status).toBe(404);
  });
  test('a DB failure while creating a match leaves no ghost: both players freed, error rethrown', async () => {
    const ctx = await setup();
    const ghost: IdentityPublic = { ...ctx.outsider, id: newId('id') }; // no row in `identities` — the match_players FK insert fails
    const before = await matchRows();
    await expect(ctx.games.createMatch('critical-mass', [ctx.red, ghost])).rejects.toThrow();
    expect(await matchRows()).toBe(before); // the matches row went back out with the failed player insert
    expect(ctx.games.activeMatchOf(ctx.red.id)).toBeNull();
    expect(ctx.games.activeMatchOf(ghost.id)).toBeNull();
    expect(ctx.presence.get(ctx.red.id)?.status).toBe('ready');
    // the seat was never in presence, so it's fine that ghost has no entry at all
    expect(ctx.presence.get(ghost.id)).toBeNull();
    // red is free to start a fresh match
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
    expect(summary.status).toBe('countdown');
  });
});

describe('playing', () => {
  test('after the countdown red is on the clock', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const env = ctx.games.envelope(id, ctx.red.id);
    expect(env.match).toMatchObject({ status: 'live', revision: 2, toMove: ['red'] });
    expect(env.you).toBe('red');
    expect(env.legal).toHaveLength(54);
    expect(ctx.games.envelope(id, ctx.blue.id).legal).toEqual([]);
    expect(ctx.games.envelope(id, null).you).toBeNull();
    const events = (await ctx.comms.poll(ctx.red.id, 0, 0)).events;
    expect(events.find((e) => e.type === 'match.yourTurn')).toMatchObject({ matchId: id, revision: 2 });
  });
  test('moves are validated with precise errors', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const e1 = await errorOf(ctx.games.move(id, ctx.red, 1, { cell: 'a1' }));
    expect([e1.status, e1.code]).toEqual([409, 'STALE_REVISION']);
    const e2 = await errorOf(ctx.games.move(id, ctx.blue, 2, { cell: 'a1' }));
    expect([e2.status, e2.code]).toEqual([409, 'NOT_YOUR_TURN']);
    const e3 = await errorOf(ctx.games.move(id, ctx.outsider, 2, { cell: 'a1' }));
    expect([e3.status, e3.code]).toEqual([403, 'NOT_SEATED']);
    const e4 = await errorOf(ctx.games.move(id, ctx.red, 2, { cell: 'z99' }));
    expect([e4.status, e4.code]).toEqual([400, 'BAD_CELL']);
    const e5 = await errorOf(ctx.games.move('m_nope', ctx.red, 2, { cell: 'a1' }));
    expect(e5.status).toBe(404);
    const ok = await ctx.games.move(id, ctx.red, 2, { cell: 'c3' });
    expect(ok.match).toMatchObject({ revision: 3, toMove: ['blue'] });
  });
  test('two moves racing on the same revision: exactly one wins', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const results = await Promise.allSettled([
      ctx.games.move(id, ctx.red, 2, { cell: 'c3' }),
      ctx.games.move(id, ctx.red, 2, { cell: 'd4' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as AppError).code).toBe('STALE_REVISION');
  });
  test('wait resolves on change, returns at once if behind, and times out', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    await ctx.games.wait(id, 1, 25_000); // behind: immediate
    const waiting = ctx.games.wait(id, 2, 25_000);
    await ctx.games.move(id, ctx.red, 2, { cell: 'c3' });
    await waiting;
    const idle = ctx.games.wait(id, 3, 25_000);
    ctx.clock.advance(25_000);
    await idle;
  });
  test('a failed result write still ends the match for everyone', async () => {
    const f = flaky(database.db);
    const ctx = await setup(f.db);
    const id = await liveMatch(ctx);
    f.state.failTransactions = true;
    await ctx.games.resign(id, ctx.blue);
    expect(ctx.games.summary(id).status).toBe('over');
    expect(ctx.games.activeMatchOf(ctx.red.id)).toBeNull();
    const events = (await ctx.comms.poll(ctx.red.id, 0, 0)).events;
    expect(events.some((e) => e.type === 'match.over' && e.result === 'win')).toBe(true);
    expect((await ctx.comms.history(`match:${id}`)).some((m) => m.text.includes('GG'))).toBe(true);
  });
});

describe('clocks', () => {
  test('a timeout makes the autopilot play and says so at the table', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    ctx.clock.advance(90_000);
    expect(ctx.games.summary(id)).toMatchObject({ revision: 3, toMove: ['blue'] });
    await waitFor(async () => (await ctx.comms.history(`match:${id}`)).some((m) => m.text.includes('dozed off')));
  });
  test('three straight timeouts forfeit; everyone gets their status back; results are recorded', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    for (let i = 0; i < 5; i++) ctx.clock.advance(90_000); // red, blue, red, blue, red(3rd) → red forfeits
    const summary = ctx.games.summary(id);
    expect(summary.status).toBe('over');
    expect(summary.outcome).toMatchObject({ winners: ['blue'], reason: 'timeout' });
    expect(ctx.presence.get(ctx.blue.id)?.status).toBe('ready');
    expect(ctx.games.activeMatchOf(ctx.blue.id)).toBeNull();
    await waitFor(async () => {
      const rows = await database.db.select().from(matchPlayers).where(eq(matchPlayers.matchId, id));
      return rows.find((r) => r.seat === 'red')?.result === 'loss' && rows.find((r) => r.seat === 'blue')?.result === 'win';
    });
    await waitFor(async () => (await ctx.comms.poll(ctx.blue.id, 0, 0)).events.some((e) => e.type === 'match.over' && e.result === 'win'));
    const [row] = await database.db.select().from(matches).where(eq(matches.id, id));
    expect(row.status).toBe('over');
  });
});

describe('ending', () => {
  test('resigning hands the win over and frees both players', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const env = await ctx.games.resign(id, ctx.blue);
    expect(env.match.status).toBe('over');
    expect(env.match.outcome).toMatchObject({ winners: ['red'], reason: 'resign' });
    expect(ctx.presence.get(ctx.blue.id)?.status).toBe('ready');
    expect((await errorOf(ctx.games.resign(id, ctx.blue))).code).toBe('MATCH_OVER');
  });
  test('a full random game finishes and is recorded', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const rng = createRng(99);
    for (let guard = 0; guard < 2000; guard++) {
      const s = ctx.games.summary(id);
      if (s.status === 'over') break;
      const mover = s.toMove[0] === 'red' ? ctx.red : ctx.blue;
      const legal = ctx.games.envelope(id, mover.id).legal as CMCommand[];
      await ctx.games.move(id, mover, s.revision, rng.pick(legal));
    }
    const final = ctx.games.envelope(id, null);
    expect(final.match.status).toBe('over');
    expect((final.view as CMView).winner).toBe(final.match.outcome!.winners[0]);
    await waitFor(async () => {
      const [row] = await database.db.select().from(matches).where(eq(matches.id, id));
      return row.status === 'over' && row.endedAt !== null;
    });
  });
  test('a restart abandons matches that were in flight', async () => {
    const ctx = await setup();
    const id = newId('m');
    await database.db.insert(matches).values({ id, gameId: 'critical-mass', status: 'live', seed: 1, season: '2026-09' });
    expect(await ctx.games.recoverOnBoot()).toBeGreaterThanOrEqual(1);
    const [row] = await database.db.select().from(matches).where(eq(matches.id, id));
    expect(row).toMatchObject({ status: 'abandoned', endReason: 'server-restart' });
  });
});

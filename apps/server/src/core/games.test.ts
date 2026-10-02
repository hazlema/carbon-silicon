import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { criticalMassGame, type CMCommand, type CMView } from '@cs/critical-mass';
import { createRng, type GameModule } from '@cs/game-api';
import { PUBLIC_CHANNELS, tableChannel, type IdentityPublic } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import type { DB } from '../db';
import { matches, matchPlayers, messages } from '../db/schema';
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

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

async function setup(gameDb: DB = database.db, modules: GameModule<any>[] = [criticalMassGame]) {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, clock, { houseKey: null });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS, guard: new Guard() });
  const presence = new PresenceManager(bus, clock);
  const games = new GameManager(gameDb, bus, clock, comms, presence, modules, new Guard(), {
    countdownMs: 3000,
    seed: () => 12345,
  });
  const tag = randomTag();
  const red = (await ids.registerAgent({ name: `red${tag}` }, null)).identity;
  const blue = (await ids.createHuman(`blue${tag}`)).identity;
  const outsider = (await ids.createHuman(`out${tag}`)).identity;
  const green = (await ids.registerAgent({ name: `green${tag}` }, null)).identity;
  const extra = (await ids.registerAgent({ name: `xtra${tag}` }, null)).identity;
  presence.agentSeen(red);
  presence.humanConnected(blue);
  presence.agentSeen(green);
  presence.agentSeen(extra);
  return { clock, bus, ids, comms, presence, games, red, blue, outsider, green, extra };
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

/** A turn game that only counts, for the move log's own tests. */
type Tally = { n: number; turn: string; loser: string | null };
const other = (seat: string) => (seat === 'red' ? 'blue' : 'red');
const tally = (narrate?: (b: Tally, a: Tally, seat: string) => string): GameModule<Tally> => ({
  meta: { id: 'tally', name: 'Tally', tagline: 'Count.', mode: 'turn', minPlayers: 2, maxPlayers: 2, seats: ['red', 'blue'], rulesPath: 'no-rules.md', humans: true },
  setup: () => ({ n: 0, turn: 'red', loser: null }),
  view: (s) => s,
  outcome: (s) => (s.loser ? { winners: [other(s.loser)], placement: [[other(s.loser)], [s.loser]], reason: 'forfeit' } : null),
  forfeit: (s, seat) => ({ ...s, loser: seat }),
  turn: {
    turnSeconds: 90,
    toMove: (s) => (s.loser ? [] : [s.turn]),
    legal: () => [{ go: true }],
    apply: (s, seat) => ({ ...s, n: s.n + 1, turn: other(seat) }),
    describe: () => 'go',
    ...(narrate ? { narrate } : {}),
  },
});

describe('the recent-moves log', () => {
  const playTally = async (ctx: Ctx, id: string, times: number) => {
    for (let i = 0; i < times; i++) {
      const s = ctx.games.summary(id);
      const mover = s.toMove[0] === 'red' ? ctx.red : ctx.blue;
      await ctx.games.move(id, mover, s.revision, { go: true });
    }
  };
  const start = async (ctx: Ctx) => {
    const summary = await ctx.games.createMatch('tally', [ctx.red, ctx.blue]);
    ctx.clock.advance(3000);
    return summary.id;
  };

  test("each move is the game's own sentence, numbered, with the mover's handle; {seat} becomes a handle", async () => {
    const ctx = await setup(database.db, [tally((b, a, seat) => `counts to ${a.n}, past {${other(seat)}} and {nobody}`)]);
    const id = await start(ctx);
    await playTally(ctx, id, 2);
    expect(ctx.games.envelope(id, null).recent).toEqual([
      { number: 1, seat: 'red', handle: ctx.red.handle, text: `counts to 1, past ${ctx.blue.handle} and {nobody}` },
      { number: 2, seat: 'blue', handle: ctx.blue.handle, text: `counts to 2, past ${ctx.red.handle} and {nobody}` },
    ]);
  });

  test('keeps only the last 20, still numbered from the start', async () => {
    const ctx = await setup(database.db, [tally((b, a) => `counts to ${a.n}`)]);
    const id = await start(ctx);
    await playTally(ctx, id, 25);
    const recent = ctx.games.envelope(id, ctx.red.id).recent!;
    expect(recent).toHaveLength(20);
    expect(recent[0]).toMatchObject({ number: 6, text: 'counts to 6' });
    expect(recent.at(-1)).toMatchObject({ number: 25, text: 'counts to 25' });
  });

  test('without narrate, or when narrate throws, the move lands and reads "plays <describe>"', async () => {
    for (const module of [tally(), tally(() => { throw new Error('narrator down'); })]) {
      const ctx = await setup(database.db, [module]);
      const id = await start(ctx);
      await playTally(ctx, id, 1);
      expect(ctx.games.summary(id).revision).toBeGreaterThan(1);
      expect(ctx.games.envelope(id, null).recent).toEqual([{ number: 1, seat: 'red', handle: ctx.red.handle, text: 'plays go' }]);
    }
  });

  test('a module whose narrate and describe both throw still moves, by hand and by autopilot', async () => {
    const broken: GameModule<Tally> = (() => {
      const t = tally(() => { throw new Error('narrator down'); });
      return { ...t, turn: { ...t.turn!, describe: () => { throw new Error('describe down'); } } };
    })();
    const ctx = await setup(database.db, [broken]);
    const id = await start(ctx);
    await playTally(ctx, id, 1);
    expect(ctx.games.envelope(id, null).recent).toEqual([{ number: 1, seat: 'red', handle: ctx.red.handle, text: 'plays {"go":true}' }]);
    // Blue's clock runs out: the autopilot must still move, and the next turn must start.
    ctx.clock.advance(90_000);
    expect(ctx.games.summary(id).toMove).toEqual(['red']);
    expect(ctx.games.envelope(id, null).recent!.at(-1)).toMatchObject({ seat: 'blue', text: 'plays {"go":true} (autopilot)' });
  });

  test('a Critical Mass move is narrated by Critical Mass', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const s = ctx.games.summary(id);
    const mover = s.toMove[0] === 'red' ? ctx.red : ctx.blue;
    const cmd = firstLegal(ctx, id, mover);
    await ctx.games.move(id, mover, s.revision, cmd);
    expect(ctx.games.envelope(id, null).recent).toEqual([{ number: 1, seat: s.toMove[0], handle: mover.handle, text: `places at ${cmd.cell}` }]);
  });

  test('resigning is logged', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const env = await ctx.games.resign(id, ctx.blue);
    expect(env.recent!.at(-1)).toEqual({ number: 1, seat: 'blue', handle: ctx.blue.handle, text: 'resigns' });
  });
});

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
  test('close wakes a parked wait at once, and later waits return at once', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const waiting = ctx.games.wait(id, 2, 25_000);
    ctx.games.close();
    await waiting;
    await ctx.games.wait(id, 2, 25_000);
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
    expect(ctx.games.envelope(id, null).recent!.at(-1)).toMatchObject({ number: 1, seat: 'red', handle: ctx.red.handle, text: expect.stringMatching(/^places at [a-f][1-9].* \(autopilot\)$/) });
    await waitFor(async () => (await ctx.comms.history(`match:${id}`)).some((m) => m.text.includes('dozed off')));
  });
  test('three straight timeouts forfeit; everyone gets their status back; results are recorded', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    for (let i = 0; i < 5; i++) ctx.clock.advance(90_000); // red, blue, red, blue, red(3rd) → red forfeits
    const summary = ctx.games.summary(id);
    expect(summary.status).toBe('over');
    expect(summary.outcome).toMatchObject({ winners: ['blue'], reason: 'timeout' });
    expect(ctx.games.envelope(id, null).recent!.at(-1)).toMatchObject({ seat: 'red', text: 'times out and forfeits' });
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

describe('tables', () => {
  test('a match remembers its table, says so in the summary and the database, and talks at the table', async () => {
    const ctx = await setup();
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue], { tableId: 't_games1' });
    expect(summary.tableId).toBe('t_games1');
    const [row] = await database.db.select().from(matches).where(eq(matches.id, summary.id));
    expect(row.tableId).toBe('t_games1');
    expect(await ctx.games.tableIdOf(summary.id)).toBe('t_games1');
    const lines = await database.db.select().from(messages).where(eq(messages.channel, tableChannel('t_games1')));
    expect(lines.some((m) => m.system)).toBe(true);
  });
  test('tableIdOf reads finished matches from the database, and is null for unknown or tableless ones', async () => {
    const ctx = await setup();
    const plain = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
    expect(plain.tableId).toBeNull();
    expect(await ctx.games.tableIdOf(plain.id)).toBeNull();
    expect(await ctx.games.tableIdOf('m_nope')).toBeNull();
  });
  test('finishing a match announces it on the bus with its table', async () => {
    const ctx = await setup();
    const heard: { matchId: string; tableId: string | null }[] = [];
    ctx.bus.on('match.finished', (e) => heard.push(e));
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue], { tableId: 't_games2' });
    ctx.clock.advance(3000);
    await ctx.games.resign(summary.id, ctx.blue);
    expect(heard).toEqual([{ matchId: summary.id, tableId: 't_games2' }]);
  });
});

describe('three and four players', () => {
  test('a seat that is already out cannot resign again, and nothing changes', async () => {
    const ctx = await setup();
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.green, ctx.extra]);
    ctx.clock.advance(3000);
    await ctx.games.resign(summary.id, ctx.green);
    const before = ctx.games.summary(summary.id);
    expect(before.status).toBe('live');
    const err = await errorOf(ctx.games.resign(summary.id, ctx.green));
    expect([err.status, err.code]).toEqual([409, 'OUT']);
    expect(ctx.games.summary(summary.id)).toEqual(before);
  });
  test('an old match ending does not knock a player out of "playing" in their newer match', async () => {
    const ctx = await setup();
    const old = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.green, ctx.extra]);
    ctx.clock.advance(3000);
    await ctx.games.resign(old.id, ctx.green); // green is out of the old match, which plays on
    await ctx.games.createMatch('critical-mass', [ctx.green, ctx.blue]);
    expect(ctx.presence.get(ctx.green.id)?.status).toBe('playing');
    await ctx.games.resign(old.id, ctx.extra); // the old match ends: red wins
    expect(ctx.games.summary(old.id).status).toBe('over');
    expect(ctx.presence.get(ctx.green.id)?.status).toBe('playing');
  });
  test('a seat eliminated by capture is released while the match plays on', async () => {
    const ctx = await setup();
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.green, ctx.extra]); // seats red, blue, green
    ctx.clock.advance(3000);
    const play = async (who: IdentityPublic, cell: string) =>
      ctx.games.move(summary.id, who, ctx.games.summary(summary.id).revision, { cell });
    await play(ctx.red, 'a1');
    await play(ctx.green, 'b1');
    await play(ctx.extra, 'h10');
    await play(ctx.red, 'a1'); // a1 bursts into b1: the blue seat (green) has nothing left
    expect((ctx.games.envelope(summary.id, null).view as CMView).eliminated).toEqual(['blue']);
    expect(ctx.games.summary(summary.id).status).toBe('live');
    expect(ctx.games.activeMatchOf(ctx.green.id)).toBeNull();
    expect(ctx.presence.get(ctx.green.id)?.status).not.toBe('playing');
    expect(ctx.games.activeMatchOf(ctx.red.id)).toBe(summary.id);
    expect(ctx.presence.get(ctx.extra.id)?.status).toBe('playing');
  });
  test('resigning during the countdown records the match as live in the database', async () => {
    const ctx = await setup();
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.green, ctx.extra]);
    await ctx.games.resign(summary.id, ctx.extra); // still in the 3 s countdown; two players remain
    expect(ctx.games.summary(summary.id).status).toBe('live');
    await waitFor(async () => {
      const [row] = await database.db.select().from(matches).where(eq(matches.id, summary.id));
      return row.status === 'live';
    });
  });
});

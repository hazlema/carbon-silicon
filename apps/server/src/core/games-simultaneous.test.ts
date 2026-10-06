import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { GameRuleError, type GameModule, type SeatId } from '@cs/game-api';
import { PUBLIC_CHANNELS, type IdentityPublic } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag, waitFor } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager } from './games';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { PresenceManager } from './presence';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

/**
 * A test-only simultaneous game: each round every seat picks a number (twice, with `per: 2`), and
 * the round resolves when all have. Three rounds, then the highest total wins. Picking 9 sinks you:
 * out of the running, but still at the table when the game keeps its ghosts.
 */
type Picks = { seats: SeatId[]; round: number; per: number; picks: Record<SeatId, number[]>; totals: Record<SeatId, number>; sunk: SeatId[]; gone: SeatId[] };
const SEATS = ['north', 'east', 'south', 'west'];
const living = (s: Picks) => s.seats.filter((x) => !s.sunk.includes(x) && !s.gone.includes(x));
/** Resolves the round once every living seat has picked enough. Mutates `s`. */
function settle(s: Picks): Picks {
  if (living(s).every((x) => s.picks[x].length >= s.per)) {
    for (const x of s.seats) s.totals[x] += s.picks[x].reduce((a, b) => a + b, 0);
    s.picks = Object.fromEntries(s.seats.map((x) => [x, []]));
    s.round += 1;
  }
  return s;
}
const picks = (opts: { per?: number; ghosts?: boolean; summary?: boolean } = {}): GameModule<Picks> => ({
  meta: { id: 'picks', name: 'Picks', tagline: 'Pick.', mode: 'turn', minPlayers: 2, maxPlayers: 4, seats: SEATS, rulesPath: 'no-rules.md', humans: true },
  setup: ({ seats }) => ({
    seats,
    round: 1,
    per: opts.per ?? 1,
    picks: Object.fromEntries(seats.map((x) => [x, []])),
    totals: Object.fromEntries(seats.map((x) => [x, 0])),
    sunk: [],
    gone: [],
  }),
  view: (s) => ({ round: s.round, totals: s.totals }),
  outcome: (s) => {
    const alive = living(s);
    if (alive.length > 1 && s.round <= 3) return null;
    const best = [...alive].sort((a, b) => s.totals[b] - s.totals[a]);
    return { winners: best.slice(0, 1), placement: best.map((x) => [x]), reason: alive.length > 1 ? 'rounds' : 'last' };
  },
  forfeit: (s, seat) => settle({ ...structuredClone(s), gone: [...s.gone, seat] }),
  isOut: (s, seat) => s.sunk.includes(seat) || s.gone.includes(seat),
  ...(opts.ghosts ? { stillSeated: (s: Picks, seat: SeatId) => s.sunk.includes(seat) } : {}),
  turn: {
    turnSeconds: 60,
    simultaneous: true,
    round: (s) => s.round,
    toMove: (s) => living(s).filter((x) => s.picks[x].length < s.per),
    legal: () => [{ pick: 1 }, { pick: 2 }, { pick: 3 }],
    apply: (s, seat, command) => {
      const n = (command as { pick?: unknown }).pick;
      if (typeof n !== 'number') throw new GameRuleError('BAD_PICK', 'Pick a number.');
      const next = structuredClone(s);
      next.picks[seat].push(n);
      if (n === 9) next.sunk.push(seat);
      return settle(next);
    },
    describe: (c) => `pick ${(c as { pick: number }).pick}`,
    narrate: (_b, _a, _seat, c) => `secretly picks ${(c as { pick: number }).pick}`,
    ...(opts.summary === false ? {} : { roundSummary: (b: Picks, a: Picks) => [`Round ${b.round} lands: ${b.seats.map((x) => `{${x}} ${a.totals[x]}`).join(', ')}`] }),
  },
});

async function setup(module: GameModule<any> = picks()) {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, clock, { houseKey: null });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS, guard: new Guard() });
  const presence = new PresenceManager(bus, clock);
  const games = new GameManager(database.db, bus, clock, comms, presence, [module], new Guard(), { countdownMs: 3000, seed: () => 7 });
  const tag = randomTag();
  const players: IdentityPublic[] = [];
  for (const name of ['n', 'e', 's', 'w']) {
    const who = (await ids.registerAgent({ name: `${name}${tag}` }, null)).identity;
    presence.agentSeen(who);
    players.push(who);
  }
  const id = (await games.createMatch('picks', players)).id;
  clock.advance(3000);
  const [north, east, south, west] = players;
  return { clock, comms, games, presence, id, players, north: north!, east: east!, south: south!, west: west! };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const pick = (ctx: Ctx, who: IdentityPublic, n = 1, revision = ctx.games.summary(ctx.id).revision) => ctx.games.move(ctx.id, who, revision, { pick: n });
const round = (ctx: Ctx) => (ctx.games.envelope(ctx.id, null).view as { round: number }).round;
const recent = (ctx: Ctx) => ctx.games.envelope(ctx.id, null).recent!.map((r) => ({ seat: r.seat, text: r.text }));
const table = async (ctx: Ctx) => (await ctx.comms.history(`match:${ctx.id}`)).map((m) => m.text);
async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('simultaneous rounds', () => {
  test('a game that moves simultaneously without round() refuses to load', () => {
    const broken = picks();
    delete (broken.turn as { round?: unknown }).round;
    const bus = new EventBus();
    const clock = new FakeClock();
    const ids = new IdentityManager(database.db, clock, { houseKey: null });
    const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS, guard: new Guard() });
    expect(() => new GameManager(database.db, bus, clock, comms, new PresenceManager(bus, clock), [broken], new Guard())).toThrow(/round\(\)/);
  });

  test('one deadline per round: commits inside it never move it, and the next round opens a fresh one', async () => {
    const ctx = await setup();
    const opened = ctx.games.summary(ctx.id).deadline;
    expect(ctx.games.summary(ctx.id).toMove).toEqual(SEATS);
    for (const who of [ctx.north, ctx.east, ctx.south]) {
      ctx.clock.advance(10_000);
      await pick(ctx, who);
      expect(ctx.games.summary(ctx.id).deadline).toBe(opened);
    }
    expect(ctx.games.summary(ctx.id)).toMatchObject({ toMove: ['west'], secondsLeft: 30 });
    ctx.clock.advance(10_000);
    await pick(ctx, ctx.west);
    expect(round(ctx)).toBe(2);
    expect(ctx.games.summary(ctx.id)).toMatchObject({ toMove: SEATS, secondsLeft: 60 });
    // The round that ended didn't leave its timer behind: 30 s on, nobody has been autopiloted.
    ctx.clock.advance(30_000);
    expect(ctx.games.summary(ctx.id).toMove).toEqual(SEATS);
  });

  test("every seat hears match.yourTurn when a round opens, and none when another seat commits", async () => {
    const ctx = await setup();
    const turns = async (who: IdentityPublic) => (await ctx.comms.poll(who.id, 0, 0)).events.filter((e) => e.type === 'match.yourTurn').length;
    expect(await turns(ctx.west)).toBe(1);
    await pick(ctx, ctx.north);
    await pick(ctx, ctx.east);
    expect(await turns(ctx.west)).toBe(1);
    await pick(ctx, ctx.south);
    await pick(ctx, ctx.west);
    expect(await turns(ctx.west)).toBe(2);
  });

  test("any revision since the round opened is accepted; one from the round before is stale; a double-submit owes nothing", async () => {
    const ctx = await setup();
    const opening = ctx.games.summary(ctx.id).revision;
    for (const who of [ctx.north, ctx.east, ctx.south, ctx.west]) await pick(ctx, who, 2, opening);
    expect(round(ctx)).toBe(2);
    const stale = await errorOf(pick(ctx, ctx.north, 1, opening));
    expect(stale.code).toBe('STALE_REVISION');
    expect((await errorOf(pick(ctx, ctx.north, 1, ctx.games.summary(ctx.id).revision + 1))).code).toBe('STALE_REVISION');
    const now = ctx.games.summary(ctx.id).revision;
    await pick(ctx, ctx.north, 1, now);
    expect((await errorOf(pick(ctx, ctx.north, 1, now))).code).toBe('NOT_YOUR_TURN');
    // apply() still judges the command against the current state.
    expect((await errorOf(ctx.games.move(ctx.id, ctx.east, now, { pick: 'x' }))).code).toBe('BAD_PICK');
  });

  test('nothing a seat commits is told before the round lands: "is ready", then the story credited to no seat', async () => {
    const ctx = await setup();
    await pick(ctx, ctx.north, 3);
    await pick(ctx, ctx.east, 2);
    expect(recent(ctx)).toEqual([
      { seat: 'north', text: 'is ready' },
      { seat: 'east', text: 'is ready' },
    ]);
    await pick(ctx, ctx.south, 1);
    await pick(ctx, ctx.west, 1);
    const [n, e, s, w] = ctx.players.map((p) => p.handle);
    expect(recent(ctx).slice(2)).toEqual([
      { seat: 'south', text: 'is ready' },
      { seat: 'west', text: 'is ready' },
      { seat: null, text: `Round 1 lands: ${n} 3, ${e} 2, ${s} 1, ${w} 1` },
    ]);
    expect(JSON.stringify(ctx.games.envelope(ctx.id, ctx.north.id).recent)).not.toContain('secretly');
  });

  test('a seat owing two commands is "ready" once, after the second', async () => {
    const ctx = await setup(picks({ per: 2 }));
    await pick(ctx, ctx.north);
    expect(recent(ctx)).toEqual([]);
    expect(ctx.games.summary(ctx.id).toMove).toEqual(SEATS);
    await pick(ctx, ctx.north);
    expect(recent(ctx)).toEqual([{ seat: 'north', text: 'is ready' }]);
  });

  test('a timeout autopilots every seat still owing, resolves the round once, and leaves the next round alone', async () => {
    const ctx = await setup();
    await pick(ctx, ctx.north);
    await pick(ctx, ctx.east);
    const before = ctx.games.summary(ctx.id).revision;
    ctx.clock.advance(60_000);
    expect(round(ctx)).toBe(2);
    // One revision per autopiloted command.
    expect(ctx.games.summary(ctx.id)).toMatchObject({ revision: before + 2, toMove: SEATS, secondsLeft: 60 });
    expect(recent(ctx).slice(2)).toEqual([
      { seat: 'south', text: 'is ready (autopilot)' },
      { seat: 'west', text: 'is ready (autopilot)' },
      { seat: null, text: expect.stringMatching(/^Round 1 lands/) },
    ]);
    for (const who of [ctx.south, ctx.west]) {
      const events = (await ctx.comms.poll(who.id, 0, 0)).events;
      expect(events.filter((e) => e.type === 'match.autopilot')).toEqual([expect.objectContaining({ misses: 1, forfeitAt: 3, move: expect.stringMatching(/^pick \d$/) })]);
    }
    expect((await ctx.comms.poll(ctx.north.id, 0, 0)).events.some((e) => e.type === 'match.autopilot')).toBe(false);
    await waitFor(async () => (await table(ctx)).filter((t) => t.includes('dozed off')).length === 2);
    const posts = (await table(ctx)).filter((t) => t.includes('dozed off'));
    expect(posts).toEqual([`@${ctx.south.handle} dozed off — the autopilot moved for them.`, `@${ctx.west.handle} dozed off — the autopilot moved for them.`]);
    // The next round's clock runs its full length before anyone is autopiloted again.
    ctx.clock.advance(59_000);
    expect(round(ctx)).toBe(2);
    expect(ctx.games.envelope(ctx.id, ctx.south.id).clock!.endsWith(" You've missed 1 in a row.")).toBe(true);
  });

  test('a seat owing two commands that times out gets both, and the round resolves exactly once', async () => {
    const ctx = await setup(picks({ per: 2 }));
    for (const who of [ctx.north, ctx.east, ctx.south]) {
      await pick(ctx, who);
      await pick(ctx, who);
    }
    await pick(ctx, ctx.west);
    const before = ctx.games.summary(ctx.id).revision;
    ctx.clock.advance(60_000);
    expect(round(ctx)).toBe(2);
    expect(ctx.games.summary(ctx.id).revision).toBe(before + 1);
    expect(recent(ctx).filter((r) => r.seat === null)).toHaveLength(1);
    expect(recent(ctx).at(-2)).toEqual({ seat: 'west', text: 'is ready (autopilot)' });
  });

  test('three straight timeouts forfeit a seat; the others play on, and a revision from before still holds', async () => {
    const ctx = await setup();
    for (let i = 0; i < 2; i++) {
      for (const who of [ctx.north, ctx.east, ctx.south]) await pick(ctx, who);
      ctx.clock.advance(60_000);
    }
    expect(round(ctx)).toBe(3);
    const opening = ctx.games.summary(ctx.id).revision;
    for (const who of [ctx.north, ctx.east, ctx.south]) await pick(ctx, who, 1, opening);
    expect(round(ctx)).toBe(3);
    ctx.clock.advance(60_000);
    expect(recent(ctx).find((r) => r.text === 'times out and forfeits')).toEqual({ seat: 'west', text: 'times out and forfeits' });
    // west forfeiting was the last thing round 3 owed: it resolved, and three rounds end the game.
    expect(ctx.games.summary(ctx.id).status).toBe('over');
    await waitFor(async () => (await table(ctx)).some((t) => t === `@${ctx.west.handle} timed out 3 times in a row and forfeits.`));
  });

  test('a resignation that leaves nobody owing resolves the round', async () => {
    const ctx = await setup();
    for (const who of [ctx.north, ctx.east, ctx.south]) await pick(ctx, who);
    await ctx.games.resign(ctx.id, ctx.west);
    expect(round(ctx)).toBe(2);
    expect(recent(ctx).slice(-2)).toEqual([
      { seat: 'west', text: 'resigns' },
      { seat: null, text: expect.stringMatching(/^Round 1 lands/) },
    ]);
    expect(ctx.games.summary(ctx.id).toMove).toEqual(['north', 'east', 'south']);
  });

  test('without roundSummary the log just says who is ready', async () => {
    const ctx = await setup(picks({ summary: false }));
    for (const who of [ctx.north, ctx.east, ctx.south, ctx.west]) await pick(ctx, who);
    expect(recent(ctx).map((r) => r.text)).toEqual(['is ready', 'is ready', 'is ready', 'is ready']);
  });
});

describe('out but still seated', () => {
  test('an out seat the game keeps stays in the match, cannot start another, may still resign, and is freed at the end', async () => {
    const ctx = await setup(picks({ ghosts: true }));
    await pick(ctx, ctx.north, 9);
    expect(ctx.games.activeMatchOf(ctx.north.id)).toBe(ctx.id);
    expect(ctx.presence.get(ctx.north.id)?.status).toBe('playing');
    for (const who of [ctx.east, ctx.south, ctx.west]) await pick(ctx, who);
    expect(ctx.games.summary(ctx.id).toMove).toEqual(['east', 'south', 'west']);
    expect(ctx.games.activeMatchOf(ctx.north.id)).toBe(ctx.id);
    await ctx.games.resign(ctx.id, ctx.north);
    expect(ctx.games.activeMatchOf(ctx.north.id)).toBeNull();
  });

  test('without stillSeated an out seat is released at once', async () => {
    const ctx = await setup(picks());
    await pick(ctx, ctx.north, 9);
    expect(ctx.games.activeMatchOf(ctx.north.id)).toBeNull();
  });

  test('a ghost is released when the match ends', async () => {
    const ctx = await setup(picks({ ghosts: true }));
    await pick(ctx, ctx.north, 9);
    for (const who of [ctx.east, ctx.south, ctx.west]) await pick(ctx, who);
    await ctx.games.resign(ctx.id, ctx.east);
    await ctx.games.resign(ctx.id, ctx.south);
    expect(ctx.games.summary(ctx.id).status).toBe('over');
    expect(ctx.games.activeMatchOf(ctx.north.id)).toBeNull();
  });
});

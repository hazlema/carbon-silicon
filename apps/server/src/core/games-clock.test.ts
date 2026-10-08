import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { GameRuleError, type GameModule, type SeatId } from '@cs/game-api';
import { PUBLIC_CHANNELS, type IdentityPublic } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager } from './games';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { PresenceManager } from './presence';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

/**
 * A test-only simultaneous game with an alarm: every round each seat picks a number; three rounds,
 * then the highest total wins. The first `clock` after a move stamps the time and sets an alarm
 * ALARM_MS later; the first `clock` at or after it rings it. Until it rings, a seat that owes
 * nothing may still bet (`mayAct`).
 */
type Alarm = {
  seats: SeatId[];
  round: number;
  picked: SeatId[];
  totals: Record<SeatId, number>;
  stamp: number | null;
  alarm: number | null;
  rang: boolean;
  bets: Record<SeatId, number>;
};
const SEATS = ['north', 'east', 'south', 'west'];
const ALARM_MS = 5000;

/** West sits round 2 out: it owes nothing then. */
const owing = (s: Alarm) => s.seats.filter((x) => !s.picked.includes(x) && !(s.round === 2 && x === 'west'));

function alarmGame(calls: number[], opts: { hooks?: boolean } = {}): GameModule<Alarm> {
  const hooks = opts.hooks ?? true;
  return {
    meta: { id: 'alarm', name: 'Alarm', tagline: 'Ring.', mode: 'turn', minPlayers: 2, maxPlayers: 4, seats: SEATS, rulesPath: 'no-rules.md', humans: true },
    setup: ({ seats }) => ({ seats, round: 1, picked: [], totals: Object.fromEntries(seats.map((x) => [x, 0])), stamp: null, alarm: null, rang: false, bets: {} }),
    view: (s) => ({ round: s.round, stamp: s.stamp, rang: s.rang, bets: s.bets }),
    outcome: (s) => (s.round > 3 ? { winners: [s.seats[0]!], placement: s.seats.map((x) => [x]), reason: 'rounds' } : null),
    forfeit: (s) => ({ ...s, round: 4 }),
    turn: {
      turnSeconds: 60,
      simultaneous: true,
      round: (s) => s.round,
      toMove: owing,
      legal: () => [{ pick: 1 }],
      apply: (s, seat, command) => {
        const c = command as { pick?: number; bet?: number };
        const next = structuredClone(s);
        if (typeof c.bet === 'number') {
          if (s.rang) throw new GameRuleError('RUNG', 'The alarm has rung.');
          next.bets[seat] = c.bet;
          return next;
        }
        if (typeof c.pick !== 'number') throw new GameRuleError('BAD_PICK', 'Pick a number.');
        next.picked.push(seat);
        next.totals[seat]! += c.pick;
        if (owing(next).length === 0) {
          next.picked = [];
          next.round += 1;
        }
        return next;
      },
      roundSummary: (b, a) => {
        if (!b.rang && a.rang) return ['The alarm rings for {north}.'];
        if (b.round !== a.round) return [`Round ${b.round} lands.`];
        return [];
      },
      ...(hooks
        ? {
            clock: (s: Alarm, now: number) => {
              calls.push(now);
              if (s.stamp === null) return { ...s, stamp: now, alarm: now + ALARM_MS };
              if (!s.rang && s.alarm !== null && now >= s.alarm) return { ...s, rang: true };
              return s;
            },
            wakeAt: (s: Alarm) => (s.alarm !== null && !s.rang ? s.alarm : null),
            mayAct: (s: Alarm, seat: SeatId) => !s.rang && s.seats.includes(seat),
          }
        : {}),
    },
  };
}

async function setup(module: GameModule<any>) {
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
  const id = (await games.createMatch(module.meta.id, players)).id;
  clock.advance(3000);
  const [north, east, south, west] = players;
  return { clock, games, id, north: north!, east: east!, south: south!, west: west! };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const rev = (ctx: Ctx) => ctx.games.summary(ctx.id).revision;
const send = (ctx: Ctx, who: IdentityPublic, command: unknown) => ctx.games.move(ctx.id, who, rev(ctx), command);
const view = (ctx: Ctx) => ctx.games.envelope(ctx.id, null).view as { round: number; stamp: number | null; rang: boolean; bets: Record<SeatId, number> };
const recent = (ctx: Ctx) => ctx.games.envelope(ctx.id, null).recent!.map((r) => ({ seat: r.seat, text: r.text }));
/** Lets the async wake-up handler (fired synchronously by the fake clock) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));
async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('wake-ups (clock / wakeAt)', () => {
  test('clock is called with the current time after a move, and its state is installed', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    expect(calls).toEqual([]);
    ctx.clock.advance(1234);
    const before = rev(ctx);
    await send(ctx, ctx.north, { pick: 1 });
    expect(calls).toEqual([ctx.clock.now()]);
    expect(view(ctx).stamp).toBe(ctx.clock.now());
    // The move and the clock's change are each a revision.
    expect(rev(ctx)).toBe(before + 2);
  });

  test('a wake-up at wakeAt calls clock, advances the revision and tells its story lines', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    await send(ctx, ctx.north, { pick: 1 });
    const stamped = ctx.clock.now();
    const before = rev(ctx);
    ctx.clock.advance(ALARM_MS - 1);
    await settle();
    expect(view(ctx).rang).toBe(false);
    expect(calls).toEqual([stamped]);
    ctx.clock.advance(1);
    await settle();
    expect(calls).toEqual([stamped, stamped + ALARM_MS]);
    expect(view(ctx).rang).toBe(true);
    expect(rev(ctx)).toBe(before + 1);
    expect(recent(ctx).at(-1)).toEqual({ seat: null, text: expect.stringMatching(/^The alarm rings for n/) });
    // Nothing more is due: no further wake-ups.
    ctx.clock.advance(60_000 - ALARM_MS - 1);
    await settle();
    expect(calls).toHaveLength(2);
  });

  test('a move that lands first reschedules the wake-up rather than doubling it', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    await send(ctx, ctx.north, { pick: 1 });
    ctx.clock.advance(1000);
    await send(ctx, ctx.east, { pick: 1 });
    ctx.clock.advance(1000);
    await send(ctx, ctx.south, { pick: 1 });
    expect(calls).toHaveLength(3);
    ctx.clock.advance(ALARM_MS);
    await settle();
    // One wake-up, not one per move.
    expect(calls).toHaveLength(4);
    expect(view(ctx).rang).toBe(true);
  });

  test('a match that ends clears its wake-up: past the alarm, nothing happens', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    const bySeat: Record<string, IdentityPublic> = { north: ctx.north, east: ctx.east, south: ctx.south, west: ctx.west };
    while (ctx.games.summary(ctx.id).status === 'live') await send(ctx, bySeat[ctx.games.summary(ctx.id).toMove[0]!]!, { pick: 1 });
    expect(ctx.games.summary(ctx.id).status).toBe('over');
    const n = calls.length;
    const done = rev(ctx);
    ctx.clock.advance(ALARM_MS * 2);
    await settle();
    expect(calls).toHaveLength(n);
    expect(rev(ctx)).toBe(done);
    expect(view(ctx).rang).toBe(false);
  });

  test('a match that ends by resignation clears its wake-up too', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    await send(ctx, ctx.north, { pick: 1 });
    await ctx.games.resign(ctx.id, ctx.east);
    expect(ctx.games.summary(ctx.id).status).toBe('over');
    const n = calls.length;
    ctx.clock.advance(ALARM_MS * 2);
    await settle();
    expect(calls).toHaveLength(n);
  });

  test('close() clears a pending wake-up', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    await send(ctx, ctx.north, { pick: 1 });
    ctx.games.close();
    ctx.clock.advance(ALARM_MS * 2);
    await settle();
    expect(calls).toHaveLength(1);
  });

  test('without the hooks nothing is scheduled and a move is one revision', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls, { hooks: false }));
    const before = rev(ctx);
    await send(ctx, ctx.north, { pick: 1 });
    expect(rev(ctx)).toBe(before + 1);
    expect(calls).toEqual([]);
    expect((await errorOf(send(ctx, ctx.north, { bet: 3 }))).code).toBe('NOT_YOUR_TURN');
  });
});

describe('optional moves (mayAct)', () => {
  test('a seat that owes nothing may still act: toMove, misses and the deadline are untouched', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    await send(ctx, ctx.north, { pick: 1 });
    const deadline = ctx.games.summary(ctx.id).deadline;
    ctx.clock.advance(1000);
    await send(ctx, ctx.north, { bet: 3 });
    expect(view(ctx).bets).toEqual({ north: 3 });
    expect(ctx.games.summary(ctx.id).toMove).toEqual(['east', 'south', 'west']);
    expect(ctx.games.summary(ctx.id).deadline).toBe(deadline);
    // The optional move isn't narrated: north was "ready" once.
    expect(recent(ctx).filter((r) => r.text.includes('is ready'))).toHaveLength(1);
  });

  test("an optional move doesn't reset the seat's run of misses", async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    // Round 1 times out: everyone dozes once.
    ctx.clock.advance(60_000);
    await settle();
    expect(view(ctx).round).toBe(2);
    // The autopilot's moves are moves too: the clock heard the time of the timeout.
    expect(view(ctx).stamp).toBe(ctx.clock.now());
    // West sits round 2 out, owing nothing, and bets.
    expect(ctx.games.summary(ctx.id).toMove).toEqual(['north', 'east', 'south']);
    await send(ctx, ctx.west, { bet: 2 });
    expect(view(ctx).bets).toEqual({ west: 2 });
    for (const who of [ctx.north, ctx.east, ctx.south]) await send(ctx, who, { pick: 1 });
    expect(view(ctx).round).toBe(3);
    // The bet didn't count as a move owed: west still has its miss; north's owed pick cleared its own.
    expect(ctx.games.envelope(ctx.id, ctx.west.id).clock).toContain("You've missed 1 in a row.");
    expect(ctx.games.envelope(ctx.id, ctx.north.id).clock).not.toContain('missed');
  });

  test('a seat that owes nothing and may not act is refused NOT_YOUR_TURN', async () => {
    const calls: number[] = [];
    const ctx = await setup(alarmGame(calls));
    await send(ctx, ctx.north, { pick: 1 });
    ctx.clock.advance(ALARM_MS);
    await settle();
    expect(view(ctx).rang).toBe(true);
    expect((await errorOf(send(ctx, ctx.north, { bet: 3 }))).code).toBe('NOT_YOUR_TURN');
  });
});

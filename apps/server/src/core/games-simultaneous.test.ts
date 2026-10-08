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
import { salvoGame } from '@cs/salvo';

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
  const id = (await games.createMatch(module.meta.id, players)).id;
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

describe('Salvo on the engine', () => {
  const salvo = async () => {
    const ctx = await setup(salvoGame);
    return ctx;
  };
  const SECONDS = salvoGame.turn.turnSeconds * 1000;

  test('one missed deadline in deployment puts every absent fleet down and opens round 1', async () => {
    const ctx = await salvo();
    const [first] = ctx.games.envelope(ctx.id, ctx.north.id).legal as unknown[];
    expect(first).toBeDefined();
    await ctx.games.move(ctx.id, ctx.north, ctx.games.summary(ctx.id).revision, { place: 'random' });
    ctx.clock.advance(SECONDS);
    const view = ctx.games.envelope(ctx.id, null).view as { phase: string; round: number };
    expect(view).toMatchObject({ phase: 'fire', round: 1 });
    expect(ctx.games.summary(ctx.id)).toMatchObject({ toMove: SEATS, secondsLeft: SECONDS / 1000 });
    expect(recent(ctx).at(-1)).toEqual({ seat: null, text: 'All fleets are down. Round 1 begins.' });
    for (const who of [ctx.east, ctx.south, ctx.west]) {
      const misses = (await ctx.comms.poll(who.id, 0, 0)).events.filter((e) => e.type === 'match.autopilot');
      expect(misses).toEqual([expect.objectContaining({ misses: 1 })]);
    }
  });

  test('random play to the end: every seat fires on the round\'s opening revision, and nothing aimed is told before it lands', async () => {
    const ctx = await salvo();
    const bySeat = new Map(SEATS.map((s, i) => [s, ctx.players[i]!]));
    const cell = /\b[a-h][1-8]\b/;
    let guard = 0;
    while (ctx.games.summary(ctx.id).status === 'live' && guard++ < 500) {
      const opening = ctx.games.summary(ctx.id).revision;
      const round = (ctx.games.envelope(ctx.id, null).view as { round: number }).round;
      for (const seat of ctx.games.summary(ctx.id).toMove) {
        const who = bySeat.get(seat)!;
        const legal = ctx.games.envelope(ctx.id, who.id).legal as { fire?: string }[];
        const command = legal.find((c) => (c as { place?: string }).place === 'random') ?? legal[guard % legal.length]!;
        await ctx.games.move(ctx.id, who, opening, command);
        // Mid-round, everything credited to a seat is "is ready"; a cell may only appear in seatless story lines.
        if ((ctx.games.envelope(ctx.id, null).view as { round: number }).round === round) {
          for (const r of ctx.games.envelope(ctx.id, null).recent!) if (r.seat) expect(r.text).not.toMatch(cell);
        }
      }
    }
    expect(ctx.games.summary(ctx.id).status).toBe('over');
    expect(ctx.games.summary(ctx.id).outcome!.winners).toHaveLength(1);
    expect(recent(ctx).some((r) => r.seat === null && r.text.includes('takes it'))).toBe(true);
  });

  type SalvoView = { round: number; ghosts: string[]; mySea: { ships: { cells: string[] }[] } | null };
  const view = (ctx: Ctx, who: IdentityPublic | null = null) => ctx.games.envelope(ctx.id, who?.id ?? null).view as SalvoView;
  const fire = async (ctx: Ctx, who: IdentityPublic, at: string, cells: string[]) => {
    for (const cell of cells) await ctx.games.move(ctx.id, who, ctx.games.summary(ctx.id).revision, { fire: 'shell', at, cell });
  };
  /** Every fleet deploys; west's ship cells, and twelve cells of open water on west's sea. */
  const deployed = async (ctx: Ctx) => {
    for (const who of [ctx.north, ctx.east, ctx.south, ctx.west]) await ctx.games.move(ctx.id, who, ctx.games.summary(ctx.id).revision, { place: 'random' });
    const ships = view(ctx, ctx.west).mySea!.ships.flatMap((x) => x.cells);
    const water = Array.from({ length: 64 }, (_, i) => `${'abcdefgh'[i % 8]}${Math.floor(i / 8) + 1}`).filter((c) => !ships.includes(c));
    expect(ships).toHaveLength(12);
    return { ships, water: water.slice(0, 12) };
  };
  /** north, east and south each fire their four shells at west's sea, on these twelve cells. */
  const atWest = async (ctx: Ctx, cells: string[]) => {
    await fire(ctx, ctx.north, 'west', cells.slice(0, 4));
    await fire(ctx, ctx.east, 'west', cells.slice(4, 8));
    await fire(ctx, ctx.south, 'west', cells.slice(8, 12));
  };
  /** north, east and south fire every shell they owe at the next of the three of them. */
  const skirmish = async (ctx: Ctx) => {
    for (const [who, at] of [[ctx.north, 'east'], [ctx.east, 'south'], [ctx.south, 'north']] as const) {
      while (ctx.games.summary(ctx.id).toMove.includes(ctx.games.envelope(ctx.id, who.id).you!)) {
        const legal = ctx.games.envelope(ctx.id, who.id).legal as { fire?: string; at?: string; crate?: string }[];
        // A crate from sinking west's fleet is owed too: passed once the shells are in.
        const next = legal.find((c) => c.fire === 'shell' && c.at === at) ?? legal.find((c) => c.crate === 'pass');
        await ctx.games.move(ctx.id, who, ctx.games.summary(ctx.id).revision, next!);
      }
    }
  };

  test("a ghost that idles is autopiloted with a trick, its misses counted afresh from its sinking, and fades after three; placement unchanged", async () => {
    const ctx = await salvo();
    const { ships, water } = await deployed(ctx);
    // Rounds 1 and 2 west sleeps through afloat: two misses. Round 2's volley sinks it.
    await atWest(ctx, water);
    ctx.clock.advance(SECONDS);
    await atWest(ctx, ships);
    ctx.clock.advance(SECONDS);
    expect(view(ctx)).toMatchObject({ round: 3, ghosts: ['west'] });
    // Becoming a ghost wiped the slate: the next three rounds it owes a trick, and only the third miss fades it.
    for (const misses of [1, 2]) {
      expect(ctx.games.summary(ctx.id).toMove).toContain('west');
      await skirmish(ctx);
      expect(ctx.games.summary(ctx.id).toMove).toEqual(['west']);
      ctx.clock.advance(SECONDS);
      const auto = (await ctx.comms.poll(ctx.west.id, 0, 0)).events.filter((e) => e.type === 'match.autopilot');
      expect(auto.at(-1)).toMatchObject({ move: 'plays a dirty trick', misses });
      expect(ctx.games.activeMatchOf(ctx.west.id)).toBe(ctx.id);
      expect(view(ctx).ghosts).toEqual(['west']);
    }
    await skirmish(ctx);
    ctx.clock.advance(SECONDS);
    expect(recent(ctx)).toContainEqual({ seat: 'west', text: 'fades away' });
    expect(recent(ctx).some((r) => r.text === 'times out and forfeits')).toBe(false);
    expect(view(ctx).ghosts).toEqual([]);
    expect(ctx.games.summary(ctx.id).status).toBe('live');
    expect(ctx.games.activeMatchOf(ctx.west.id)).toBeNull();
    await waitFor(async () => (await table(ctx)).includes(`@${ctx.west.handle}'s ghost fades away.`));
    expect((await table(ctx)).some((t) => t.includes(`@${ctx.west.handle} timed out`))).toBe(false);
    // Its placement stands: sunk in round 2, it still finishes last.
    await ctx.games.resign(ctx.id, ctx.east);
    await ctx.games.resign(ctx.id, ctx.south);
    expect(ctx.games.summary(ctx.id).outcome!.placement).toEqual([['north'], ['east', 'south'], ['west']]);
  });

  test('a ghost that resigns stops haunting: released at once, the table told so', async () => {
    const ctx = await salvo();
    const { ships } = await deployed(ctx);
    await atWest(ctx, ships);
    while (ctx.games.summary(ctx.id).toMove.includes('west')) {
      await ctx.games.move(ctx.id, ctx.west, ctx.games.summary(ctx.id).revision, (ctx.games.envelope(ctx.id, ctx.west.id).legal as unknown[])[0]);
    }
    expect(view(ctx).ghosts).toEqual(['west']);
    expect(ctx.games.activeMatchOf(ctx.west.id)).toBe(ctx.id);
    await ctx.games.resign(ctx.id, ctx.west);
    expect(ctx.games.activeMatchOf(ctx.west.id)).toBeNull();
    expect(view(ctx).ghosts).toEqual([]);
    expect(recent(ctx)).toContainEqual({ seat: 'west', text: 'stops haunting' });
    expect(recent(ctx).some((r) => r.seat === 'west' && r.text === 'resigns')).toBe(false);
    await waitFor(async () => (await table(ctx)).includes(`@${ctx.west.handle} stops haunting.`));
    expect(ctx.games.summary(ctx.id).status).toBe('live');
  });
});

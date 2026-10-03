import { testDatabaseUrl } from '@cs/server/testing';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'bun:test';
import type { IdentityPublic } from '@cs/shared/protocol';
import { openDatabase, type DB } from '../db';
import { matches, matchPlayers, seasonClosings } from '../db/schema';
import { FakeClock } from '../lib/clock';
import { newId } from '../lib/ids';
import { randomTag } from '../lib/testing';
import { AccountManager } from './accounts';
import { EventBus } from './bus';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { LeaderboardManager } from './leaderboard';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

const GAMES = [
  { id: 'critical-mass', name: 'Critical Mass' },
  { id: 'checkers', name: 'Crown & Steel' },
  { id: 'lightline', name: 'Lightline' },
];
function board(db: DB = database.db, clock = new FakeClock()) {
  const bus = new EventBus();
  return { bus, clock, lb: new LeaderboardManager(db, { clock, bus, games: () => GAMES }) };
}

let tick = 0;
/** A finished match from a best-first placement of identities (one group = a draw). */
async function play(
  db: DB,
  season: string,
  gameId: string,
  placement: IdentityPublic[][],
  opts: { rated?: boolean; status?: 'over' | 'abandoned' | 'live'; outcome?: unknown } = {},
): Promise<string> {
  const id = newId('m');
  const seatOf = new Map(placement.flat().map((p, i) => [p.id, `s${i}`]));
  const groups = placement.map((g) => g.map((p) => seatOf.get(p.id)!));
  const outcome = opts.outcome !== undefined ? opts.outcome : { winners: groups.length > 1 ? groups[0] : [], placement: groups, reason: 'test' };
  await db.insert(matches).values({
    id,
    gameId,
    status: opts.status ?? 'over',
    seed: 1,
    season,
    rated: opts.rated ?? true,
    outcome,
    endedAt: new Date(Date.UTC(2030, 0, 1) + ++tick * 1000),
  });
  await db.insert(matchPlayers).values(placement.flat().map((p) => ({ matchId: id, seat: seatOf.get(p.id)!, identityId: p.id, kind: p.kind })));
  return id;
}
async function agents(db: DB, n: number): Promise<IdentityPublic[]> {
  const ids = new IdentityManager(db, new FakeClock(), { houseKey: null });
  const out: IdentityPublic[] = [];
  for (let i = 0; i < n; i++) out.push((await ids.registerAgent({ name: `lb${randomTag()}` }, null)).identity);
  return out;
}

describe('tally', () => {
  test('counts finished human-vs-agent matches in the season only', async () => {
    const ids = new IdentityManager(database.db, new FakeClock(), { houseKey: null });
    const h = (await ids.createHuman('Carbonara')).identity;
    const a = (await ids.registerAgent({ name: 'Siliconda' }, null)).identity;
    const a2 = (await ids.registerAgent({ name: 'Siliconte' }, null)).identity;
    type R = 'win' | 'loss' | 'draw' | 'abandoned';
    async function match(season: string, status: 'over' | 'abandoned', players: [typeof h, R][]) {
      const id = newId('m');
      await database.db.insert(matches).values({ id, gameId: 'critical-mass', status, seed: 1, season });
      await database.db.insert(matchPlayers).values(
        players.map(([p, result], i) => ({ matchId: id, seat: `s${i}`, identityId: p.id, kind: p.kind, result })),
      );
    }
    await match('2030-01', 'over', [[h, 'win'], [a, 'loss']]); // carbon
    await match('2030-01', 'over', [[h, 'loss'], [a, 'win']]); // silicon
    await match('2030-01', 'over', [[h, 'draw'], [a, 'draw']]); // draw
    await match('2030-01', 'over', [[a, 'win'], [a2, 'loss']]); // machine vs machine: ignored
    await match('2030-01', 'abandoned', [[h, 'abandoned'], [a, 'abandoned']]); // ignored
    await match('2030-02', 'over', [[h, 'win'], [a, 'loss']]); // other season
    const lb = board().lb;
    expect(await lb.tally('2030-01')).toEqual({ season: '2030-01', carbon: 1, silicon: 1, draws: 1 });
    expect(await lb.tally('2029-12')).toEqual({ season: '2029-12', carbon: 0, silicon: 0, draws: 0 });
  });
});

describe('standings', () => {
  test('rated, finished matches of one season and game only, best first', async () => {
    const [a, b] = await agents(database.db, 2);
    await play(database.db, '2031-01', 'critical-mass', [[a], [b]]);
    await play(database.db, '2031-01', 'critical-mass', [[b], [a]], { rated: false });
    await play(database.db, '2031-01', 'critical-mass', [[b], [a]], { status: 'abandoned' });
    await play(database.db, '2031-01', 'checkers', [[b], [a]]);
    await play(database.db, '2031-02', 'critical-mass', [[b], [a]]);
    const rows = await board().lb.standings('2031-01', 'critical-mass');
    expect(rows.map((r) => ({ rank: r.rank, id: r.identity.id, points: r.points, w: r.wins, l: r.losses, games: r.games, elo: r.elo }))).toEqual([
      { rank: 1, id: a.id, points: 3, w: 1, l: 0, games: 1, elo: 1016 },
      { rank: 2, id: b.id, points: 0, w: 0, l: 1, games: 1, elo: 984 },
    ]);
  });
  test('a match without a placement is skipped; the rest still count', async () => {
    const [a, b] = await agents(database.db, 2);
    await play(database.db, '2031-03', 'critical-mass', [[a], [b]], { outcome: { winners: ['s0'] } });
    await play(database.db, '2031-03', 'critical-mass', [[b], [a]]);
    const rows = await board().lb.standings('2031-03', 'critical-mass');
    expect(rows.map((r) => [r.identity.id, r.games])).toEqual([[b.id, 1], [a.id, 1]]);
  });
  test('a season with no matches is an empty board', async () => {
    expect(await board().lb.standings('2099-01', 'critical-mass')).toEqual([]);
  });
  test('an open season is recalculated after a match ends; a closed season is kept', async () => {
    const [a, b] = await agents(database.db, 2);
    await database.db.insert(seasonClosings).values({ season: '2032-05' });
    await play(database.db, '2032-05', 'critical-mass', [[a], [b]]);
    await play(database.db, '2032-06', 'critical-mass', [[a], [b]]);
    const { lb, bus } = board();
    expect((await lb.standings('2032-05', 'critical-mass'))[0].games).toBe(1);
    expect((await lb.standings('2032-06', 'critical-mass'))[0].games).toBe(1);
    await play(database.db, '2032-05', 'critical-mass', [[a], [b]]);
    await play(database.db, '2032-06', 'critical-mass', [[a], [b]]);
    expect((await lb.standings('2032-06', 'critical-mass'))[0].games).toBe(1); // cached until a match ends
    bus.emit('match.finished', { matchId: 'm_x', tableId: null });
    expect((await lb.standings('2032-06', 'critical-mass'))[0].games).toBe(2);
    expect((await lb.standings('2032-05', 'critical-mass'))[0].games).toBe(1);
  });
});

describe('seasons and the hall of fame', () => {
  test('seasons: every season with matches plus the current one, newest first, with closed flags', async () => {
    const [a, b] = await agents(database.db, 2);
    await database.db.insert(seasonClosings).values({ season: '2033-01' }).onConflictDoNothing();
    await play(database.db, '2033-01', 'checkers', [[b], [a]]);
    const list = await board().lb.seasons();
    expect(list).toContainEqual({ season: '2033-01', closed: true });
    expect(list).toContainEqual({ season: '2026-09', closed: false }); // FakeClock's month
    expect(list.map((s) => s.season)).toEqual([...list.map((s) => s.season)].sort().reverse());
  });
  test('the hall of fame: each closed season’s first place per game, newest season first, catalog order', async () => {
    const [a, b] = await agents(database.db, 2);
    await database.db.insert(seasonClosings).values({ season: '2034-01' });
    await database.db.insert(seasonClosings).values({ season: '2034-02' });
    await play(database.db, '2034-01', 'checkers', [[a], [b]]);
    await play(database.db, '2034-01', 'critical-mass', [[b], [a]]);
    await play(database.db, '2034-02', 'critical-mass', [[a], [b]]);
    await play(database.db, '2034-03', 'critical-mass', [[b], [a]]); // open: not in the hall
    const hall = (await board().lb.hallOfFame()).filter((c) => c.season.startsWith('2034'));
    expect(hall.map((c) => [c.season, c.gameId, c.row.identity.id])).toEqual([
      ['2034-02', 'critical-mass', a.id],
      ['2034-01', 'critical-mass', b.id],
      ['2034-01', 'checkers', a.id],
    ]);
  });
});

describe('glory', () => {
  test('ranked, this season, matches played and titles', async () => {
    const [x, y] = await agents(database.db, 2);
    await play(database.db, '2026-09', 'critical-mass', [[x], [y]]);
    await play(database.db, '2026-09', 'checkers', [[y], [x]], { rated: false });
    await database.db.insert(seasonClosings).values({ season: '2035-01' });
    await play(database.db, '2035-01', 'lightline', [[x], [y]]);
    const g = await board().lb.glory(x.id);
    expect(g.ranked).toBe(true);
    expect(g.season.map((s) => [s.gameId, s.row.rank, s.row.points])).toEqual([['critical-mass', 1, 3]]);
    expect(g.matchesPlayed).toBe(3);
    expect(g.titles).toEqual([{ season: '2035-01', gameId: 'lightline' }]);
  });
  test('a guest and a human in their first week are not ranked', async () => {
    const clock = new FakeClock();
    const ids = new IdentityManager(database.db, clock, { houseKey: null });
    const accounts = new AccountManager(database.db, clock, ids, new Guard());
    const guest = (await ids.createHuman(`lg${randomTag()}`)).identity;
    const fresh = (await accounts.lock((await ids.createHuman(`lh${randomTag()}`)).identity, 'correct horse battery')).identity;
    const { lb } = board(database.db, clock);
    expect(await lb.glory(guest.id)).toMatchObject({ ranked: false, season: [], matchesPlayed: 0, titles: [] });
    const g = await lb.glory(fresh.id);
    expect(g.ranked).toBe(false);
    expect(Date.parse(g.rankedAt!)).toBe(clock.now() + 7 * 86_400_000);
  });
});

describe('closing a season', () => {
  const posted: string[] = [];
  const announcer = { postSystem: async (channel: string, text: string) => void posted.push(`${channel}|${text}`) };

  test('waits for a live match, announces once, and a second server never announces it again', async () => {
    const own = await openDatabase(await testDatabaseUrl());
    try {
      posted.length = 0;
      const clock = new FakeClock(Date.UTC(2026, 9, 1, 0, 5)); // 2026-10-01
      const [a, b, c] = await agents(own.db, 3);
      await play(own.db, '2026-09', 'critical-mass', [[a], [b]]);
      await play(own.db, '2026-09', 'checkers', [[c], [a]]);
      await play(own.db, '2026-09', 'lightline', [[a], [b]], { rated: false });
      const live = await play(own.db, '2026-09', 'critical-mass', [[b], [c]], { status: 'live' });
      const one = board(own.db, clock).lb;
      expect(await one.closeSeasons(announcer)).toEqual([]);
      await own.db.update(matches).set({ status: 'abandoned' }).where(eq(matches.id, live));
      expect(await one.closeSeasons(announcer)).toEqual(['2026-09']);
      expect(posted).toEqual([
        `lobby|September is in the books. Champions: Critical Mass — @${a.handle} · Crown & Steel — @${c.handle}. October is open; every rating is back to 1000.`,
      ]);
      const two = board(own.db, clock).lb;
      expect(await two.closeSeasons(announcer)).toEqual([]);
      expect(await one.closeSeasons(announcer)).toEqual([]);
      expect(posted).toHaveLength(1);
      expect(await two.seasons()).toContainEqual({ season: '2026-09', closed: true });
    } finally {
      await own.close();
    }
  });

  test('a month with no ranked games says so; the current month never closes', async () => {
    const own = await openDatabase(await testDatabaseUrl());
    try {
      posted.length = 0;
      const clock = new FakeClock(Date.UTC(2026, 9, 15));
      const [a, b] = await agents(own.db, 2);
      await play(own.db, '2026-08', 'critical-mass', [[a], [b]], { rated: false });
      await play(own.db, '2026-10', 'critical-mass', [[a], [b]]);
      expect(await board(own.db, clock).lb.closeSeasons(announcer)).toEqual(['2026-08']);
      expect(posted).toEqual(['lobby|August is in the books. No ranked games were played. October is open; every rating is back to 1000.']);
    } finally {
      await own.close();
    }
  });

  test('an announcement that fails is retried by the next check', async () => {
    const own = await openDatabase(await testDatabaseUrl());
    try {
      const lines: string[] = [];
      let failed = false;
      const flaky = {
        postSystem: async (channel: string, text: string) => {
          if (!failed) {
            failed = true;
            throw new Error('boom');
          }
          lines.push(`${channel}|${text}`);
        },
      };
      const clock = new FakeClock(Date.UTC(2026, 9, 15));
      const [a, b] = await agents(own.db, 2);
      await play(own.db, '2026-08', 'critical-mass', [[a], [b]]);
      const lb = board(own.db, clock).lb;
      await expect(lb.closeSeasons(flaky)).rejects.toThrow('boom');
      expect(await lb.closeSeasons(flaky)).toEqual(['2026-08']);
      expect(lines).toHaveLength(1);
    } finally {
      await own.close();
    }
  });
});

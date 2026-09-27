import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../db';
import { matches, matchPlayers } from '../db/schema';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { randomTag } from '../lib/testing';
import { AccountManager } from './accounts';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { ProfileService } from './profiles';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());
const clock = new FakeClock();
const ids = new IdentityManager(database.db, clock, { houseKey: null });
const accounts = new AccountManager(database.db, clock, ids, new Guard());
const profiles = new ProfileService(database.db, ids);

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

async function match(status: 'over' | 'abandoned', endedAt: number, players: [string, 'win' | 'loss'][]) {
  const id = newId('m');
  await database.db.insert(matches).values({ id, gameId: 'critical-mass', status, seed: 1, season: '2026-09', endedAt: new Date(endedAt) });
  await database.db.insert(matchPlayers).values(
    players.map(([identityId, result], i) => ({ matchId: id, seat: ['red', 'blue'][i], identityId, kind: 'human' as const, result })),
  );
  return id;
}

type PlayerSpec = { identity: { id: string; kind: 'human' | 'agent' }; result: 'win' | 'loss' | 'draw' | 'abandoned' };

/** A full-control match helper for record/rival tests: a chosen gameId, end reason, per-player species and result. */
async function play(opts: { status?: 'over' | 'abandoned'; gameId?: string; endReason?: string | null; endedAt: number; players: PlayerSpec[] }): Promise<string> {
  const id = newId('m');
  await database.db.insert(matches).values({
    id,
    gameId: opts.gameId ?? 'critical-mass',
    status: opts.status ?? 'over',
    seed: 1,
    season: '2026-09',
    endReason: opts.endReason ?? null,
    endedAt: new Date(opts.endedAt),
  });
  await database.db.insert(matchPlayers).values(
    opts.players.map((p, i) => ({ matchId: id, seat: `s${i}`, identityId: p.identity.id, kind: p.identity.kind, result: p.result })),
  );
  return id;
}

describe('ProfileService', () => {
  test('shows the bio, dates and finished matches newest first, with opponents', async () => {
    const me = (await ids.createHuman(`prof${randomTag()}`)).identity;
    const rival = (await ids.createHuman(`riv${randomTag()}`)).identity;
    await accounts.setBio(me, 'Human. Asks about technology.');
    const older = await match('over', clock.now() - 60_000, [[me.id, 'loss'], [rival.id, 'win']]);
    const newer = await match('over', clock.now(), [[me.id, 'win'], [rival.id, 'loss']]);
    await match('abandoned', clock.now(), [[me.id, 'loss'], [rival.id, 'win']]);

    const p = await profiles.profile(me.handle.toUpperCase());
    expect(p.identity).toMatchObject({ id: me.id, tagline: 'Human. Asks about technology.' });
    expect(Date.parse(p.joinedAt)).not.toBeNaN();
    expect(p.matches.map((m) => [m.id, m.result])).toEqual([[newer, 'win'], [older, 'loss']]);
    expect(p.matches[0].opponents.map((o) => o.id)).toEqual([rival.id]);
  });
  test('unknown and released names are not found by handle; the mod view still reads them by id', async () => {
    expect((await errorOf(profiles.profile('nobody-at-all'))).code).toBe('NO_USER');
    const gone = (await ids.createHuman(`gone${randomTag()}`)).identity;
    await accounts.release(gone.id);
    expect((await errorOf(profiles.profile(gone.handle))).code).toBe('NO_USER');
    expect((await profiles.profileById(gone.id)).identity.released).toBe(true);
    expect((await errorOf(profiles.profileById('id_nobody'))).code).toBe('NO_USER');
  });

  test('each match carries its end reason', async () => {
    const me = (await ids.createHuman(`end${randomTag()}`)).identity;
    const rival = (await ids.registerAgent({ name: `end${randomTag()}` }, null)).identity;
    await play({ endedAt: clock.now(), endReason: 'last-standing', players: [{ identity: me, result: 'win' }, { identity: rival, result: 'loss' }] });
    const p = await profiles.profile(me.handle);
    expect(p.matches[0].endReason).toBe('last-standing');
  });

  test('record vs machines counts only finished matches where every opponent is an agent, by game', async () => {
    const me = (await ids.createHuman(`rec${randomTag()}`)).identity;
    const bot1 = (await ids.registerAgent({ name: `bot1${randomTag()}` }, null)).identity;
    const bot2 = (await ids.registerAgent({ name: `bot2${randomTag()}` }, null)).identity;
    const otherHuman = (await ids.createHuman(`oh${randomTag()}`)).identity;
    let t = clock.now();
    await play({ endedAt: t++, gameId: 'critical-mass', players: [{ identity: me, result: 'win' }, { identity: bot1, result: 'loss' }] });
    await play({ endedAt: t++, gameId: 'critical-mass', players: [{ identity: me, result: 'loss' }, { identity: bot1, result: 'win' }] });
    await play({ endedAt: t++, gameId: 'critical-mass', players: [{ identity: me, result: 'draw' }, { identity: bot2, result: 'draw' }] });
    await play({ endedAt: t++, gameId: 'other-game', players: [{ identity: me, result: 'win' }, { identity: bot2, result: 'loss' }] });
    // vs a human: excluded from the "vs machines" record.
    await play({ endedAt: t++, gameId: 'critical-mass', players: [{ identity: me, result: 'win' }, { identity: otherHuman, result: 'loss' }] });
    // mixed opponents (human + agent): excluded, not purely "vs machines".
    await play({ endedAt: t++, gameId: 'critical-mass', players: [{ identity: me, result: 'win' }, { identity: bot1, result: 'loss' }, { identity: otherHuman, result: 'loss' }] });
    // not finished: excluded.
    await play({ status: 'abandoned', endedAt: t++, gameId: 'critical-mass', players: [{ identity: me, result: 'abandoned' }, { identity: bot1, result: 'abandoned' }] });

    const p = await profiles.profile(me.handle);
    expect(p.record).toEqual({
      versus: 'machines',
      wins: 2,
      losses: 1,
      draws: 1,
      played: 4,
      games: [
        { gameId: 'critical-mass', played: 3 },
        { gameId: 'other-game', played: 1 },
      ],
    });
  });

  test('an agent\'s record is framed as "vs humans"', async () => {
    const agent = (await ids.registerAgent({ name: `bot${randomTag()}` }, null)).identity;
    const human = (await ids.createHuman(`hu${randomTag()}`)).identity;
    await play({ endedAt: clock.now(), players: [{ identity: agent, result: 'win' }, { identity: human, result: 'loss' }] });
    const p = await profiles.profileById(agent.id);
    expect(p.record).toEqual({ versus: 'humans', wins: 1, losses: 0, draws: 0, played: 1, games: [{ gameId: 'critical-mass', played: 1 }] });
  });

  test('record is empty (not an error) with no qualifying matches', async () => {
    const me = (await ids.createHuman(`empty${randomTag()}`)).identity;
    const p = await profiles.profile(me.handle);
    expect(p.record).toEqual({ versus: 'machines', wins: 0, losses: 0, draws: 0, played: 0, games: [] });
  });

  test('rival is the most-played two-player opponent, ties broken by the more recent match; null with none', async () => {
    const me = (await ids.createHuman(`riv${randomTag()}`)).identity;
    const frequent = (await ids.registerAgent({ name: `freq${randomTag()}` }, null)).identity;
    const occasional = (await ids.registerAgent({ name: `occ${randomTag()}` }, null)).identity;
    const third = (await ids.registerAgent({ name: `third${randomTag()}` }, null)).identity;
    let t = clock.now();
    await play({ endedAt: t++, players: [{ identity: me, result: 'win' }, { identity: frequent, result: 'loss' }] });
    await play({ endedAt: t++, players: [{ identity: me, result: 'loss' }, { identity: frequent, result: 'win' }] });
    await play({ endedAt: t++, players: [{ identity: me, result: 'draw' }, { identity: frequent, result: 'draw' }] });
    await play({ endedAt: t++, players: [{ identity: me, result: 'win' }, { identity: occasional, result: 'loss' }] });
    // a 3-player match against `frequent` doesn't count toward the two-player tally.
    await play({ endedAt: t++, players: [{ identity: me, result: 'win' }, { identity: frequent, result: 'loss' }, { identity: third, result: 'loss' }] });

    const p = await profiles.profile(me.handle);
    expect(p.rival).toEqual({ opponent: expect.objectContaining({ id: frequent.id }), wins: 1, losses: 1, draws: 1 });

    const lonely = (await ids.createHuman(`lone${randomTag()}`)).identity;
    expect((await profiles.profile(lonely.handle)).rival).toBeNull();
  });

  test('rival ties on play count are broken by the more recently played opponent', async () => {
    const me = (await ids.createHuman(`tie${randomTag()}`)).identity;
    const older = (await ids.registerAgent({ name: `old${randomTag()}` }, null)).identity;
    const newer = (await ids.registerAgent({ name: `new${randomTag()}` }, null)).identity;
    await play({ endedAt: clock.now(), players: [{ identity: me, result: 'win' }, { identity: older, result: 'loss' }] });
    await play({ endedAt: clock.now() + 10_000, players: [{ identity: me, result: 'win' }, { identity: newer, result: 'loss' }] });
    const p = await profiles.profile(me.handle);
    expect(p.rival?.opponent.id).toBe(newer.id);
  });

  test('rival includes a released opponent, marked released', async () => {
    const me = (await ids.createHuman(`relv${randomTag()}`)).identity;
    const gone = (await ids.createHuman(`gonev${randomTag()}`)).identity;
    await play({ endedAt: clock.now(), players: [{ identity: me, result: 'win' }, { identity: gone, result: 'loss' }] });
    await accounts.release(gone.id);
    const p = await profiles.profile(me.handle);
    expect(p.rival).toEqual({ opponent: expect.objectContaining({ id: gone.id, released: true }), wins: 1, losses: 0, draws: 0 });
  });

  test('a true tie (same play count, same instant) breaks on the opponent id, deterministically', async () => {
    const me = (await ids.createHuman(`tieid${randomTag()}`)).identity;
    const a = (await ids.registerAgent({ name: `tiea${randomTag()}` }, null)).identity;
    const b = (await ids.registerAgent({ name: `tieb${randomTag()}` }, null)).identity;
    const at = clock.now();
    await play({ endedAt: at, players: [{ identity: me, result: 'win' }, { identity: a, result: 'loss' }] });
    await play({ endedAt: at, players: [{ identity: me, result: 'win' }, { identity: b, result: 'loss' }] });
    const expectedId = [a.id, b.id].sort()[0];
    const p = await profiles.profile(me.handle);
    expect(p.rival?.opponent.id).toBe(expectedId);
  });

  test('a solo finished match (no opponent) does not count toward the record', async () => {
    const me = (await ids.createHuman(`solo${randomTag()}`)).identity;
    await play({ endedAt: clock.now(), players: [{ identity: me, result: 'win' }] });
    const p = await profiles.profile(me.handle);
    expect(p.record).toEqual({ versus: 'machines', wins: 0, losses: 0, draws: 0, played: 0, games: [] });
  });

  test('an abandoned two-player match does not count toward rival', async () => {
    const me = (await ids.createHuman(`aband${randomTag()}`)).identity;
    const opp = (await ids.registerAgent({ name: `abandopp${randomTag()}` }, null)).identity;
    await play({ status: 'abandoned', endedAt: clock.now(), players: [{ identity: me, result: 'abandoned' }, { identity: opp, result: 'abandoned' }] });
    const p = await profiles.profile(me.handle);
    expect(p.rival).toBeNull();
  });

  test('games stays in lockstep with played, even for a finished match with no result recorded', async () => {
    const me = (await ids.createHuman(`gp${randomTag()}`)).identity;
    const opp = (await ids.registerAgent({ name: `gpopp${randomTag()}` }, null)).identity;
    const id = newId('m');
    await database.db.insert(matches).values({ id, gameId: 'critical-mass', status: 'over', seed: 1, season: '2026-09', endedAt: new Date(clock.now()) });
    await database.db.insert(matchPlayers).values([
      { matchId: id, seat: 's0', identityId: me.id, kind: 'human', result: null },
      { matchId: id, seat: 's1', identityId: opp.id, kind: 'agent', result: null },
    ]);
    const p = await profiles.profile(me.handle);
    expect(p.record.played).toBe(0);
    expect(p.record.games).toEqual([]);
  });

  test("an agent's \"vs humans\" record ignores an agent-vs-agent match", async () => {
    const agent = (await ids.registerAgent({ name: `avsh${randomTag()}` }, null)).identity;
    const otherAgent = (await ids.registerAgent({ name: `avsh2${randomTag()}` }, null)).identity;
    const human = (await ids.createHuman(`avsh3${randomTag()}`)).identity;
    await play({ endedAt: clock.now(), players: [{ identity: agent, result: 'win' }, { identity: otherAgent, result: 'loss' }] });
    await play({ endedAt: clock.now() + 1, players: [{ identity: agent, result: 'win' }, { identity: human, result: 'loss' }] });
    const p = await profiles.profileById(agent.id);
    expect(p.record).toEqual({ versus: 'humans', wins: 1, losses: 0, draws: 0, played: 1, games: [{ gameId: 'critical-mass', played: 1 }] });
  });
});

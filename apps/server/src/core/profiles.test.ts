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

const database = await openDatabase('pglite:memory');
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
});

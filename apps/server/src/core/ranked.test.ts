import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../db';
import { identities, matches, matchPlayers } from '../db/schema';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { randomTag } from '../lib/testing';
import { AccountManager } from './accounts';
import { Guard } from './guard';
import { IdentityManager, RANKED_GRACE_MS } from './identity';
import { isRatedMatch, PRACTICE_GAMES } from './ranked';
import type { IdentityPublic } from '@cs/shared/protocol';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

const DAY = 86_400_000;
const PW = 'correct horse battery';

function setup() {
  const clock = new FakeClock();
  const ids = new IdentityManager(database.db, clock, { houseKey: null });
  const accounts = new AccountManager(database.db, clock, ids, new Guard());
  return { clock, ids, accounts };
}
const rankedAtOf = async (id: string) =>
  (await database.db.select({ r: identities.rankedAt }).from(identities).where(eq(identities.id, id)))[0].r;
const codeOf = (p: Promise<unknown>) => p.then(() => null, (e: AppError) => [e.status, e.code]);

describe('ranked_at', () => {
  test('a human gets a week of grace; an agent is ranked from its first game', async () => {
    const { clock, ids } = setup();
    const h = (await ids.createHuman(`gr${randomTag()}`)).identity;
    const a = (await ids.registerAgent({ name: `ga${randomTag()}` }, null)).identity;
    expect(RANKED_GRACE_MS).toBe(7 * DAY);
    expect((await rankedAtOf(h.id))?.getTime()).toBe(clock.now() + RANKED_GRACE_MS);
    expect((await rankedAtOf(a.id))?.getTime()).toBe(clock.now());
  });
});

describe('go ranked now', () => {
  test('a locked human in their grace week is ranked from now; asking again changes nothing', async () => {
    const { clock, ids, accounts } = setup();
    const h = (await ids.createHuman(`gn${randomTag()}`)).identity;
    const { identity } = await accounts.lock(h, PW);
    clock.advance(DAY);
    const first = new Date(clock.now()).toISOString();
    expect(await accounts.goRanked(identity)).toEqual({ rankedAt: first });
    clock.advance(DAY);
    expect(await accounts.goRanked(identity)).toEqual({ rankedAt: first });
    expect((await rankedAtOf(h.id))?.toISOString()).toBe(first);
  });
  test('a human past the week keeps the day the week ended', async () => {
    const { clock, ids, accounts } = setup();
    const created = clock.now();
    const h = (await ids.createHuman(`gp${randomTag()}`)).identity;
    const { identity } = await accounts.lock(h, PW);
    clock.advance(8 * DAY);
    expect(await accounts.goRanked(identity)).toEqual({ rankedAt: new Date(created + RANKED_GRACE_MS).toISOString() });
  });
  test('a guest must lock first; an agent is refused', async () => {
    const { ids, accounts } = setup();
    const guest = (await ids.createHuman(`gg${randomTag()}`)).identity;
    const agent = (await ids.registerAgent({ name: `gx${randomTag()}` }, null)).identity;
    expect(await codeOf(accounts.goRanked(guest))).toEqual([403, 'LOCK_FIRST']);
    expect(await codeOf(accounts.goRanked(agent))).toEqual([403, 'HUMANS_ONLY']);
  });
});

async function finished(gameId: string, who: IdentityPublic[], n: number, status: 'over' | 'abandoned' = 'over') {
  for (let i = 0; i < n; i++) {
    const id = newId('m');
    await database.db.insert(matches).values({ id, gameId, status, seed: 1, season: '2026-09' });
    await database.db
      .insert(matchPlayers)
      .values(who.map((p, k) => ({ matchId: id, seat: `s${k}`, identityId: p.id, kind: p.kind, result: status === 'over' ? ('draw' as const) : ('abandoned' as const) })));
  }
}

describe('rated matches', () => {
  test('two agents past three practice games make a rated match; practice is counted per game', async () => {
    const { clock, ids } = setup();
    const a = (await ids.registerAgent({ name: `ra${randomTag()}` }, null)).identity;
    const b = (await ids.registerAgent({ name: `rb${randomTag()}` }, null)).identity;
    expect(PRACTICE_GAMES).toBe(3);
    await finished('critical-mass', [a, b], 2);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, b], clock.now())).toBe(false);
    await finished('critical-mass', [a, b], 1);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, b], clock.now())).toBe(true);
    expect(await isRatedMatch(database.db, 'checkers', [a, b], clock.now())).toBe(false);
  });
  test('abandoned matches are not practice; a game can ask for more', async () => {
    const { clock, ids } = setup();
    const a = (await ids.registerAgent({ name: `rc${randomTag()}` }, null)).identity;
    const b = (await ids.registerAgent({ name: `rd${randomTag()}` }, null)).identity;
    await finished('critical-mass', [a, b], 3, 'abandoned');
    await finished('critical-mass', [a, b], 2);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, b], clock.now())).toBe(false);
    await finished('critical-mass', [a, b], 1);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, b], clock.now())).toBe(true);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, b], clock.now(), 4)).toBe(false);
  });
  test('a guest, or a locked human in their first week, makes the match unrated for everyone', async () => {
    const { clock, ids, accounts } = setup();
    const a = (await ids.registerAgent({ name: `re${randomTag()}` }, null)).identity;
    const guest = (await ids.createHuman(`rf${randomTag()}`)).identity;
    const fresh = (await accounts.lock((await ids.createHuman(`rg${randomTag()}`)).identity, PW)).identity;
    await finished('critical-mass', [a, guest], 3);
    await finished('critical-mass', [a, fresh], 3);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, guest], clock.now())).toBe(false);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, fresh], clock.now())).toBe(false);
    await accounts.goRanked(fresh);
    expect(await isRatedMatch(database.db, 'critical-mass', [a, fresh], clock.now())).toBe(true);
  });
});

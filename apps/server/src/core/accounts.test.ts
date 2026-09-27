import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openDatabase, type Database } from '../db';
import { identities, matches, matchPlayers, sessions } from '../db/schema';
import { FakeClock } from '../lib/clock';
import { AppError, forbidden } from '../lib/errors';
import { newId } from '../lib/ids';
import { randomTag } from '../lib/testing';
import { AccountManager } from './accounts';
import { Guard } from './guard';
import { IdentityManager } from './identity';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());
const DAY = 86_400_000;
const PW = 'correct horse battery';
const meta = { label: 'Chrome on Linux', ip: '10.2.0.1' };

function setup(db: Database = database, clock = new FakeClock()) {
  const guard = new Guard();
  const ids = new IdentityManager(db.db, clock, { houseKey: 'hk' });
  const accounts = new AccountManager(db.db, clock, ids, guard);
  return { clock, guard, ids, accounts };
}
type Ctx = ReturnType<typeof setup>;

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

/** A human with a locked name and two signed-in browsers. */
async function locked(ctx: Ctx, prefix = 'lock') {
  const handle = `${prefix}${randomTag()}`;
  const guest = await ctx.ids.createHuman(handle, meta);
  const { recoveryCode, identity } = await ctx.accounts.lock(guest.identity, PW);
  const other = await ctx.ids.newSession(identity.id, { label: 'Firefox on Linux', ip: '10.2.0.2' });
  return { handle, identity, keyA: guest.key, keyB: other, recoveryCode };
}

describe('locking a name', () => {
  test('a guest locks with a password and gets a one-time recovery code', async () => {
    const ctx = setup();
    const guest = await ctx.ids.createHuman(`guest${randomTag()}`);
    expect((await errorOf(ctx.accounts.lock(guest.identity, 'short'))).code).toBe('BAD_FIELD');
    const { identity, recoveryCode } = await ctx.accounts.lock(guest.identity, PW);
    expect(identity.locked).toBe(true);
    expect(recoveryCode).toMatch(/^csr_/);
    expect((await ctx.ids.authenticate(guest.key))?.locked).toBe(true); // the cache picked it up
    expect((await errorOf(ctx.accounts.lock(identity, PW))).code).toBe('ALREADY_LOCKED');
  });
  test('agents are reserved already', async () => {
    const ctx = setup();
    const bot = await ctx.ids.registerAgent({ name: `bot${randomTag()}` }, null);
    expect((await errorOf(ctx.accounts.lock(bot.identity, PW))).code).toBe('ALREADY_LOCKED');
  });
});

describe('signing in', () => {
  test('a locked name signs in from anywhere, whatever the case and spacing', async () => {
    const ctx = setup();
    const { handle, identity } = await locked(ctx);
    const r = await ctx.accounts.login(`  ${handle.toUpperCase()} `, PW, meta);
    expect(r.identity.id).toBe(identity.id);
    const auth = await ctx.ids.authenticateSession(r.key);
    expect(auth?.identity.id).toBe(identity.id);
    expect(auth?.sessionId).toMatch(/^se_/);
  });
  test('wrong password, unknown handle and unlocked guest all fail the same way', async () => {
    const ctx = setup();
    const { handle } = await locked(ctx);
    const guest = await ctx.ids.createHuman(`open${randomTag()}`);
    for (const [h, pw] of [[handle, 'wrong password!'], [`ghost${randomTag()}`, PW], [guest.identity.handle, PW], [handle, 42]] as const) {
      const err = await errorOf(ctx.accounts.login(h, pw, meta));
      expect([err.status, err.code]).toEqual([401, 'BAD_PASSWORD']);
    }
  });
});

describe('changing a password', () => {
  test('keeps this browser, signs out every other one at once, and retires the old password', async () => {
    const ctx = setup();
    const { handle, identity, keyA, keyB } = await locked(ctx);
    const a = (await ctx.ids.authenticateSession(keyA))!;
    await ctx.ids.authenticate(keyB); // warm the cache: eviction must still cut it off
    expect((await errorOf(ctx.accounts.changePassword(identity, 'not it at all', 'brand new secret', a.sessionId))).code).toBe('BAD_PASSWORD');
    await ctx.accounts.changePassword(identity, PW, 'brand new secret', a.sessionId);
    expect((await ctx.ids.authenticate(keyA))?.id).toBe(identity.id);
    expect(await ctx.ids.authenticate(keyB)).toBeNull();
    expect((await errorOf(ctx.accounts.login(handle, PW, meta))).code).toBe('BAD_PASSWORD');
    expect((await ctx.accounts.login(handle, 'brand new secret', meta)).identity.id).toBe(identity.id);
  });
  test('a guest has no password to change', async () => {
    const ctx = setup();
    const guest = await ctx.ids.createHuman(`free${randomTag()}`);
    expect((await errorOf(ctx.accounts.changePassword(guest.identity, PW, 'another one here', null))).code).toBe('NOT_LOCKED');
  });
});

describe('recovery', () => {
  test('the recovery code sets a new password, signs everyone out, and is replaced', async () => {
    const ctx = setup();
    const { handle, identity, keyA, keyB, recoveryCode } = await locked(ctx);
    await ctx.ids.authenticate(keyA);
    await ctx.ids.authenticate(keyB);
    expect((await errorOf(ctx.accounts.recover(handle, 'csr_wrong', 'fresh start here', meta))).code).toBe('BAD_CODE');
    const r = await ctx.accounts.recover(` ${handle} `, recoveryCode, 'fresh start here', meta);
    expect(r.identity.id).toBe(identity.id);
    expect(r.recoveryCode).not.toBe(recoveryCode);
    expect(await ctx.ids.authenticate(keyA)).toBeNull();
    expect(await ctx.ids.authenticate(keyB)).toBeNull();
    expect((await ctx.ids.authenticate(r.key))?.id).toBe(identity.id);
    expect((await errorOf(ctx.accounts.recover(handle, recoveryCode, 'fresh start again', meta))).code).toBe('BAD_CODE');
    expect((await ctx.accounts.login(handle, 'fresh start here', meta)).identity.id).toBe(identity.id);
  });
  test('an admin reset code works like a recovery code; guests have none', async () => {
    const ctx = setup();
    const { handle, identity, recoveryCode } = await locked(ctx);
    const code = await ctx.accounts.issueResetCode(identity.id);
    expect(code).toMatch(/^csr_/);
    expect((await errorOf(ctx.accounts.recover(handle, recoveryCode, 'lost and found!', meta))).code).toBe('BAD_CODE');
    expect((await ctx.accounts.recover(handle, code, 'lost and found!', meta)).identity.id).toBe(identity.id);
    const guest = await ctx.ids.createHuman(`nocode${randomTag()}`);
    expect((await errorOf(ctx.accounts.issueResetCode(guest.identity.id))).code).toBe('NOT_LOCKED');
  });
});

describe('sessions', () => {
  test('lists browsers newest first, marks this one, and revokes one, the others, or by IP', async () => {
    const ctx = setup();
    const { identity, keyA, keyB } = await locked(ctx);
    const a = (await ctx.ids.authenticateSession(keyA))!;
    const b = (await ctx.ids.authenticateSession(keyB))!;
    const list = await ctx.accounts.sessions(identity.id, a.sessionId);
    expect(list.map((s) => [s.id, s.current])).toEqual(
      expect.arrayContaining([[a.sessionId, true], [b.sessionId, false]]),
    );
    expect(list.find((s) => s.id === b.sessionId)).toMatchObject({ label: 'Firefox on Linux', ip: '10.2.0.2' });

    expect(await ctx.accounts.revokeSession(identity.id, b.sessionId!)).toBe(true);
    expect(await ctx.accounts.revokeSession(identity.id, b.sessionId!)).toBe(false);
    expect(await ctx.ids.authenticate(keyB)).toBeNull();

    const c = await ctx.ids.newSession(identity.id, meta);
    await ctx.ids.authenticate(c);
    expect(await ctx.accounts.revokeOthers(identity.id, a.sessionId)).toBe(1);
    expect(await ctx.ids.authenticate(c)).toBeNull();
    expect((await ctx.ids.authenticate(keyA))?.id).toBe(identity.id);

    const d = await ctx.ids.newSession(identity.id, { label: 'x', ip: '10.66.0.1' });
    await ctx.ids.authenticate(d);
    expect(await ctx.accounts.revokeByIp('10.66.0.1')).toBe(1);
    expect(await ctx.ids.authenticate(d)).toBeNull();
    expect((await ctx.ids.authenticate(keyA))?.id).toBe(identity.id);
  });
});

describe('release and deletion', () => {
  test('release tombstones the name, keeps match rows, runs hooks, and frees the handle', async () => {
    const ctx = setup();
    const { handle, identity, keyA } = await locked(ctx, 'leaver');
    await ctx.accounts.setBio(identity, 'here for the orbs');
    const matchId = newId('m');
    await database.db.insert(matches).values({ id: matchId, gameId: 'critical-mass', status: 'over', seed: 1, season: '2026-09' });
    await database.db.insert(matchPlayers).values({ matchId, seat: 'red', identityId: identity.id, kind: 'human', result: 'win' });
    const hooked: string[] = [];
    ctx.accounts.onRelease(async (id) => {
      hooked.push(id);
    });
    await ctx.ids.authenticate(keyA);

    await ctx.accounts.release(identity.id);
    await ctx.accounts.release(identity.id); // idempotent

    expect(hooked).toEqual([identity.id]);
    const row = (await ctx.ids.row(identity.id))!;
    expect(row).toMatchObject({ handle: `~${identity.id}`, tagline: null, passwordHash: null, recoveryHash: null });
    expect(row.releasedAt).not.toBeNull();
    expect(await database.db.select().from(sessions).where(eq(sessions.identityId, identity.id))).toHaveLength(0);
    expect(await ctx.ids.authenticate(keyA)).toBeNull();
    const [played] = await database.db.select().from(matchPlayers).where(eq(matchPlayers.matchId, matchId));
    expect(played.identityId).toBe(identity.id);
    expect((await errorOf(ctx.accounts.login(handle, PW, meta))).code).toBe('BAD_PASSWORD');
    const fresh = await ctx.ids.createHuman(handle);
    expect(fresh.identity.id).not.toBe(identity.id);
    expect((await errorOf(ctx.accounts.login(handle, PW, meta))).code).toBe('BAD_PASSWORD');
  });
  test('deleting yourself needs your password if the name is locked', async () => {
    const ctx = setup();
    const { identity } = await locked(ctx, 'quitter');
    expect((await errorOf(ctx.accounts.deleteSelf(identity, 'not my password'))).code).toBe('BAD_PASSWORD');
    await ctx.accounts.deleteSelf(identity, PW);
    expect((await ctx.ids.row(identity.id))?.releasedAt).not.toBeNull();
    const guest = await ctx.ids.createHuman(`brief${randomTag()}`);
    await ctx.accounts.deleteSelf(guest.identity, undefined);
    expect((await ctx.ids.row(guest.identity.id))?.releasedAt).not.toBeNull();
  });
  test('the guard can refuse bios and self-deletion (a suspended account)', async () => {
    const ctx = setup();
    const guest = await ctx.ids.createHuman(`held${randomTag()}`);
    ctx.guard.install((who, action) => {
      if (who.id === guest.identity.id && action === 'profile') throw forbidden('SUSPENDED', 'Suspended.');
    });
    expect((await errorOf(ctx.accounts.setBio(guest.identity, 'hello'))).code).toBe('SUSPENDED');
    expect((await errorOf(ctx.accounts.deleteSelf(guest.identity, undefined))).code).toBe('SUSPENDED');
    expect((await ctx.ids.row(guest.identity.id))?.releasedAt).toBeNull();
  });
});

describe('bio', () => {
  test('sets, filters, clears, and limits the bio', async () => {
    const ctx = setup();
    const guest = await ctx.ids.createHuman(`bio${randomTag()}`);
    expect((await ctx.accounts.setBio(guest.identity, '  Human. Asks about technology. ')).tagline).toBe('Human. Asks about technology.');
    expect((await ctx.accounts.setBio(guest.identity, 'full of shit')).tagline).not.toContain('shit');
    expect((await ctx.accounts.setBio(guest.identity, '')).tagline).toBeNull();
    expect((await errorOf(ctx.accounts.setBio(guest.identity, 'x'.repeat(81)))).code).toBe('BAD_FIELD');
    expect((await errorOf(ctx.accounts.setBio(guest.identity, 7))).code).toBe('BAD_FIELD');
  });
});

describe('the idle sweep', () => {
  test('releases idle guests after 30 days, or 180 with matches; never locked names, agents or house bots', async () => {
    const own = await openDatabase('pglite:memory');
    try {
      const clock = new FakeClock(Date.now());
      const ctx = setup(own, clock);
      const idleFor = async (id: string, days: number) =>
        own.db.update(identities).set({ lastSeenAt: new Date(clock.now() - days * DAY) }).where(eq(identities.id, id));
      const played = async (id: string) => {
        const matchId = newId('m');
        await own.db.insert(matches).values({ id: matchId, gameId: 'critical-mass', status: 'over', seed: 1, season: '2026-09' });
        await own.db.insert(matchPlayers).values({ matchId, seat: 'red', identityId: id, kind: 'human', result: 'loss' });
      };
      const fresh = (await ctx.ids.createHuman('Fresh')).identity;
      const idle = (await ctx.ids.createHuman('Idle')).identity;
      const player = (await ctx.ids.createHuman('Player')).identity;
      const veteran = (await ctx.ids.createHuman('Veteran')).identity;
      const keeper = (await ctx.accounts.lock((await ctx.ids.createHuman('Keeper')).identity, PW)).identity;
      const bot = (await ctx.ids.registerAgent({ name: 'Dusty' }, null)).identity;
      const house = (await ctx.ids.registerAgent({ name: 'Doorman' }, 'hk')).identity;
      await idleFor(fresh.id, 29);
      await idleFor(idle.id, 31);
      await idleFor(player.id, 31);
      await played(player.id);
      await idleFor(veteran.id, 181);
      await played(veteran.id);
      for (const id of [keeper.id, bot.id, house.id]) await idleFor(id, 400);

      expect(await ctx.accounts.sweepIdle()).toBe(2);
      const released = async (id: string) => (await ctx.ids.row(id))!.releasedAt !== null;
      expect(await released(idle.id)).toBe(true);
      expect(await released(veteran.id)).toBe(true);
      for (const id of [fresh.id, player.id, keeper.id, bot.id, house.id]) expect(await released(id)).toBe(false);
      expect(await ctx.accounts.sweepIdle()).toBe(0);
    } finally {
      await own.close();
    }
  });
});

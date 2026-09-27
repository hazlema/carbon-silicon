import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../db';
import { identities, sessions } from '../db/schema';
import { FakeClock } from '../lib/clock';
import { AppError } from '../lib/errors';
import { randomTag, waitFor } from '../lib/testing';
import { IdentityManager } from './identity';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());
const clock = new FakeClock();
const ids = new IdentityManager(database.db, clock, { houseKey: 'house-secret' });

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('humans', () => {
  test('createHuman returns a csk_ key that authenticates', async () => {
    const { identity, key } = await ids.createHuman('Ada');
    expect(key.startsWith('csk_')).toBe(true);
    expect(identity).toMatchObject({ handle: 'Ada', kind: 'human', isHouse: false, locked: false, role: 'user', released: false });
    expect(identity.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(await ids.authenticate(key)).toEqual(identity);
  });
  test('handles are unique regardless of case', async () => {
    await ids.createHuman('Fable');
    const err = await errorOf(ids.createHuman('fable'));
    expect([err.status, err.code]).toEqual([409, 'HANDLE_TAKEN']);
  });
  test('invalid and reserved handles are rejected', async () => {
    expect((await errorOf(ids.createHuman('Fаble'))).code).toBe('HANDLE_INVALID');
    expect((await errorOf(ids.createHuman('x'))).code).toBe('HANDLE_INVALID');
    expect((await errorOf(ids.createHuman('admin'))).code).toBe('HANDLE_RESERVED');
  });
  test('nobody becomes admin by claiming a handle', async () => {
    const { identity } = await ids.createHuman('Frosty');
    expect(identity.role).toBe('user');
  });
  test('each browser gets its own session; both keys work', async () => {
    const { identity, key } = await ids.createHuman(`Two${randomTag()}`);
    const second = await ids.newSession(identity.id, { label: 'Firefox on Linux', ip: '10.9.9.9' });
    const a = await ids.authenticateSession(key);
    const b = await ids.authenticateSession(second);
    expect(a?.identity.id).toBe(identity.id);
    expect(b?.identity.id).toBe(identity.id);
    expect(a?.sessionId).toMatch(/^se_/);
    expect(b?.sessionId).not.toBe(a?.sessionId);
    const [row] = await database.db.select().from(sessions).where(eq(sessions.id, b!.sessionId!));
    expect(row).toMatchObject({ label: 'Firefox on Linux', ip: '10.9.9.9' });
  });
  test("a human's identity secret is never a way in", async () => {
    const { identity } = await ids.createHuman(`Nosecret${randomTag()}`);
    const [row] = await database.db.select().from(identities).where(eq(identities.id, identity.id));
    // Only the hash is stored, so the best an attacker could send is the hash itself; it must not work.
    expect(await ids.authenticate(row.secretHash)).toBeNull();
  });
});

describe('the cache', () => {
  test('evict() drops cached sessions, so a revoked key fails on its very next use', async () => {
    const { identity, key } = await ids.createHuman(`Evict${randomTag()}`);
    expect((await ids.authenticate(key))?.id).toBe(identity.id); // now cached
    await database.db.delete(sessions).where(eq(sessions.identityId, identity.id));
    expect((await ids.authenticate(key))?.id).toBe(identity.id); // the cache still vouches for it…
    ids.evict(identity.id);
    expect(await ids.authenticate(key)).toBeNull(); // …until evicted
  });
  test('setRole() is seen by the next authentication', async () => {
    const { identity, key } = await ids.createHuman(`Promo${randomTag()}`);
    expect((await ids.authenticate(key))?.role).toBe('user');
    expect((await ids.setRole(identity.id, 'mod')).role).toBe('mod');
    expect((await ids.authenticate(key))?.role).toBe('mod');
    expect((await errorOf(ids.setRole('id_nobody', 'mod'))).code).toBe('NO_USER');
  });
  test('released identities never authenticate and read as released', async () => {
    const { identity, key } = await ids.createHuman(`Gone${randomTag()}`);
    await ids.authenticate(key);
    await database.db.update(identities).set({ releasedAt: new Date(clock.now()) }).where(eq(identities.id, identity.id));
    expect((await ids.refresh(identity.id))?.released).toBe(true);
    expect(await ids.authenticate(key)).toBeNull();
  });
});

describe('touch', () => {
  test('writes last seen, last IP and the session at most once per 5 minutes', async () => {
    const { identity, key } = await ids.createHuman(`Seen${randomTag()}`);
    const auth = (await ids.authenticateSession(key))!;
    const seen = async () => (await ids.row(identity.id))!;
    ids.touch(identity.id, '10.0.0.1', auth.sessionId);
    await waitFor(async () => (await seen()).lastIp === '10.0.0.1');
    expect((await seen()).lastSeenAt.getTime()).toBe(clock.now());
    const t0 = clock.now();
    clock.advance(60_000);
    ids.touch(identity.id, '10.0.0.2', auth.sessionId);
    await Bun.sleep(30);
    expect((await seen()).lastIp).toBe('10.0.0.1');
    clock.advance(5 * 60_000);
    ids.touch(identity.id, '10.0.0.3', auth.sessionId);
    await waitFor(async () => (await seen()).lastIp === '10.0.0.3');
    expect((await seen()).lastSeenAt.getTime()).toBe(t0 + 6 * 60_000);
    const [s] = await database.db.select().from(sessions).where(eq(sessions.id, auth.sessionId!));
    expect([s.ip, s.lastUsedAt.getTime()]).toEqual(['10.0.0.3', t0 + 6 * 60_000]);
  });
});

describe('agents', () => {
  test('registerAgent returns a cs_ token and keeps the profile', async () => {
    const { identity, token } = await ids.registerAgent(
      { name: 'ByteEater', tagline: 'I eat bytes', color: '#12abef', model: 'Fable 5.1' },
      null,
    );
    expect(token.startsWith('cs_')).toBe(true);
    expect(identity).toMatchObject({ handle: 'ByteEater', kind: 'agent', tagline: 'I eat bytes', color: '#12abef', model: 'Fable 5.1', isHouse: false });
    const auth = await ids.authenticateSession(token);
    expect(auth).toEqual({ identity, sessionId: null });
  });
  test('agents and humans share one namespace', async () => {
    expect((await errorOf(ids.registerAgent({ name: 'ada' }, null))).code).toBe('HANDLE_TAKEN');
  });
  test('the house key marks house bots; a wrong one is refused', async () => {
    const { identity } = await ids.registerAgent({ name: 'Sprocket' }, 'house-secret');
    expect(identity.isHouse).toBe(true);
    const err = await errorOf(ids.registerAgent({ name: 'Imposter' }, 'wrong'));
    expect([err.status, err.code]).toEqual([403, 'BAD_HOUSE_KEY']);
  });
  test('bad colors and oversized fields are rejected; missing color gets a palette color', async () => {
    expect((await errorOf(ids.registerAgent({ name: 'Painter', color: 'red' }, null))).code).toBe('BAD_FIELD');
    expect((await errorOf(ids.registerAgent({ name: 'Talker', tagline: 'x'.repeat(81) }, null))).code).toBe('BAD_FIELD');
    const { identity } = await ids.registerAgent({ name: 'Plain' }, null);
    expect(identity.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(identity.tagline).toBeNull();
  });
  test('the house key re-issues a lost house-bot token; the old token stops working', async () => {
    const first = await ids.registerAgent({ name: 'Rotor', tagline: 'v1' }, 'house-secret');
    expect((await ids.authenticate(first.token))?.id).toBe(first.identity.id); // cached
    const second = await ids.registerAgent({ name: 'rotor', tagline: 'v2' }, 'house-secret');
    expect(second.identity.id).toBe(first.identity.id);
    expect(second.identity.tagline).toBe('v2');
    expect(second.token).not.toBe(first.token);
    expect(await ids.authenticate(first.token)).toBeNull();
    expect((await ids.authenticate(second.token))?.id).toBe(first.identity.id);
  });
  test('the house key cannot take over a non-house name', async () => {
    await ids.registerAgent({ name: 'Visitor' }, null);
    expect((await errorOf(ids.registerAgent({ name: 'Visitor' }, 'house-secret'))).code).toBe('HANDLE_TAKEN');
  });
});

describe('lookup', () => {
  test('authenticate rejects garbage; get, getByHandle and row find identities', async () => {
    expect(await ids.authenticate(null)).toBeNull();
    expect(await ids.authenticate('cs_nope')).toBeNull();
    expect(await ids.authenticate('csk_nope')).toBeNull();
    const { identity } = await ids.createHuman('Lookup');
    expect((await ids.get(identity.id))?.handle).toBe('Lookup');
    expect((await ids.getByHandle(' LOOKUP '))?.id).toBe(identity.id);
    expect((await ids.row(identity.id))?.handleLower).toBe('lookup');
    expect(await ids.getByHandle('nobody-here')).toBeNull();
    expect(await ids.row('id_nobody')).toBeNull();
  });
});

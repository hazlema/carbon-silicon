import { afterAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../db';
import { AppError } from '../lib/errors';
import { IdentityManager } from './identity';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());
const ids = new IdentityManager(database.db, { houseKey: 'house-secret', adminHandles: ['frosty'] });

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
    expect(identity).toMatchObject({ handle: 'Ada', kind: 'human', isHouse: false, locked: false, role: 'user' });
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
  test('admin handles get the admin role', async () => {
    const { identity } = await ids.createHuman('Frosty');
    expect(identity.role).toBe('admin');
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
    expect((await ids.authenticate(token))?.id).toBe(identity.id);
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
  test('authenticate rejects garbage; get and getByHandle find identities', async () => {
    expect(await ids.authenticate(null)).toBeNull();
    expect(await ids.authenticate('cs_nope')).toBeNull();
    const { identity } = await ids.createHuman('Lookup');
    expect((await ids.get(identity.id))?.handle).toBe('Lookup');
    expect((await ids.getByHandle('LOOKUP'))?.id).toBe(identity.id);
    expect(await ids.getByHandle('nobody-here')).toBeNull();
  });
});

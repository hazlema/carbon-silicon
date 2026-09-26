import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { isUniqueViolation } from '../lib/errors';
import { openDatabase } from './index';
import { identities } from './schema';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

const row = (id: string, handle: string) => ({
  id,
  handle,
  handleLower: handle.toLowerCase(),
  kind: 'human' as const,
  secretHash: `hash-${id}`,
  color: '#ffb347',
});

describe('openDatabase (pglite:memory)', () => {
  test('migrates and round-trips a row', async () => {
    await database.db.insert(identities).values(row('id_1', 'Frosty'));
    const [found] = await database.db.select().from(identities).where(eq(identities.id, 'id_1'));
    expect(found.handle).toBe('Frosty');
    expect(found.role).toBe('user');
    expect(found.createdAt).toBeInstanceOf(Date);
  });
  test('case-insensitive handle uniqueness is enforced by the index', async () => {
    let err: unknown = null;
    try {
      await database.db.insert(identities).values(row('id_2', 'frosty'));
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { databaseUrlFor } from './database-url';

describe('databaseUrlFor', () => {
  test('DATABASE_URL wins, in any supported form', () => {
    for (const url of ['postgres://u:p@h:5432/d', 'pglite:memory', 'pglite:/srv/x']) {
      expect(databaseUrlFor({ DATABASE_URL: url, NODE_ENV: 'production' }, '/app')).toBe(url);
    }
  });
  test('unset outside production: embedded PGlite under the repo root', () => {
    expect(databaseUrlFor({}, '/app/')).toBe('pglite:/app/.data/pglite');
    expect(databaseUrlFor({ NODE_ENV: 'development' }, '/app/')).toBe('pglite:/app/.data/pglite');
  });
  test('unset in production: throws the exact message', () => {
    expect(() => databaseUrlFor({ NODE_ENV: 'production' }, '/app/')).toThrow(
      'DATABASE_URL is not set. In production the site needs Postgres (postgres://user:password@host:5432/db); to run on the embedded database on purpose, set DATABASE_URL=pglite:/path/to/dir.',
    );
  });
});

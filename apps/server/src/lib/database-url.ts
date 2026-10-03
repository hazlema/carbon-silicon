import { join } from 'node:path';

export const NO_DATABASE_URL =
  'DATABASE_URL is not set. In production the site needs Postgres (postgres://user:password@host:5432/db); to run on the embedded database on purpose, set DATABASE_URL=pglite:/path/to/dir.';

/** The database to open: DATABASE_URL if set; else embedded PGlite under `root`, except in production, where a missing URL is a mistake. */
export function databaseUrlFor(env: Record<string, string | undefined>, root: string): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.NODE_ENV === 'production') throw new Error(NO_DATABASE_URL);
  return `pglite:${join(root, '.data/pglite')}`;
}

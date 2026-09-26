import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: DB;
  close(): Promise<void>;
}

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function openDatabase(url?: string): Promise<Database> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const sql = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(sql, { schema });
    await migratePostgres(db, { migrationsFolder: MIGRATIONS });
    return { db: db as unknown as DB, close: () => sql.end() };
  }
  let client: PGlite;
  if (url === 'pglite:memory') {
    client = new PGlite();
  } else {
    const dir = url?.startsWith('pglite:') ? url.slice('pglite:'.length) : '.data/pglite';
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as DB, close: () => client.close() };
}

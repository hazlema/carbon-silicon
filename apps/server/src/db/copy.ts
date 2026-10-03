import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, count, sql } from 'drizzle-orm';
import { PgTable, getTableConfig, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { type DB, openDatabase } from './index';
import * as schema from './schema';

const BATCH = 500;

/** Every table in the schema module, parents before the tables that reference them. */
export const copyTables: PgTable[] = (() => {
  const rest = (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable);
  const ordered: PgTable[] = [];
  while (rest.length) {
    const i = rest.findIndex((t) =>
      getTableConfig(t).foreignKeys.every((fk) => {
        const parent = fk.reference().foreignTable;
        return parent === t || ordered.includes(parent as PgTable);
      }),
    );
    if (i < 0) throw new Error('copy: foreign keys form a cycle');
    ordered.push(...rest.splice(i, 1));
  }
  return ordered;
})();

const nameOf = (t: PgTable) => getTableConfig(t).name;

function keyColumns(t: PgTable): AnyPgColumn[] {
  const cfg = getTableConfig(t);
  const single = cfg.columns.filter((c) => c.primary);
  if (single.length) return single;
  return cfg.primaryKeys.flatMap((pk) => pk.columns);
}

/** Every serial/bigserial column, whose sequence must continue after the copied rows. */
export const sequenceColumns = copyTables.flatMap((t) =>
  getTableConfig(t)
    .columns.filter((c) => c.columnType.startsWith('PgSerial') || c.columnType.startsWith('PgBigSerial'))
    .map((c) => ({ table: nameOf(t), column: c.name })),
);

async function rowCount(db: DB, t: PgTable): Promise<number> {
  const [r] = await db.select({ n: count() }).from(t);
  return Number(r.n);
}

/** Copies every row of every table from `from` into the empty `to`, in one transaction. Returns the rows copied. */
export async function copyDatabase(from: DB, to: DB, log: (line: string) => void): Promise<number> {
  for (const t of copyTables) {
    if ((await rowCount(to, t)) > 0) throw new Error(`destination is not empty: table ${nameOf(t)} has rows; db:copy only fills an empty database`);
  }
  let total = 0;
  await to.transaction(async (tx) => {
    for (const t of copyTables) {
      const name = nameOf(t);
      const order = keyColumns(t).map((c) => asc(c));
      let copied = 0;
      try {
        for (;;) {
          const rows = (await from.select().from(t).orderBy(...order).limit(BATCH).offset(copied)) as Record<string, unknown>[];
          if (!rows.length) break;
          // Rows pass through JS: timestamps are cut to milliseconds (defaultNow() columns such as
          // identities.created_at hold microseconds, which changes no behaviour here), and a JSON null
          // in a jsonb column becomes SQL NULL.
          await tx.insert(t).values(rows);
          copied += rows.length;
          if (rows.length < BATCH) break;
        }
      } catch (e) {
        // Drizzle's own message carries the SQL and every parameter (password hashes, emails, IPs); the cause has the real reason.
        throw new Error(`table ${name}: ${e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
      const sourceCount = await rowCount(from, t);
      const destCount = await rowCount(tx as unknown as DB, t);
      if (destCount !== sourceCount) throw new Error(`table ${name}: copied ${destCount} rows, source has ${sourceCount}`);
      for (const { column } of sequenceColumns.filter((c) => c.table === name)) {
        await tx.execute(
          sql.raw(`select setval(pg_get_serial_sequence('${name}','${column}'), coalesce(max(${column}),1), max(${column}) is not null) from ${name}`),
        );
      }
      log(`${name} ${sourceCount} → ${destCount}`);
      total += destCount;
    }
  });
  if (total === 0) log('warning: the source has no rows at all');
  log(`copied ${total} rows`);
  return total;
}

// pglite: paths are relative to the repo root, wherever the command runs from.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const absolute = (url: string) => (url.startsWith('pglite:') && url !== 'pglite:memory' ? `pglite:${resolve(root, url.slice('pglite:'.length))}` : url);

if (import.meta.main) {
  const [fromUrl, toUrl] = process.argv.slice(2);
  if (!fromUrl || !toUrl) {
    console.error('Usage: bun run db:copy <from-url> <to-url>   (postgres://…, pglite:<dir>, pglite:memory)');
    process.exit(1);
  }
  if (absolute(fromUrl) === absolute(toUrl)) {
    console.error('db:copy: source and destination are the same database.');
    process.exit(1);
  }
  const fromPath = absolute(fromUrl);
  if (fromPath.startsWith('pglite:') && fromPath !== 'pglite:memory' && !existsSync(fromPath.slice('pglite:'.length))) {
    console.error(`db:copy: source ${fromPath.slice('pglite:'.length)} does not exist.`);
    process.exit(1);
  }
  const from = await openDatabase(fromPath);
  const to = await openDatabase(absolute(toUrl));
  let code = 0;
  try {
    await copyDatabase(from.db, to.db, console.log);
  } catch (e) {
    console.error(`db:copy failed: ${e instanceof Error ? e.message : e}`);
    code = 1;
  } finally {
    await from.close();
    await to.close();
  }
  process.exit(code);
}

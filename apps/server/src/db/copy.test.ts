import { afterAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { testDatabaseUrl } from '../lib/testing';
import { copyDatabase, copyTables, sequenceColumns } from './copy';
import { type Database, openDatabase } from './index';
import * as schema from './schema';

const opened: Database[] = [];
const open = async (url: string) => {
  const d = await openDatabase(url);
  opened.push(d);
  return d;
};
afterAll(async () => {
  for (const d of opened) await d.close();
});

const ident = (id: string, handle: string) => ({
  id,
  handle,
  handleLower: handle.toLowerCase(),
  kind: 'human' as const,
  secretHash: `hash-${id}`,
  color: '#ffb347',
});
const at = new Date('2026-03-04T05:06:07.891Z');

async function populate(db: Database['db']) {
  await db.insert(schema.identities).values([ident('a', 'Ann'), ident('b', 'Bob')]);
  await db.insert(schema.matches).values({
    id: 'm1', gameId: 'crown-and-steel', status: 'over', seed: 7, season: '2026-03', rated: true,
    outcome: { winner: 'a', scores: { a: 1, b: 0 }, nested: [1, 'two', null] }, createdAt: at, endedAt: at,
  });
  await db.insert(schema.matchPlayers).values([
    { matchId: 'm1', seat: 'red', identityId: 'a', kind: 'human', result: 'win' },
    { matchId: 'm1', seat: 'black', identityId: 'b', kind: 'human', result: 'loss' },
  ]);
  await db.insert(schema.messages).values([
    { channel: 'lobby', authorId: 'a', text: 'hello', createdAt: at },
    { channel: 'lobby', authorId: 'b', text: 'héllo "quoted"', createdAt: at },
  ]);
  await db.insert(schema.sanctions).values({ identityId: 'b', kind: 'mute', reason: 'spam', createdAt: at });
}

describe('copyTables', () => {
  test('lists every table in the schema, parents before dependents', () => {
    const all = Object.values(schema).filter((v) => v instanceof PgTable);
    expect(copyTables.length).toBe(all.length);
    for (const t of all) expect(copyTables).toContain(t as never);
    const pos = new Map<unknown, number>(copyTables.map((t, i) => [t, i]));
    for (const t of copyTables) {
      for (const fk of getTableConfig(t).foreignKeys) {
        expect(pos.get(fk.reference().foreignTable)!).toBeLessThan(pos.get(t)!);
      }
    }
  });
});

describe('sequenceColumns', () => {
  test('covers every serial and bigserial column in the schema', () => {
    const found: string[] = [];
    for (const t of Object.values(schema) as unknown[]) {
      if (!(t instanceof PgTable)) continue;
      const cfg = getTableConfig(t);
      for (const c of cfg.columns) if (/^Pg(Big)?Serial/.test(c.columnType)) found.push(`${cfg.name}.${c.name}`);
    }
    expect(found.length).toBeGreaterThan(0);
    expect(sequenceColumns.map((c) => `${c.table}.${c.column}`).sort()).toEqual(found.sort());
  });
});

describe('copyDatabase', () => {
  test('a failing insert names the table and the cause, and never leaks row values', async () => {
    const from = await open('pglite:memory');
    const to = await open('pglite:memory');
    await populate(from.db);
    await to.db.execute(sql.raw(`create function refuse() returns trigger language plpgsql as $$ begin raise exception 'refused by test trigger'; end $$`));
    await to.db.execute(sql.raw('create trigger no_identities before insert on identities for each row execute function refuse()'));
    let message = '';
    await copyDatabase(from.db, to.db, () => {}).catch((e) => (message = e.message));
    expect(message).toContain('table identities');
    expect(message).toContain('refused by test trigger');
    for (const leak of ['hash-a', 'Ann', 'Bob', 'Failed query', 'params']) expect(message).not.toContain(leak);
    expect(await to.db.select().from(schema.identities)).toEqual([]);
  });

  test('copies every row; ids, timestamps and jsonb round-trip; sequences continue after the copy', async () => {
    const from = await open('pglite:memory');
    const to = await open(await testDatabaseUrl());
    await populate(from.db);
    const lines: string[] = [];
    const total = await copyDatabase(from.db, to.db, (l) => lines.push(l));
    expect(total).toBe(2 + 1 + 2 + 2 + 1);
    expect(lines).toContain('identities 2 → 2');
    expect(lines.at(-1)).toBe('copied 8 rows');

    for (const t of copyTables) {
      const sorted = async (db: Database['db']) => (await db.select().from(t)).map((r) => JSON.stringify(r)).sort();
      expect(await sorted(to.db)).toEqual(await sorted(from.db));
    }
    const [m] = await to.db.select().from(schema.matches).where(eq(schema.matches.id, 'm1'));
    expect(m.createdAt.getTime()).toBe(at.getTime());
    expect(m.outcome).toEqual({ winner: 'a', scores: { a: 1, b: 0 }, nested: [1, 'two', null] });

    const [added] = await to.db.insert(schema.messages).values({ channel: 'lobby', text: 'new' }).returning();
    const copiedMax = Math.max(...(await from.db.select().from(schema.messages)).map((r) => r.id));
    expect(added.id).toBeGreaterThan(copiedMax);
    const [s] = await to.db.insert(schema.sanctions).values({ identityId: 'a', kind: 'mute', reason: 'x' }).returning();
    expect(s.id).toBeGreaterThan(1);
  });

  test('an empty source into an empty destination copies 0 rows and leaves sequences usable', async () => {
    const from = await open('pglite:memory');
    const to = await open('pglite:memory');
    expect(await copyDatabase(from.db, to.db, () => {})).toBe(0);
    const [r] = await to.db.insert(schema.messages).values({ channel: 'lobby', text: 'x' }).returning();
    expect(r.id).toBe(1);
  });

  test('refuses a destination that already has rows, naming the table, and leaves it untouched', async () => {
    const from = await open('pglite:memory');
    const to = await open('pglite:memory');
    await populate(from.db);
    await to.db.insert(schema.messages).values({ channel: 'lobby', text: 'already here' });
    await expect(copyDatabase(from.db, to.db, () => {})).rejects.toThrow(/messages/);
    expect(await to.db.select().from(schema.identities)).toEqual([]);
    expect((await to.db.select().from(schema.messages)).map((r) => r.text)).toEqual(['already here']);
  });

  test('batches of 500 rows', async () => {
    const from = await open('pglite:memory');
    const to = await open('pglite:memory');
    await from.db.insert(schema.messages).values(Array.from({ length: 1203 }, (_, i) => ({ channel: 'lobby', text: `m${i}` })));
    expect(await copyDatabase(from.db, to.db, () => {})).toBe(1203);
    expect((await to.db.select().from(schema.messages)).length).toBe(1203);
  });
});

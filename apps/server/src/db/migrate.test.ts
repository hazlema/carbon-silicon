import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { hashSecret } from '../lib/ids';
import * as schema from './schema';
import { identities, sessions } from './schema';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** A migrations folder holding only 0000_init, i.e. the database as M1 left it. */
function m1Folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cs-m1-'));
  mkdirSync(join(dir, 'meta'));
  copyFileSync(join(MIGRATIONS, '0000_init.sql'), join(dir, '0000_init.sql'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  return dir;
}

const client = new PGlite();
const oldClient = new PGlite();
afterAll(async () => {
  await client.close();
  await oldClient.close();
});

describe('0001_m2a_accounts', () => {
  test("carries every human's browser key into sessions and leaves agents alone", async () => {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: m1Folder() });
    // Raw SQL: the M2a columns don't exist yet, so Drizzle's insert (which lists every column) can't be used.
    await client.query(
      `insert into identities (id, handle, handle_lower, kind, secret_hash, color) values
       ('id_old', 'Oldtimer', 'oldtimer', 'human', '${hashSecret('csk_oldkey')}', '#ffb347'),
       ('id_bot', 'Oldbot', 'oldbot', 'agent', '${hashSecret('cs_oldtoken')}', '#3de0ff')`,
    );

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const carried = await db.select().from(sessions).where(eq(sessions.identityId, 'id_old'));
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ keyHash: hashSecret('csk_oldkey'), label: 'migrated' });
    expect(carried[0].id).toMatch(/^se_[0-9a-f]{16}$/);
    const [human] = await db.select().from(identities).where(eq(identities.id, 'id_old'));
    expect(human.secretHash).toBe('migrated:id_old');
    expect(human.releasedAt).toBeNull();
    const [bot] = await db.select().from(identities).where(eq(identities.id, 'id_bot'));
    expect(bot.secretHash).toBe(hashSecret('cs_oldtoken'));
    expect(await db.select().from(sessions).where(eq(sessions.identityId, 'id_bot'))).toHaveLength(0);
  });
});

describe('0002_m2a_last_seen', () => {
  test("restarts every human's idle clock, since M1 never kept last_seen_at up to date", async () => {
    const db = drizzle(oldClient, { schema });
    await migrate(db, { migrationsFolder: m1Folder() });
    // An M1 guest whose last_seen_at was only ever its creation time, a year ago; and an agent.
    await oldClient.query(
      `insert into identities (id, handle, handle_lower, kind, secret_hash, color, created_at, last_seen_at) values
       ('id_guest', 'Oldguest', 'oldguest', 'human', 'x1', '#ffb347', now() - interval '365 days', now() - interval '365 days'),
       ('id_agent', 'Oldagent', 'oldagent', 'agent', 'x2', '#3de0ff', now() - interval '365 days', now() - interval '365 days')`,
    );

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const dayAgo = Date.now() - 86_400_000;
    const [guest] = await db.select().from(identities).where(eq(identities.id, 'id_guest'));
    expect(guest.lastSeenAt.getTime()).toBeGreaterThan(dayAgo);
    const [agent] = await db.select().from(identities).where(eq(identities.id, 'id_agent'));
    expect(agent.lastSeenAt.getTime()).toBeLessThan(dayAgo);
  });
});

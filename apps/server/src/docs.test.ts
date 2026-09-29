import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createCore } from './core/core';
import { apiIndex } from './http/index-doc';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: null, diaryDir: `${root}diary` });
afterAll(() => core.close());

describe('docs', () => {
  test('API.md documents every endpoint in the index', async () => {
    const doc = await Bun.file(`${root}docs/API.md`).text();
    for (const e of apiIndex(core).endpoints) {
      expect(doc).toContain(`${e.method} ${e.path}`);
    }
  });
  test('llms.txt points at the essentials', async () => {
    const txt = await Bun.file(`${root}docs/llms.txt`).text();
    for (const needle of ['POST /api/agents', 'GET /api/inbox', 'POST /api/quickmatch', '/api/matches/', 'revision', 'POST /api/report', 'SUSPENDED', 'GET /api/users/', 'POST /api/tables', 'invite.received', '/api/invites/', 'rematch']) {
      expect(txt).toContain(needle);
    }
  });
  test("every game's rules file is written", async () => {
    for (const { id } of core.games.catalog()) {
      const { meta } = core.games.module(id);
      expect(await Bun.file(`${root}${meta.rulesPath}`).text()).toStartWith(`# ${meta.name}`);
    }
  });
  test('the diary has at least one entry with a title', () => {
    expect(core.diary.entries.length).toBeGreaterThan(0);
    expect(core.diary.entries[0].title).not.toBe(core.diary.entries[0].slug);
  });
});

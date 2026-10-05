import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { identities } from '../db/schema';
import { FakeClock } from '../lib/clock';
import { waitFor } from '../lib/testing';
import { createCore } from './core';
import { excerpt, parseEntry } from './diary';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir });
afterAll(() => core.close());

describe('parseEntry', () => {
  test('reads frontmatter and body, strips quotes, falls back to the filename', () => {
    expect(parseEntry('2026-01-01-first.md', '---\ntitle: "Hi"\ndate: 2026-01-01\n---\nBody')).toEqual({
      slug: '2026-01-01-first',
      title: 'Hi',
      date: '2026-01-01',
      excerpt: 'Body',
      words: 1,
      markdown: 'Body',
    });
    expect(parseEntry('2026-02-03-bare.md', 'Just text')).toEqual({
      slug: '2026-02-03-bare',
      title: '2026-02-03-bare',
      date: '2026-02-03',
      excerpt: 'Just text',
      words: 2,
      markdown: 'Just text',
    });
  });
  test('the excerpt is the opening paragraph in plain words, cut at a word when it runs long', () => {
    expect(excerpt('## A heading\n\n> a quote\n\nThe **first** [real](/x) paragraph,\nwith `code`.\n\nThe second.')).toBe('The first real paragraph, with code.');
    const long = excerpt(`${'word '.repeat(80)}end.`);
    expect(long.length).toBeLessThanOrEqual(241);
    expect(long.endsWith('word…')).toBe(true);
    expect(excerpt('## Only a heading')).toBe('');
  });
});

describe('createCore', () => {
  test('loads the diary newest-first and announces each entry once', async () => {
    expect(core.diary.summaries().map((e) => e.slug)).toEqual(['2026-01-02-second', '2026-01-01-first']);
    expect(core.diary.get('2026-01-01-first')?.markdown).toContain('**first**');
    const history = await core.comms.history('diary');
    expect(history.map((m) => m.text)).toEqual([
      'New diary entry — "The first entry" /diary/2026-01-01-first',
      'New diary entry — "The second entry" /diary/2026-01-02-second',
    ]);
    expect(await core.diary.announce(core.comms)).toBe(0);
  });
  test('a new entry is announced in #diary (the record) and in #lobby (where people are)', async () => {
    const lobby = (await core.comms.history('lobby', { limit: 50 })).filter((m) => m.system).map((m) => m.text);
    expect(lobby).toContain('New diary entry: "The first entry" /diary/2026-01-01-first');
    expect(lobby).toContain('New diary entry: "The second entry" /diary/2026-01-02-second');
    expect(await core.diary.announce(core.comms)).toBe(0);
    expect((await core.comms.history('lobby', { limit: 50 })).filter((m) => m.system).map((m) => m.text)).toEqual(lobby);
  });
  test('the catalog has Critical Mass, Lightline, Crown & Steel and Salvo', () => {
    expect(core.games.catalog().map((g) => g.id)).toEqual(['critical-mass', 'lightline', 'checkers', 'salvo']);
  });
});

describe('the idle sweep', () => {
  test('runs on its timer and stops when the core closes', async () => {
    const clock = new FakeClock(Date.now());
    const swept = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: null, diaryDir, clock, sweepEveryMs: 1000 });
    try {
      const { identity } = await swept.identities.createHuman('Driftwood');
      await swept.database.db
        .update(identities)
        .set({ lastSeenAt: new Date(clock.now() - 31 * 86_400_000) })
        .where(eq(identities.id, identity.id));
      clock.advance(1000);
      await waitFor(async () => (await swept.identities.row(identity.id))!.releasedAt !== null);
    } finally {
      await swept.close();
    }
    expect(clock.pending()).toBe(0);
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createCore } from './core';
import { parseEntry } from './diary';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', diaryDir });
afterAll(() => core.close());

describe('parseEntry', () => {
  test('reads frontmatter and body, strips quotes, falls back to the filename', () => {
    expect(parseEntry('2026-01-01-first.md', '---\ntitle: "Hi"\ndate: 2026-01-01\n---\nBody')).toEqual({
      slug: '2026-01-01-first',
      title: 'Hi',
      date: '2026-01-01',
      markdown: 'Body',
    });
    expect(parseEntry('2026-02-03-bare.md', 'Just text')).toEqual({
      slug: '2026-02-03-bare',
      title: '2026-02-03-bare',
      date: '2026-02-03',
      markdown: 'Just text',
    });
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
  test('the catalog has Critical Mass', () => {
    expect(core.games.catalog().map((g) => g.id)).toEqual(['critical-mass']);
  });
});

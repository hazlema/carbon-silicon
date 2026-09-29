import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveText } from './live-text';

const dir = await mkdtemp(join(tmpdir(), 'live-text-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('LiveText', () => {
  test('serves the fallback until the file appears, then follows edits', async () => {
    const path = join(dir, 'rules.md');
    let now = 0;
    const text = new LiveText({ path, fallback: 'not written yet', minCheckMs: 1000, now: () => now });
    expect(await text.get()).toBe('not written yet');

    await Bun.write(path, '# One');
    expect(await text.get()).toBe('not written yet'); // checked less than a second ago
    now += 1000;
    expect(await text.get()).toBe('# One');

    await Bun.write(path, '# Two');
    await utimes(path, new Date(), new Date(Date.now() + 5000)); // make sure the mtime moves
    now += 1000;
    expect(await text.get()).toBe('# Two');
  });

  test('keeps the last good text while the file is missing (an editor mid-save)', async () => {
    const path = join(dir, 'docs.md');
    let now = 0;
    await Bun.write(path, '# Kept');
    const text = new LiveText({ path, fallback: 'fallback', minCheckMs: 1000, now: () => now });
    expect(await text.get()).toBe('# Kept');
    await unlink(path);
    now += 1000;
    expect(await text.get()).toBe('# Kept');
  });

  test('a blank save keeps the last good text too', async () => {
    const path = join(dir, 'prompt.md');
    let now = 0;
    await Bun.write(path, 'Stay in character.');
    const text = new LiveText({ path, fallback: '', minCheckMs: 1000, now: () => now });
    expect(await text.get()).toBe('Stay in character.');
    await Bun.write(path, '  \n');
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    now += 1000;
    expect(await text.get()).toBe('Stay in character.');
  });
});

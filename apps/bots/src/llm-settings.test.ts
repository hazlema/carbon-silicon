import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionFor, EnvSettings, settingsFromEnv, type LlmSettings } from './llm-settings';

const base: LlmSettings = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'google/gemma-4-e2b', apiKey: null, temperature: 0.9, bouncerModel: null };
const dir = await mkdtemp(join(tmpdir(), 'cs-llm-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('settingsFromEnv', () => {
  test('defaults to the local LM Studio and gemma', () => {
    expect(settingsFromEnv({})).toEqual(base);
  });
  test('reads every variable', () => {
    const s = settingsFromEnv({
      LLM_BASE_URL: ' https://openrouter.ai/api/v1 ',
      LLM_MODEL: 'google/gemma-4-31b-it:free',
      LLM_API_KEY: 'sk-or-x',
      LLM_TEMPERATURE: '0.5',
      BOUNCER_MODEL: 'nvidia/nemotron-3.5-content-safety:free',
    });
    expect(s).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemma-4-31b-it:free',
      apiKey: 'sk-or-x',
      temperature: 0.5,
      bouncerModel: 'nvidia/nemotron-3.5-content-safety:free',
    });
  });
  test('a nonsense temperature falls back to 0.9', () => {
    expect(settingsFromEnv({ LLM_TEMPERATURE: 'hot' }).temperature).toBe(0.9);
  });
});

describe('connectionFor', () => {
  test('the bouncer uses its own model when set, else the shared one', () => {
    expect(connectionFor(base, 'bouncer')?.model).toBe('google/gemma-4-e2b');
    expect(connectionFor({ ...base, bouncerModel: 'safety' }, 'bouncer')?.model).toBe('safety');
    expect(connectionFor({ ...base, bouncerModel: 'safety' }, 'voice')?.model).toBe('google/gemma-4-e2b');
  });
  test('baseUrl "off" switches the model off', () => {
    expect(connectionFor({ ...base, baseUrl: 'OFF' }, 'voice')).toBeNull();
  });
});

describe('EnvSettings', () => {
  const touch = (path: string, text: string, ahead: number) => Bun.write(path, text).then(() => utimes(path, new Date(), new Date(Date.now() + ahead)));

  test('starts from the environment, follows .env edits after minCheckMs, and not sooner', async () => {
    const path = join(dir, 'a.env');
    const logs: string[] = [];
    let now = 0;
    const s = new EnvSettings({ path, env: { LLM_MODEL: 'env-model' }, log: (m) => logs.push(m), minCheckMs: 1000, now: () => now });
    expect((await s.get()).model).toBe('env-model');

    await touch(path, 'LLM_MODEL=a:free\n', 1000);
    expect((await s.get()).model).toBe('env-model'); // checked less than a second ago
    now += 1000;
    expect((await s.get()).model).toBe('a:free');
    expect(logs.some((l) => l.startsWith('settings: ') && l.includes('a:free'))).toBe(true);

    await touch(path, 'LLM_MODEL=b:free\n', 5000);
    now += 999;
    expect((await s.get()).model).toBe('a:free');
    now += 1;
    expect((await s.get()).model).toBe('b:free');
  });

  test('a value the file does not set falls back to the environment; the file wins when it does', async () => {
    const path = join(dir, 'b.env');
    await Bun.write(path, 'LLM_MODEL=file-model\n');
    const s = new EnvSettings({ path, env: { LLM_MODEL: 'env-model', LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1' }, log: () => {}, now: () => 0 });
    const got = await s.get();
    expect(got.model).toBe('file-model');
    expect(got.apiKey).toBe('k');
    expect(got.baseUrl).toBe('http://x/v1');
  });

  test('file removed: back to the environment', async () => {
    const path = join(dir, 'c.env');
    await Bun.write(path, 'LLM_MODEL=file-model\n');
    let now = 0;
    const logs: string[] = [];
    const s = new EnvSettings({ path, env: { LLM_MODEL: 'env-model' }, log: (m) => logs.push(m), minCheckMs: 10, now: () => now });
    expect((await s.get()).model).toBe('file-model');
    await rm(path);
    now += 10;
    expect((await s.get()).model).toBe('env-model');
    expect(logs.some((l) => l.includes('gone'))).toBe(true);
  });

  test('an unreadable file is reported once and the last good settings stay', async () => {
    const path = join(dir, 'd.env');
    await Bun.write(path, 'LLM_MODEL=good\n');
    let now = 0;
    const logs: string[] = [];
    const s = new EnvSettings({ path, env: {}, log: (m) => logs.push(m), minCheckMs: 10, now: () => now });
    expect((await s.get()).model).toBe('good');
    await rm(path);
    await mkdir(path); // a directory where the file was: stat works, reading fails
    now += 10;
    expect((await s.get()).model).toBe('good');
    now += 10;
    expect((await s.get()).model).toBe('good');
    expect(logs.filter((l) => l.includes('ignored'))).toHaveLength(1);
  });
});

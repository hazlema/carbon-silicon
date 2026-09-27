import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionFor, parseSettings, SettingsFile, settingsFromEnv, type LlmSettings } from './llm-settings';

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

describe('parseSettings', () => {
  test('fields in the file override the base; missing ones keep it', () => {
    expect(parseSettings('{"model": "qwen/qwen3.8-27b:free", "apiKey": "k"}', base)).toEqual({ ...base, model: 'qwen/qwen3.8-27b:free', apiKey: 'k' });
  });
  test('null clears the key and the bouncer model', () => {
    expect(parseSettings('{"apiKey": null, "bouncerModel": null}', { ...base, apiKey: 'k', bouncerModel: 'b' })).toEqual(base);
  });
  test('bad files explain themselves', () => {
    expect(() => parseSettings('{nope', base)).toThrow(/JSON/);
    expect(() => parseSettings('[]', base)).toThrow(/object/);
    expect(() => parseSettings('{"model": ""}', base)).toThrow(/model/);
    expect(() => parseSettings('{"temperature": 3}', base)).toThrow(/temperature/);
    expect(() => parseSettings('{"apiKey": 7}', base)).toThrow(/apiKey/);
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

describe('SettingsFile', () => {
  test('uses the base until the file appears, then follows edits, and keeps the last good settings on a bad edit', async () => {
    const path = join(dir, 'llm.json');
    const logs: string[] = [];
    let now = 0;
    const file = new SettingsFile({ path, base, log: (m) => logs.push(m), minCheckMs: 1000, now: () => now });
    expect(await file.get()).toEqual(base);

    await Bun.write(path, '{"model": "a:free"}');
    expect((await file.get()).model).toBe('google/gemma-4-e2b'); // checked less than a second ago
    now += 1000;
    expect((await file.get()).model).toBe('a:free');

    await Bun.write(path, '{"model": "b:free"}');
    await utimes(path, new Date(), new Date(Date.now() + 5000)); // make sure the mtime moves
    now += 1000;
    expect((await file.get()).model).toBe('b:free');

    await Bun.write(path, '{"model": ');
    await utimes(path, new Date(), new Date(Date.now() + 10_000));
    now += 1000;
    expect((await file.get()).model).toBe('b:free');
    now += 1000;
    await file.get();
    expect(logs.filter((l) => l.includes('ignored'))).toHaveLength(1); // one complaint per bad edit
    expect(logs.some((l) => l.includes('b:free'))).toBe(true);
  });
});

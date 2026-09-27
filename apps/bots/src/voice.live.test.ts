import { expect, test } from 'bun:test';
import { oldIron } from './personalities/old-iron';
import { LlmVoice } from './voice';

// Talks to a real local model when one is running (LM Studio on :1234); skipped otherwise.
const BASE = process.env.LLM_LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LLM_MODEL ?? 'google/gemma-4-e2b';

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: { id: string }[] };
    return Array.isArray(body.data) && body.data.some((m) => m.id === MODEL);
  } catch {
    return false;
  }
}

const available = await probe();

test.skipIf(!available)('a real model answers a mention in character, in one short line', async () => {
  const logs: string[] = [];
  const voice = new LlmVoice({ baseUrl: BASE, model: MODEL, persona: oldIron.persona!, name: oldIron.name, log: (m) => logs.push(m) });
  const line = await voice.say({
    kind: 'mention',
    channel: 'lobby',
    addressedBy: 'frosty',
    recent: [{ author: 'frosty', kind: 'human', text: 'hey @OLD_IRON, are you any good at Critical Mass?' }],
  });
  expect(logs).toEqual([]);
  expect(typeof line).toBe('string');
  expect(line!.length).toBeGreaterThan(0);
  expect(line!.length).toBeLessThanOrEqual(220);
}, 30_000);

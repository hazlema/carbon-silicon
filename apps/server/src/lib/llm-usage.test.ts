import { describe, expect, test } from 'bun:test';
import { FakeClock } from './clock';
import { LlmUsage } from './llm-usage';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const KEY = 'sk-or-v1-secret';
const keyReply = {
  data: {
    label: 'sk-or-v1-sec…',
    limit: 20,
    limit_remaining: 19.5,
    usage: 25.688261287,
    usage_daily: 0.1240739,
    usage_weekly: 0.157604235,
    usage_monthly: 0.14702818,
    free_model_daily_requests: { used: 3, limit: 1000, remaining: 997 },
  },
};

function fakeFetch(reply: () => Response) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return reply();
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const ok = () => new Response(JSON.stringify(keyReply), { status: 200, headers: { 'content-type': 'application/json' } });

describe('LlmUsage', () => {
  test("reads the key's spend from OpenRouter: today, this week, this month, all time, the limit and free requests", async () => {
    const clock = new FakeClock(Date.parse('2026-10-02T12:00:00Z'));
    const { calls, fetchImpl } = fakeFetch(ok);
    const usage = new LlmUsage({ settings: async () => ({ baseUrl: `${OPENROUTER}/`, apiKey: KEY }), fetchImpl, clock });
    const report = await usage.get();
    expect(report).toEqual({
      status: 'ok',
      today: 0.1240739,
      week: 0.157604235,
      month: 0.14702818,
      total: 25.688261287,
      limit: 20,
      limitRemaining: 19.5,
      freeRequests: { used: 3, limit: 1000 },
      checkedAt: '2026-10-02T12:00:00.000Z',
    });
    expect(calls).toEqual([{ url: `${OPENROUTER}/key`, auth: `Bearer ${KEY}` }]);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  test('asks OpenRouter at most once a minute', async () => {
    const clock = new FakeClock(Date.parse('2026-10-02T12:00:00Z'));
    const { calls, fetchImpl } = fakeFetch(ok);
    const usage = new LlmUsage({ settings: async () => ({ baseUrl: OPENROUTER, apiKey: KEY }), fetchImpl, clock });
    await usage.get();
    clock.advance(59_000);
    await usage.get();
    expect(calls).toHaveLength(1);
    clock.advance(2_000);
    await usage.get();
    expect(calls).toHaveLength(2);
  });

  test('says plainly when there is no key, the voice is not on OpenRouter, or OpenRouter does not answer', async () => {
    const clock = new FakeClock(0);
    const none = new LlmUsage({ settings: async () => null, fetchImpl: fakeFetch(ok).fetchImpl, clock });
    expect(await none.get()).toEqual({ status: 'unconfigured', message: 'No OpenRouter key configured (.env).' });
    const local = new LlmUsage({ settings: async () => ({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: null }), fetchImpl: fakeFetch(ok).fetchImpl, clock });
    expect(await local.get()).toEqual({ status: 'unconfigured', message: 'The voice runs on http://127.0.0.1:1234/v1, not OpenRouter: no usage to show.' });
    const down = new LlmUsage({ settings: async () => ({ baseUrl: OPENROUTER, apiKey: KEY }), fetchImpl: fakeFetch(() => new Response('nope', { status: 401 })).fetchImpl, clock });
    expect(await down.get()).toEqual({ status: 'unavailable', message: "OpenRouter didn't answer (HTTP 401)." });
    const broken = new LlmUsage({
      settings: async () => ({ baseUrl: OPENROUTER, apiKey: KEY }),
      fetchImpl: (async () => {
        throw new Error(`connect failed for ${KEY}`);
      }) as unknown as typeof fetch,
      clock,
    });
    const r = await broken.get();
    expect(r).toEqual({ status: 'unavailable', message: "OpenRouter didn't answer (network error)." });
  });
});

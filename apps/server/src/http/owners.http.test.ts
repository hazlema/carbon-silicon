import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ProfilePage } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { randomTag } from '../lib/testing';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
const app = createApp(core, { apiDocs: '', llmsTxt: '', trustProxy: true });
afterAll(() => core.close());

let ipCounter = 0;
async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? `10.3.0.${++ipCounter % 250}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}
async function lockedHuman() {
  const joined = await call('POST', '/api/session', { body: { handle: `own${randomTag()}` } });
  const cookie = (joined.headers.get('set-cookie') ?? '').split(';')[0];
  expect((await call('POST', '/api/me/lock', { cookie, body: { password: 'correct horse battery' } })).status).toBe(200);
  return { cookie, handle: joined.data.identity.handle as string };
}
async function agent() {
  const r = await call('POST', '/api/agents', { body: { name: `bot${randomTag()}` } });
  return { token: r.data.token as string, handle: r.data.identity.handle as string };
}

describe('owner links over HTTP', () => {
  test('link by token, see it on both profiles, and the agent lets go', async () => {
    const human = await lockedHuman();
    const bot = await agent();
    const linked = await call('POST', '/api/me/agents', { cookie: human.cookie, body: { token: bot.token } });
    expect(linked.status).toBe(201);
    expect(linked.data.agent.identity.ownerHandle).toBe(human.handle);
    expect((await call('GET', '/api/me/agents', { cookie: human.cookie })).data.agents).toHaveLength(1);

    const ownerPage = (await call('GET', `/api/users/${human.handle}`)).data as ProfilePage;
    expect(ownerPage.agents.map((a) => a.identity.handle)).toEqual([bot.handle]);
    const botPage = (await call('GET', `/api/users/${bot.handle}`)).data as ProfilePage;
    expect(botPage.identity.ownerHandle).toBe(human.handle);
    expect(botPage.agents).toEqual([]);

    const dropped = await call('DELETE', '/api/me/owner', { token: bot.token });
    expect(dropped.data.identity.ownerHandle).toBeNull();
    expect((await call('DELETE', '/api/me/owner', { token: bot.token })).data.error.code).toBe('NO_OWNER');
  });

  test('unlinking someone else\'s agent is refused', async () => {
    const [human, stranger] = [await lockedHuman(), await lockedHuman()];
    const bot = await agent();
    await call('POST', '/api/me/agents', { cookie: human.cookie, body: { token: bot.token } });
    const r = await call('DELETE', `/api/me/agents/${bot.handle}`, { cookie: stranger.cookie });
    expect([r.status, r.data.error.code]).toEqual([403, 'NOT_YOURS']);
    expect((await call('DELETE', `/api/me/agents/${bot.handle}`, { cookie: human.cookie })).data.agents).toEqual([]);
  });

  test('wrong tokens are limited to 5 per person per 15 minutes', async () => {
    const human = await lockedHuman();
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/me/agents', { cookie: human.cookie, body: { token: `cs_wrong${i}` } });
      expect(r.data.error.code).toBe('BAD_TOKEN');
    }
    const sixth = await call('POST', '/api/me/agents', { cookie: human.cookie, body: { token: 'cs_wrong6' } });
    expect([sixth.status, sixth.data.error.code]).toEqual([429, 'SLOW_DOWN']);
    expect(sixth.data.error.message).toBe('Too many wrong tokens. Try again in a few minutes.');
  });
});

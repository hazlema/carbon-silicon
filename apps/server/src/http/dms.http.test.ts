import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dmChannel, type ChatMessage, type InboxEvent } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { randomTag } from '../lib/testing';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
const app = createApp(core, { apiDocs: '', llmsTxt: '', trustProxy: true });
afterAll(() => core.close());

let ip = 0;
async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.2.0.${++ip % 250}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}
async function agent(prefix: string) {
  const r = await call('POST', '/api/agents', { body: { name: `${prefix}${randomTag()}` } });
  expect(r.status).toBe(201);
  return { token: r.data.token as string, id: r.data.identity.id as string, handle: r.data.identity.handle as string };
}

describe('direct messages over HTTP', () => {
  test('an agent writes to another by handle; the other lists, reads, marks read and closes it', async () => {
    const [a, b] = [await agent('dma'), await agent('dmb')];
    const sent = await call('POST', `/api/dms/${b.handle}`, { token: a.token, body: { text: 'hello there' } });
    expect(sent.status).toBe(201);
    expect(sent.data.message.channel).toBe(dmChannel(a.id, b.id));

    const inbox = await call('GET', '/api/inbox?since=0&waitMs=0', { token: b.token });
    expect((inbox.data.events as InboxEvent[]).some((e) => e.type === 'chat.dm' && e.message.text === 'hello there')).toBe(true);

    const list = await call('GET', '/api/dms', { token: b.token });
    expect(list.data.conversations).toMatchObject([{ with: { handle: a.handle }, unread: 1, hidden: false }]);
    const convo = await call('GET', `/api/dms/@${a.handle}`, { token: b.token });
    expect(convo.data.with.handle).toBe(a.handle);
    expect((convo.data.messages as ChatMessage[]).map((m) => m.text)).toEqual(['hello there']);

    expect((await call('POST', `/api/dms/${a.handle}/read`, { token: b.token })).data.conversation.unread).toBe(0);
    expect((await call('POST', `/api/dms/${a.handle}/close`, { token: b.token })).data.conversation.hidden).toBe(true);
    // The generic chat routes work for the two people too.
    expect((await call('GET', `/api/chat/${dmChannel(a.id, b.id)}`, { token: a.token })).status).toBe(200);
    expect((await call('POST', `/api/chat/${dmChannel(a.id, b.id)}`, { token: b.token, body: { text: 'hi back' } })).status).toBe(201);
  });

  test('nobody else can read it, and the errors say why', async () => {
    const [a, b, c] = [await agent('dmx'), await agent('dmy'), await agent('dmz')];
    await call('POST', `/api/dms/${b.handle}`, { token: a.token, body: { text: 'secret' } });
    const ch = dmChannel(a.id, b.id);
    const nosy = await call('GET', `/api/chat/${ch}`, { token: c.token });
    expect([nosy.status, nosy.data.error.code]).toEqual([403, 'NOT_YOURS']);
    expect((await call('GET', `/api/chat/${ch}`)).status).toBe(403);
    expect((await call('POST', `/api/dms/${a.handle}`, { token: a.token, body: { text: 'me' } })).data.error.code).toBe('SELF');
    expect((await call('POST', `/api/dms/nobody${randomTag()}`, { token: a.token, body: { text: 'hi' } })).status).toBe(404);
    expect((await call('GET', '/api/dms')).status).toBe(401);
    expect((await call('GET', `/api/dms/${b.handle}?before=soon`, { token: a.token })).data.error.code).toBe('BAD_QUERY');
  });

  test('the API index lists the DM routes', async () => {
    const paths = ((await call('GET', '/api')).data.endpoints as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['/api/dms', '/api/dms/:handle', '/api/dms/:handle/read', '/api/dms/:handle/close']));
  });
});

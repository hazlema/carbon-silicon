import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { WsServerMsg } from '@cs/shared/protocol';
import { createCore } from './core/core';
import { createApp } from './http/app';
import { randomTag, waitFor } from './lib/testing';
import { startServer } from './server';

const fixture = (p: string) => fileURLToPath(new URL(`./__fixtures__/${p}`, import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: fixture('diary'), countdownMs: 0 });
const running = startServer(core, createApp(core, { apiDocs: '# docs', llmsTxt: 'llms' }), {
  port: 0,
  hostname: '127.0.0.1',
  webDir: fixture('web'),
  allowedOrigins: ['http://allowed.example'],
});
afterAll(async () => {
  await running.stop();
  await core.close();
});
const base = running.url;
const tag = () => randomTag();

async function human() {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: `web${tag()}` }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const { identity } = (await res.json()) as any;
  return { cookie, identity };
}

function connect(cookie: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie } });
  const got: WsServerMsg[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket error'));
  });
  return { ws, got, opened, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe('static files', () => {
  test('serves files, falls back to index.html for SPA routes, never escapes the web dir', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('fixture index');
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toContain('fixture asset');
    expect(await (await fetch(`${base}/play/m_123`)).text()).toContain('fixture index');
    expect(await (await fetch(`${base}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain('fixture index');
    expect((await fetch(`${base}/api`)).status).toBe(200);
  });

  test('the page shell points agents at /llms.txt with a Link header; files do not', async () => {
    const shell = await fetch(`${base}/`);
    expect(shell.headers.get('link')).toBe('</llms.txt>; rel="alternate"; type="text/plain"; title="Agent quick start"');
    expect((await fetch(`${base}/play/m_123`)).headers.get('link')).toContain('</llms.txt>');
    expect((await fetch(`${base}/assets/app.js`)).headers.get('link')).toBeNull();
  });
});

describe('websocket door', () => {
  test('refuses strangers and foreign origins', async () => {
    expect((await fetch(`${base}/ws`)).status).toBe(401);
    const { cookie } = await human();
    expect((await fetch(`${base}/ws`, { headers: { cookie, origin: 'http://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/ws`, { headers: { cookie, origin: 'http://allowed.example' } })).status).toBe(426);
  });

  test('hello, presence, chat, inbox and match updates all arrive', async () => {
    const me = await human();
    const client = connect(me.cookie);
    await client.opened;
    await waitFor(() => client.got.some((m) => m.type === 'hello'));
    const hello = client.got.find((m) => m.type === 'hello') as Extract<WsServerMsg, { type: 'hello' }>;
    expect(hello.identity.id).toBe(me.identity.id);
    expect(hello.presence.some((p) => p.identity.id === me.identity.id)).toBe(true);

    client.send({ type: 'subscribe', channel: 'lobby' });
    client.send({ type: 'ping' });
    await waitFor(() => client.got.some((m) => m.type === 'pong'));
    await fetch(`${base}/api/chat/lobby`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: me.cookie },
      body: JSON.stringify({ text: 'hello from the web' }),
    });
    await waitFor(() => client.got.some((m) => m.type === 'chat' && m.message.text === 'hello from the web'));

    const reg = (await (
      await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `sock${tag()}` }),
      })
    ).json()) as any;
    await waitFor(() => client.got.some((m) => m.type === 'presence' && m.presence.identity.id === reg.identity.id));

    await fetch(`${base}/api/chat/lobby`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ text: `@${me.identity.handle} fancy a game?` }),
    });
    await waitFor(() => client.got.some((m) => m.type === 'inbox' && m.event.type === 'chat.mention'));

    const match = await core.games.createMatch('critical-mass', [me.identity, reg.identity]);
    await waitFor(() => client.got.some((m) => m.type === 'inbox' && m.event.type === 'match.started'));
    client.send({ type: 'watch', matchId: match.id });
    await waitFor(() => client.got.some((m) => m.type === 'match' && m.envelope.match.status === 'live'));
    const pushed = client.got.filter((m) => m.type === 'match').at(-1) as Extract<WsServerMsg, { type: 'match' }>;
    expect(pushed.envelope.you).toBe('red');
    expect(pushed.envelope.legal.length).toBeGreaterThan(0);
    client.ws.close();
  });
});

describe('http door', () => {
  // Bun.serve closes a connection that has been silent for `idleTimeout` seconds (default 10).
  // The documented agent long-poll waits up to 30 s, so the server must outlast that.
  test('a long-poll past ten seconds completes instead of being cut off', async () => {
    const reg = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `poll${tag()}` }),
    });
    const { token } = (await reg.json()) as any;
    const auth = { authorization: `Bearer ${token}` };
    const first = (await (await fetch(`${base}/api/inbox?waitMs=0`, { headers: auth })).json()) as any;
    const started = performance.now();
    const res = await fetch(`${base}/api/inbox?since=${first.cursor}&waitMs=15000`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).events).toEqual([]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(14_900);
  }, 25_000);
});

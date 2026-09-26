import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { runBot } from './bot';
import { Client } from './client';
import { sprocket } from './personalities/sprocket';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: [], diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
const running = startServer(core, createApp(core, { apiDocs: '', llmsTxt: '' }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const controller = new AbortController();
const tokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
const botDone = runBot({ base: running.url, personality: sprocket, houseKey: 'hk', tokenFile, thinkMs: [0, 0], pollWaitMs: 500, signal: controller.signal, log: () => {} });

afterAll(async () => {
  controller.abort();
  await botDone;
  await running.stop();
  await core.close();
});

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error('timed out');
}

describe('Sprocket', () => {
  test('shows up, gets matched by quick match, plays to the end, and talks', async () => {
    const guest = new Client(running.url);
    await until(async () => (await guest.call<{ presence: { identity: { handle: string; isHouse: boolean } }[] }>('GET', '/api/who')).presence.find((p) => p.identity.handle === 'Sprocket' && p.identity.isHouse));
    const reg = await guest.register({ name: `challenger${Math.random().toString(36).slice(2, 7)}` });
    guest.token = reg.token;
    expect((await guest.quickMatch('critical-mass')).status).toBe('queued');
    const matchId = await until(async () => (await guest.me()).activeMatch);
    let env = await guest.match(matchId);
    expect(env.match.seats.map((s) => s.identity.handle)).toContain('Sprocket');
    while (env.match.status !== 'over') {
      if (env.match.status === 'live' && env.legal.length > 0) {
        try {
          env = await guest.move(matchId, env.match.revision, env.legal[0] as CMCommand);
        } catch {
          env = await guest.match(matchId);
        }
      } else {
        env = await guest.match(matchId, env.match.revision, 5000);
      }
    }
    expect(env.match.outcome?.winners).toHaveLength(1);
    const table = await until(async () => {
      const r = await guest.call<{ messages: { author: { handle: string } | null; text: string }[] }>('GET', `/api/chat/match:${matchId}`);
      const said = r.messages.filter((m) => m.author?.handle === 'Sprocket').map((m) => m.text);
      return said.length >= 2 ? said : null;
    });
    expect(sprocket.lines.hello).toContain(table[0]);
  }, 60_000);
});

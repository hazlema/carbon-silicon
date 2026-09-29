import { testDatabaseUrl } from '@cs/server/testing';
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createCore } from './core/core';
import { createApp } from './http/app';
import { randomTag } from './lib/testing';
import { startServer } from './server';

// Bun's server.stop(true) waits for every in-flight request, so a parked long-poll must be woken first.
test('once the core is drained, the server stops promptly even with an inbox poll parked', async () => {
  const diaryDir = fileURLToPath(new URL('./__fixtures__/diary', import.meta.url));
  const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir });
  const running = startServer(core, createApp(core, { apiDocs: '', llmsTxt: '' }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
  const reg = await fetch(`${running.url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `stop${randomTag()}` }),
  });
  const auth = { authorization: `Bearer ${((await reg.json()) as any).token}` };
  const first = (await (await fetch(`${running.url}/api/inbox?waitMs=0`, { headers: auth })).json()) as any;
  const parked = fetch(`${running.url}/api/inbox?since=${first.cursor}&waitMs=25000`, { headers: auth }).catch(() => null);
  await Bun.sleep(200);

  core.drain();
  const started = performance.now();
  await running.stop();
  expect(performance.now() - started).toBeLessThan(2000);
  await parked;
  await core.close();
});

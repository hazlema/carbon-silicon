import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { runBot } from './bot';
import { Client } from './client';
import { lightlineDoctrine } from './strategies/lightline';
import { oldIron } from './personalities/old-iron';
import { sprocket } from './personalities/sprocket';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// Fast ticks so a whole match fits in a test; the floor is still 3 ticks.
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100, realtimeTickMs: 5, realtimeCountdownMs: 1000 });
const running = startServer(core, createApp(core, { apiDocs: '', llmsTxt: '', trustProxy: true }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const controller = new AbortController();
const bot = (personality: typeof sprocket, extra = {}) =>
  runBot({ base: running.url, personality, houseKey: 'hk', tokenFile: join(root, `.data/test-bots/${crypto.randomUUID()}.token`), thinkMs: [0, 0], inviteThinkMs: [0, 0], pollWaitMs: 500, signal: controller.signal, log: () => {}, ...extra });
const done = [bot(sprocket), bot(oldIron, { voice: { say: async () => null }, ambientEveryMs: 0 })];
afterAll(async () => {
  controller.abort();
  await Promise.allSettled(done);
  await running.stop();
  await core.close();
});

test('an exhibition: both residents send their own doctrine, ride it, and finish the match', async () => {
  const deadline = Date.now() + 10_000;
  while (core.presence.list().filter((p) => p.identity.isHouse && p.status === 'ready').length < 2) {
    if (Date.now() > deadline) throw new Error('the residents never showed up');
    await Bun.sleep(50);
  }
  const m = await core.tables.exhibition('lightline');
  const seen = new Set<string>();
  const end = Date.now() + 90_000;
  while (core.games.summary(m.id).status !== 'over') {
    if (Date.now() > end) throw new Error('the match never ended');
    for (const f of Object.values(core.games.envelope(m.id, null).realtime?.fired ?? {})) if (f?.label) seen.add(f.label);
    await Bun.sleep(10);
  }
  expect(seen.has('ride') || seen.has('veer-left') || seen.has('veer-right') || seen.has('boost-away')).toBe(true);
  expect([...seen].some((l) => ['CORNER', 'CORNER-R', 'HUG', 'PROCEED'].includes(l))).toBe(true);
  expect(core.games.summary(m.id).outcome).not.toBeNull();
}, 120_000);

test('an agent hosts Lightline over HTTP, invites a resident, sets a doctrine in the countdown, and plays to the end', async () => {
  const agent = new Client(running.url);
  // The residents registered from loopback; this agent comes from its own made-up address (five per hour each).
  const reg = await agent.call<{ token: string }>('POST', '/api/agents', { name: `rider${String(Math.floor(Math.random() * 1e9))}` }, { 'x-forwarded-for': '10.7.7.7' });
  agent.token = reg.token;
  await agent.setStatus('ready');
  const resident = core.presence.list().find((p) => p.identity.isHouse && /sprocket/i.test(p.identity.handle))!.identity;
  // The exhibition above may still be wrapping up; wait until the resident is free.
  const free = Date.now() + 10_000;
  while (core.tables.isBusy(resident.id) || core.games.activeMatchOf(resident.id)) {
    if (Date.now() > free) throw new Error('the resident never came free');
    await Bun.sleep(50);
  }
  const { table } = await agent.hostTable('lightline', [resident.handle]);
  const seated = Date.now() + 10_000;
  while (core.tables.get(table.id, null).seated.length < 2) {
    if (Date.now() > seated) throw new Error('the resident never sat down');
    await Bun.sleep(20);
  }
  const { match } = await agent.startTable(table.id);
  const typo = await agent.doctrine(match.id, { rules: [{ when: { sense: 'ahed', op: 'lt', value: 2 }, do: { act: 'straight' } }] }).catch((e) => e);
  expect([typo.status, typo.code, typo.message]).toEqual([400, 'BAD_DOCTRINE', 'rules[0].when.sense: unknown sense "ahed"; did you mean "ahead"?']);
  expect((await agent.doctrine(match.id, lightlineDoctrine('survivor', false))).status).toBe('applied');
  let env = await agent.match(match.id);
  expect(env.realtime?.you?.doctrine.rules).toHaveLength(6);
  const end = Date.now() + 90_000;
  while (env.match.status !== 'over') {
    if (Date.now() > end) throw new Error('the match never ended');
    await Bun.sleep(200);
    env = await agent.match(match.id);
  }
  expect(typeof env.realtime?.you?.senses?.heading).toBe('string');
  const inbox = await agent.inbox(0, 0);
  expect(inbox.events.some((e) => e.type === 'match.round' && e.matchId === match.id)).toBe(true);
  expect(inbox.events.some((e) => e.type === 'match.over' && e.matchId === match.id)).toBe(true);
}, 120_000);

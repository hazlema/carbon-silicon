import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket } from 'bun';
import type { IdentityPublic } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { FakeClock } from '../lib/clock';
import { randomTag } from '../lib/testing';
import { WsHub, type WsData } from './hub';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const clock = new FakeClock();
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, clock, sweepEveryMs: 0 });
const hub = new WsHub(core);
afterAll(async () => {
  hub.stop();
  await core.close();
});

const socket = (identity: IdentityPublic) =>
  ({ data: { identity, channels: new Set<string>(), matches: new Set<string>() }, send() {} }) as unknown as ServerWebSocket<WsData>;

test('a human who reconnects mid-match after the grace period shows playing', async () => {
  const human = (await core.identities.createHuman(`back${randomTag()}`, { label: 'test', ip: null })).identity;
  const machine = (await core.identities.registerAgent({ name: `wait${randomTag()}` }, null)).identity;
  core.presence.agentSeen(machine);
  const first = socket(human);
  hub.handlers.open(first);
  await core.games.createMatch('critical-mass', [human, machine]);
  expect(core.presence.get(human.id)?.status).toBe('playing');

  hub.handlers.close(first);
  clock.advance(15_000); // the grace period passes: offline
  expect(core.presence.get(human.id)).toBeNull();
  core.presence.agentSeen(machine);

  hub.handlers.open(socket(human));
  expect(core.presence.get(human.id)?.status).toBe('playing');
});

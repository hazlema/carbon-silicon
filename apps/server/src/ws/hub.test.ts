import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket } from 'bun';
import type { IdentityPublic, WsServerMsg } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { FakeClock } from '../lib/clock';
import { randomTag, waitFor } from '../lib/testing';
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

test('chat posted to a quick match\'s match:<id> alias arrives on the table channel a socket subscribed to it', async () => {
  const human = (await core.identities.createHuman(`quick${randomTag()}`, { label: 'test', ip: null })).identity;
  const machine = (await core.identities.registerAgent({ name: `quickbot${randomTag()}` }, null)).identity;
  core.presence.humanConnected(human);
  core.presence.agentSeen(machine);

  const match = await core.tables.startNow('critical-mass', [human, machine]);
  const tableId = match.tableId;
  expect(tableId).not.toBeNull();

  const received: WsServerMsg[] = [];
  const ws = {
    data: { identity: human, channels: new Set<string>(), matches: new Set<string>() },
    send(raw: string) {
      received.push(JSON.parse(raw));
    },
  } as unknown as ServerWebSocket<WsData>;

  hub.handlers.open(ws);
  hub.handlers.message(ws, JSON.stringify({ type: 'subscribe', channel: `match:${match.id}` }));
  await waitFor(() => ws.data.channels.has(`table:${tableId}`));

  await core.comms.post(human, `match:${match.id}`, 'hello table');
  await waitFor(() => received.some((m) => m.type === 'chat'));

  const chat = received.find((m) => m.type === 'chat');
  expect(chat && chat.type === 'chat' ? chat.message.channel : null).toBe(`table:${tableId}`);
});

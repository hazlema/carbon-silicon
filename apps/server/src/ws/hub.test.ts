import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket } from 'bun';
import type { IdentityPublic, WsServerMsg } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { FakeClock } from '../lib/clock';
import { randomTag, waitFor } from '../lib/testing';
import { SIGNED_OUT, WsHub, type WsData } from './hub';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const clock = new FakeClock();
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, clock, sweepEveryMs: 0 });
const hub = new WsHub(core);
afterAll(async () => {
  hub.stop();
  await core.close();
});

type FakeSocket = ServerWebSocket<WsData> & { sent: WsServerMsg[]; closedWith: number | null };
const socket = (identity: IdentityPublic, extra: { sessionId?: string | null; ip?: string | null } = {}): FakeSocket => {
  const ws = {
    data: { identity, sessionId: extra.sessionId ?? null, ip: extra.ip ?? null, channels: new Set<string>(), matches: new Set<string>(), tables: new Set<string>() },
    sent: [] as WsServerMsg[],
    closedWith: null as number | null,
    send(raw: string) {
      ws.sent.push(JSON.parse(raw));
    },
    close(code: number) {
      ws.closedWith = code;
    },
  };
  return ws as unknown as FakeSocket;
};

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

  const ws = socket(human);

  hub.handlers.open(ws);
  hub.handlers.message(ws, JSON.stringify({ type: 'subscribe', channel: `match:${match.id}` }));
  await waitFor(() => ws.data.channels.has(`table:${tableId}`));

  await core.comms.post(human, `match:${match.id}`, 'hello table');
  await waitFor(() => ws.sent.some((m) => m.type === 'chat'));

  const chat = ws.sent.find((m) => m.type === 'chat');
  expect(chat && chat.type === 'chat' ? chat.message.channel : null).toBe(`table:${tableId}`);
});

test('revoking a session closes exactly that session’s sockets, with 4001', async () => {
  const { identity, key } = await core.identities.createHuman(`rev${randomTag()}`, { label: 'test', ip: null });
  const first = (await core.identities.authenticateSession(key))!;
  const secondKey = await core.identities.newSession(identity.id, { label: 'phone', ip: null });
  const second = (await core.identities.authenticateSession(secondKey))!;
  const a = socket(identity, { sessionId: first.sessionId });
  const b = socket(identity, { sessionId: second.sessionId });
  hub.handlers.open(a);
  hub.handlers.open(b);
  await core.accounts.revokeSession(identity.id, second.sessionId!);
  expect(b.closedWith).toBe(SIGNED_OUT);
  expect(a.closedWith).toBeNull();
  expect(SIGNED_OUT).toBe(4001); // pinned to the constraint's exact close code
});

test('an IP ban closes the sockets from that address', async () => {
  const { identity } = await core.identities.createHuman(`ban${randomTag()}`, { label: 'test', ip: null });
  const there = socket(identity, { ip: '10.77.0.1' });
  const elsewhere = socket(identity, { ip: '10.77.0.2' });
  hub.handlers.open(there);
  hub.handlers.open(elsewhere);
  await core.moderation.banIp({ kind: 'console' }, '10.77.0.1', 'test ban');
  expect(there.closedWith).toBe(SIGNED_OUT);
  expect(elsewhere.closedWith).toBeNull();
});

test('a released name leaves presence at once', async () => {
  const { identity } = await core.identities.createHuman(`gone${randomTag()}`, { label: 'test', ip: null });
  hub.handlers.open(socket(identity));
  expect(core.presence.get(identity.id)).not.toBeNull();
  await core.accounts.release(identity.id);
  expect(core.presence.get(identity.id)).toBeNull();
});

test('watching a table pushes it, counts spectators, and every socket hears the lobby list', async () => {
  const host = (await core.identities.createHuman(`tab${randomTag()}`, { label: 'test', ip: null })).identity;
  const fan = (await core.identities.createHuman(`fan${randomTag()}`, { label: 'test', ip: null })).identity;
  const hostWs = socket(host);
  const fanWs = socket(fan);
  hub.handlers.open(hostWs);
  hub.handlers.open(fanWs);
  const t = await core.tables.host(host, 'critical-mass', { open: true });
  expect(fanWs.sent.some((m) => m.type === 'tables' && m.tables.some((x) => x.id === t.id))).toBe(true);
  hub.handlers.message(fanWs, JSON.stringify({ type: 'watchTable', tableId: t.id }));
  hub.handlers.message(hostWs, JSON.stringify({ type: 'watchTable', tableId: t.id }));
  expect(fanWs.sent.some((m) => m.type === 'table' && m.table.id === t.id)).toBe(true);
  expect(core.tables.get(t.id, null).watching).toBe(1); // the host is seated, so only the fan counts
  hub.handlers.close(fanWs);
  expect(core.tables.get(t.id, null).watching).toBe(0);
  core.tables.disband(host, t.id);
  expect(hostWs.sent.some((m) => m.type === 'table.gone' && m.tableId === t.id)).toBe(true);
});

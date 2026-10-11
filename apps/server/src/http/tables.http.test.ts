import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { InboxEvent, MatchEnvelope } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { randomTag } from '../lib/testing';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
const app = createApp(core, { apiDocs: '', llmsTxt: '', trustProxy: true });
afterAll(() => core.close());

let ip = 0;
async function call(method: string, path: string, opts: { token?: string; body?: unknown; house?: boolean } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': `10.1.0.${++ip % 250}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.house) headers['x-house-key'] = 'hk';
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}
async function agent(prefix: string, house = false) {
  const r = await call('POST', '/api/agents', { body: { name: `${prefix}${randomTag()}` }, house });
  expect(r.status).toBe(201);
  return { token: r.data.token as string, id: r.data.identity.id as string, handle: r.data.identity.handle as string };
}
type Agent = Awaited<ReturnType<typeof agent>>;
async function lastOffer(who: Agent) {
  const r = await call('GET', '/api/inbox?since=0&waitMs=0', { token: who.token });
  const offers = (r.data.events as InboxEvent[]).filter((e) => e.type === 'invite.received') as Extract<InboxEvent, { type: 'invite.received' }>[];
  return offers.at(-1)!;
}
async function playOut(matchId: string, players: Agent[]) {
  for (let i = 0; i < 4000; i++) {
    for (const p of players) {
      const env = (await call('GET', `/api/matches/${matchId}`, { token: p.token })).data as MatchEnvelope;
      if (env.match.status === 'over') return env;
      if (env.legal.length === 0) {
        // A real wait, not a spin: lets a pending timer (e.g. the countdown-to-live transition)
        // actually fire, the same technique app.test.ts's full-match test uses.
        await call('GET', `/api/matches/${matchId}?since=${env.match.revision}&waitMs=50`, { token: p.token });
        continue;
      }
      const command = env.legal[Math.floor(Math.random() * env.legal.length)];
      await call('POST', `/api/matches/${matchId}/move`, { token: p.token, body: { revision: env.match.revision, command } });
    }
  }
  throw new Error('the match did not finish');
}

describe('tables over HTTP', () => {
  test('an agent hosts, invites another, both play to the end, then they rematch at the same table', async () => {
    const a = await agent('host');
    const b = await agent('guest');
    const hosted = await call('POST', '/api/tables', { token: a.token, body: { gameId: 'critical-mass', invite: [b.handle] } });
    expect(hosted.status).toBe(201);
    const tableId = hosted.data.table.id as string;
    const offer = await lastOffer(b);
    expect(offer.table.id).toBe(tableId);
    const accepted = await call('POST', `/api/invites/${offer.invite.id}/accept`, { token: b.token });
    expect(accepted.data.table.seated).toHaveLength(2);
    const started = await call('POST', `/api/tables/${tableId}/start`, { token: a.token });
    expect(started.status).toBe(200);
    expect(started.data.match.tableId).toBe(tableId);
    await playOut(started.data.match.id, [a, b]);
    expect((await call('GET', `/api/tables/${tableId}`)).data.table.status).toBe('finished');
    const re = await call('POST', `/api/tables/${tableId}/rematch`, { token: b.token });
    expect(re.data.table).toMatchObject({ status: 'forming', host: { id: b.id } });
    await call('POST', `/api/invites/${(await lastOffer(a)).invite.id}/accept`, { token: a.token });
    const second = await call('POST', `/api/tables/${tableId}/start`, { token: b.token });
    expect(second.data.match.tableId).toBe(tableId);
    expect(second.data.match.id).not.toBe(started.data.match.id);
  });
  test('three agents play one match on the bigger board', async () => {
    const [a, b, c] = [await agent('tri'), await agent('tri'), await agent('tri')];
    const t = (await call('POST', '/api/tables', { token: a.token, body: { gameId: 'critical-mass', invite: [b.handle, c.handle] } })).data.table;
    for (const who of [b, c]) await call('POST', `/api/invites/${(await lastOffer(who)).invite.id}/accept`, { token: who.token });
    const m = (await call('POST', `/api/tables/${t.id}/start`, { token: a.token })).data.match;
    expect(m.seats).toHaveLength(3);
    expect((await call('GET', `/api/matches/${m.id}`)).data.view.cols).toBe(8);
  });
  test('the refusals an agent will meet', async () => {
    const [a, b] = [await agent('nope'), await agent('nope')];
    const t = (await call('POST', '/api/tables', { token: a.token, body: { gameId: 'critical-mass' } })).data.table;
    const early = await call('POST', `/api/tables/${t.id}/start`, { token: a.token });
    expect([early.status, early.data.error.code]).toEqual([409, 'NOT_ENOUGH']);
    expect((await call('POST', `/api/tables/${t.id}/start`, { token: b.token })).data.error.code).toBe('NOT_HOST');
    expect((await call('POST', `/api/tables/${t.id}/invite`, { token: a.token, body: { handles: 'nobody_x_1' } })).status).toBe(404);
    await call('POST', `/api/tables/${t.id}/invite`, { token: a.token, body: { handles: [b.handle] } });
    const offer = await lastOffer(b);
    expect((await call('POST', `/api/invites/${offer.invite.id}/decline`, { token: b.token })).status).toBe(204);
    const late = await call('POST', `/api/invites/${offer.invite.id}/accept`, { token: b.token });
    expect([late.status, late.data.error.code]).toEqual([410, 'INVITE_GONE']);
    expect((await call('GET', '/api/tables/t_nope')).status).toBe(404);
    expect((await call('POST', '/api/tables', { body: { gameId: 'critical-mass' } })).status).toBe(401);
    expect((await call('DELETE', `/api/tables/${t.id}`, { token: a.token })).status).toBe(204);
  });
  test('vs house invites a ready house bot; POST /api/invites hosts and invites in one call', async () => {
    const bot = await agent('parlor', true);
    const a = await agent('vs');
    const vs = await call('POST', '/api/vs-house', { token: a.token, body: { gameId: 'critical-mass' } });
    expect(vs.status).toBe(201);
    expect(vs.data.table.invites.map((i: { to: { id: string } }) => i.to.id)).toEqual([bot.id]);
    const b = await agent('short');
    const c = await agent('short');
    const r = await call('POST', '/api/invites', { token: b.token, body: { to: c.handle, gameId: 'critical-mass' } });
    expect(r.status).toBe(201);
    expect(r.data.table.invites[0].to.id).toBe(c.id);
    const busy = await call('POST', '/api/vs-house', { token: c.token, body: { gameId: 'critical-mass' } });
    expect([busy.status, busy.data.error.code]).toEqual([409, 'HOUSE_FULL']);
  });
  test('GET /api/me shows your table and your invites; the public list hides invites', async () => {
    const [a, b] = [await agent('me'), await agent('me')];
    const t = (await call('POST', '/api/tables', { token: a.token, body: { gameId: 'critical-mass', invite: [b.handle], open: true } })).data.table;
    expect((await call('GET', '/api/me', { token: a.token })).data.table.id).toBe(t.id);
    const mine = (await call('GET', '/api/me', { token: b.token })).data;
    expect(mine.table).toBeNull();
    expect(mine.invites.map((o: { table: { id: string } }) => o.table.id)).toEqual([t.id]);
    const listed = (await call('GET', '/api/tables')).data.tables.find((x: { id: string }) => x.id === t.id);
    expect(listed.invites).toEqual([]);
    const patched = await call('PATCH', `/api/tables/${t.id}`, { token: a.token, body: { open: false } });
    expect(patched.data.table.open).toBe(false);
  });
  test('match:<id> posts land in the table channel; the rail takes anyone signed in', async () => {
    const [a, b, fan] = [await agent('talk'), await agent('talk'), await agent('fan')];
    const t = (await call('POST', '/api/tables', { token: a.token, body: { gameId: 'critical-mass', invite: [b.handle] } })).data.table;
    await call('POST', `/api/invites/${(await lastOffer(b)).invite.id}/accept`, { token: b.token });
    const m = (await call('POST', `/api/tables/${t.id}/start`, { token: a.token })).data.match;
    const said = await call('POST', `/api/chat/match:${m.id}`, { token: a.token, body: { text: 'good luck' } });
    expect(said.data.message.channel).toBe(`table:${t.id}`);
    expect((await call('POST', `/api/chat/rail:${t.id}`, { token: fan.token, body: { text: 'go silicon' } })).status).toBe(201);
    expect((await call('POST', `/api/chat/table:${t.id}`, { token: fan.token, body: { text: 'hi' } })).status).toBe(403);
    const sit = await call('POST', `/api/tables/${t.id}/sit`, { token: fan.token });
    expect(sit.data.error.code).toBe('TABLE_BUSY');
  });
});

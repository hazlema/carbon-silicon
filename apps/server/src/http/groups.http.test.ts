import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { randomTag } from '../lib/testing';
import { createApp } from './app';
import { createCore } from '../core/core';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
const app = createApp(core, { apiDocs: '', llmsTxt: '', trustProxy: true });
afterAll(() => core.close());

let ip = 0;
async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': `10.3.0.${++ip % 250}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
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
async function human(prefix: string) {
  const res = await app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': `10.3.0.${++ip % 250}` },
    body: JSON.stringify({ handle: `${prefix}${randomTag()}` }),
  });
  expect(res.status).toBe(201);
  const data: any = await res.json();
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], handle: data.identity.handle as string };
}

describe('groups over HTTP', () => {
  test('an agent and two humans: start, talk, rename, remove, un-ban, leave', async () => {
    const bot = await agent('grpbot');
    const [ann, ben] = [await human('ann'), await human('ben')];
    const made = await call('POST', '/api/groups', { token: bot.token, body: { with: [ann.handle, ben.handle] } });
    expect(made.status).toBe(201);
    const g = made.data.group;
    expect(g.channel).toBe(`grp:${g.id}`);
    expect((await call('POST', `/api/chat/${g.channel}`, { cookie: ann.cookie, body: { text: 'hi crew' } })).status).toBe(201);
    const listed = await call('GET', '/api/groups', { cookie: ben.cookie });
    expect(listed.data.groups.find((x: { id: string }) => x.id === g.id).unread).toBe(1);
    expect((await call('PATCH', `/api/groups/${g.id}`, { cookie: ben.cookie, body: { name: 'crew' } })).data.group.name).toBe('crew');
    const removed = await call('DELETE', `/api/groups/${g.id}/members/${ann.handle}`, { token: bot.token });
    expect(removed.data.group.bans.map((b: { handle: string }) => b.handle)).toEqual([ann.handle]);
    const again = await call('POST', `/api/groups/${g.id}/members`, { cookie: ben.cookie, body: { handle: ann.handle } });
    expect([again.status, again.data.error.code]).toEqual([403, 'GROUP_BANNED']);
    expect((await call('GET', `/api/chat/${g.channel}`, { cookie: ann.cookie })).data.error.code).toBe('NOT_MEMBER');
    expect((await call('DELETE', `/api/groups/${g.id}/bans/${ann.handle}`, { token: bot.token })).data.group.bans).toEqual([]);
    const left = await call('DELETE', `/api/groups/${g.id}/members/${ben.handle}`, { cookie: ben.cookie });
    expect(left.data.group).toBeNull();
  });

  test('add wants a handle; un-banning a stranger is NO_USER', async () => {
    const [a, b] = [await agent('grpaa'), await agent('grpab')];
    const g = (await call('POST', '/api/groups', { token: a.token, body: { with: [b.handle] } })).data.group;
    for (const body of [{}, { handle: 7 }, { handle: '' }, { handle: '@' }]) {
      const r = await call('POST', `/api/groups/${g.id}/members`, { token: a.token, body });
      expect([r.status, r.data.error.code, r.data.error.message]).toEqual([400, 'BAD_FIELD', 'Send {"handle": "…"}.']);
    }
    const r = await call('DELETE', `/api/groups/${g.id}/bans/nobody_here_xyz`, { token: a.token });
    expect([r.status, r.data.error.code]).toEqual([404, 'NO_USER']);
  });

  test('read and close answer with the group', async () => {
    const [a, b] = [await agent('grpra'), await agent('grprb')];
    const g = (await call('POST', '/api/groups', { token: a.token, body: { with: [b.handle] } })).data.group;
    expect((await call('GET', `/api/groups/${g.id}`, { token: b.token })).data.group.id).toBe(g.id);
    expect((await call('POST', `/api/groups/${g.id}/read`, { token: b.token })).data.group.unread).toBe(0);
    expect((await call('POST', `/api/groups/${g.id}/close`, { token: b.token })).data.group.hidden).toBe(true);
  });

  test('errors: unauthenticated, bad with, a non-member, no such group', async () => {
    expect((await call('POST', '/api/groups', { body: { with: ['x'] } })).status).toBe(401);
    const bot = await agent('grpbad');
    expect((await call('POST', '/api/groups', { token: bot.token, body: { with: 'nope' } })).data.error.code).toBe('BAD_FIELD');
    expect((await call('GET', '/api/groups/g_0000000000000000', { token: bot.token })).data.error.code).toBe('NO_GROUP');
  });
});

describe('host with everyone over HTTP', () => {
  test('POST /api/groups/:id/host invites the ready members', async () => {
    const [ann, ben] = [await human('ann'), await human('ben')];
    for (const p of [ann, ben]) {
      const me = await call('GET', '/api/me', { cookie: p.cookie });
      core.presence.humanConnected(me.data.identity);
    }
    const g = (await call('POST', '/api/groups', { cookie: ann.cookie, body: { with: [ben.handle] } })).data.group;
    const r = await call('POST', `/api/groups/${g.id}/host`, { cookie: ann.cookie, body: { gameId: 'critical-mass' } });
    expect(r.status).toBe(201);
    expect(r.data.table.invites).toHaveLength(1);
    expect(r.data.skipped).toEqual([]);
  });
});

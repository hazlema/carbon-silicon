import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { IdentityPublic, Role } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { randomTag } from '../lib/testing';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', diaryDir, countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
const app = createApp(core, { apiDocs: '# API', llmsTxt: 'llms' });
afterAll(() => core.close());

let ipCounter = 0;
async function call(method: string, path: string, opts: { cookie?: string; token?: string; body?: unknown; ip?: string } = {}) {
  // The same address rides in both places, so the test holds whether or not the app trusts X-Forwarded-For.
  const ip = opts.ip ?? `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, { ip });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}
type Player = { cookie: string; identity: IdentityPublic };
async function signUp(prefix = 'p', ip?: string): Promise<Player> {
  const res = await app.request(
    '/api/session',
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip ?? `10.2.0.${++ipCounter % 250}` }, body: JSON.stringify({ handle: `${prefix}${randomTag()}` }) },
    { ip: ip ?? `10.2.0.${ipCounter % 250}` },
  );
  expect(res.status).toBe(201);
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], identity: ((await res.json()) as any).identity };
}
async function lockedPlayer(prefix = 'lk'): Promise<Player> {
  const p = await signUp(prefix);
  expect((await call('POST', '/api/me/lock', { cookie: p.cookie, body: { password: 'correct horse battery' } })).status).toBe(200);
  return p;
}
async function makeStaff(role: Exclude<Role, 'user'>): Promise<Player> {
  const p = await lockedPlayer(role);
  p.identity = await core.identities.setRole(p.identity.id, role);
  core.identities.evict(p.identity.id);
  return p;
}

describe('the mod door', () => {
  test('plain players are turned away from every mod route', async () => {
    const user = await signUp('plain');
    for (const [method, path] of [
      ['GET', '/api/mod/reports'],
      ['GET', '/api/mod/people'],
      ['GET', '/api/mod/log'],
      ['POST', '/api/mod/people/someone/mute'],
      ['DELETE', '/api/mod/messages/1'],
    ] as const) {
      const r = await call(method, path, { cookie: user.cookie, body: { reason: 'x', minutes: 5 } });
      expect([path, r.status, r.data.error.code]).toEqual([path, 403, 'FORBIDDEN_ROLE']);
    }
    expect((await call('GET', '/api/mod/reports')).status).toBe(401);
  });

  test('report, resolve, and the message is removed for everyone', async () => {
    const mod = await makeStaff('mod');
    const [ann, bob] = [await signUp('ann'), await signUp('bob')];
    const posted = await call('POST', '/api/chat/lobby', { cookie: bob.cookie, body: { text: 'something nasty' } });
    const messageId = posted.data.message.id as number;
    const report = await call('POST', '/api/report', { cookie: ann.cookie, body: { messageId, reason: 'nasty' } });
    expect(report.status).toBe(201);
    const queue = await call('GET', '/api/mod/reports', { cookie: mod.cookie });
    expect(queue.data.reports.some((r: { id: string }) => r.id === report.data.report.id)).toBe(true);
    expect((await call('GET', '/api/mod/reports?status=nope', { cookie: mod.cookie })).data.error.code).toBe('BAD_QUERY');

    const resolved = await call('POST', `/api/mod/reports/${report.data.report.id}/resolve`, {
      cookie: mod.cookie,
      body: { resolution: 'delete', reason: 'nasty' },
    });
    expect(resolved.data.report).toMatchObject({ status: 'resolved', resolution: 'delete', resolvedBy: mod.identity.handle });
    const history = await call('GET', `/api/chat/lobby?since=${messageId - 1}`);
    expect(history.data.messages.find((m: { id: number }) => m.id === messageId)).toMatchObject({ text: '', removed: { by: mod.identity.handle } });

    const noted = await call('POST', `/api/mod/reports/${report.data.report.id}/notes`, { cookie: mod.cookie, body: { text: 'first offence' } });
    expect(noted.data.report.notes).toHaveLength(1);
    const reopened = await call('POST', `/api/mod/reports/${report.data.report.id}/reopen`, { cookie: mod.cookie, body: { reason: 'check again' } });
    expect(reopened.data.report.status).toBe('open');

    const log = await call('GET', `/api/mod/log?handle=${bob.identity.handle}`, { cookie: mod.cookie });
    expect(log.data.entries.map((e: { action: string }) => e.action)).toEqual(['reopen-report', 'note', 'resolve-report', 'delete-message']);
  });

  test('mute, suspend and lift by handle; the sanction shows on /api/me', async () => {
    const mod = await makeStaff('mod');
    const bob = await signUp('bob');
    const muted = await call('POST', `/api/mod/people/${bob.identity.handle}/mute`, { cookie: mod.cookie, body: { reason: 'cool off', minutes: 10 } });
    expect(muted.data.sanction).toMatchObject({ kind: 'mute', reason: 'cool off' });
    expect((await call('POST', '/api/chat/lobby', { cookie: bob.cookie, body: { text: 'hi' } })).data.error.code).toBe('MUTED');
    expect((await call('GET', '/api/me', { cookie: bob.cookie })).data.sanction).toMatchObject({ kind: 'mute' });
    expect((await call('POST', `/api/mod/people/${bob.identity.handle}/lift`, { cookie: mod.cookie, body: { reason: 'ok' } })).status).toBe(204);
    expect((await call('POST', '/api/chat/lobby', { cookie: bob.cookie, body: { text: 'hi again' } })).status).toBe(201);
    const forever = await call('POST', `/api/mod/people/${bob.identity.handle}/suspend`, { cookie: mod.cookie, body: { reason: 'forever' } });
    expect([forever.status, forever.data.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
    const missing = await call('POST', '/api/mod/people/nobody_here_1/mute', { cookie: mod.cookie, body: { reason: 'x', minutes: 5 } });
    expect([missing.status, missing.data.error.code]).toEqual([404, 'NO_USER']);
  });

  test('a suspended account is read-only across the HTTP door (S231-235)', async () => {
    const mod = await makeStaff('mod');
    const bob = await lockedPlayer('bob');
    const bot = (await core.identities.registerAgent({ name: `bot${randomTag()}` }, null)).identity;
    const line = await core.comms.post(mod.identity, 'lobby', 'a line to report');
    const suspend = await call('POST', `/api/mod/people/${bob.identity.handle}/suspend`, { cookie: mod.cookie, body: { reason: 'cool off', minutes: 60 } });
    expect(suspend.data.sanction).toMatchObject({ kind: 'suspend', reason: 'cool off' });

    // a match started for them anyway (quick match itself is refused below) is read-only, never played
    const match = await core.games.createMatch('critical-mass', [bob.identity, bot]);
    const revision = core.games.summary(match.id).revision;

    const refused = [
      await call('POST', '/api/chat/lobby', { cookie: bob.cookie, body: { text: 'let me back in' } }),
      await call('POST', '/api/quickmatch', { cookie: bob.cookie, body: { gameId: 'critical-mass' } }),
      await call('POST', `/api/matches/${match.id}/move`, { cookie: bob.cookie, body: { revision, cell: 'a1' } }),
      await call('POST', '/api/report', { cookie: bob.cookie, body: { messageId: line.id, reason: 'x' } }),
      await call('PATCH', '/api/me', { cookie: bob.cookie, body: { tagline: 'reformed' } }),
      await call('DELETE', '/api/me', { cookie: bob.cookie }),
    ];
    expect(refused.map((r) => [r.status, r.data.error.code])).toEqual(Array(6).fill([403, 'SUSPENDED']));

    // still allowed while suspended: resigning and reading
    expect((await call('POST', `/api/matches/${match.id}/resign`, { cookie: bob.cookie })).status).toBe(200);
    expect((await call('GET', '/api/me', { cookie: bob.cookie })).data.sanction).toMatchObject({ kind: 'suspend' });

    // still allowed while suspended: changing your password...
    expect(
      (await call('POST', '/api/me/password', { cookie: bob.cookie, body: { current: 'correct horse battery', next: 'a new secure password' } })).status,
    ).toBe(204);
    // ...and signing out, which then invalidates that very cookie
    expect((await call('DELETE', '/api/session', { cookie: bob.cookie })).status).toBe(204);
    expect((await call('GET', '/api/me', { cookie: bob.cookie })).status).toBe(401);
  });

  test('admins manage roles, passwords, releases and IP bans', async () => {
    const admin = await makeStaff('admin');
    const mod = await makeStaff('mod');
    const target = await lockedPlayer('tgt');
    const handle = target.identity.handle;
    expect((await call('POST', `/api/mod/people/${handle}/role`, { cookie: mod.cookie, body: { role: 'mod', reason: 'x' } })).data.error.code).toBe('FORBIDDEN_ROLE');
    const promoted = await call('POST', `/api/mod/people/${handle}/role`, { cookie: admin.cookie, body: { role: 'mod', reason: 'helper' } });
    expect(promoted.data.identity.role).toBe('mod');
    const reset = await call('POST', `/api/mod/people/${handle}/reset-password`, { cookie: admin.cookie, body: { reason: 'forgot' } });
    expect(reset.data.code).toStartWith('csr_');
    expect((await call('GET', '/api/me', { cookie: target.cookie })).status).toBe(401);
    expect((await call('POST', `/api/mod/people/${handle}/release`, { cookie: admin.cookie, body: { reason: 'asked' } })).status).toBe(204);
    expect((await call('GET', `/api/users/${handle}`)).status).toBe(404);

    const ip = '203.0.113.9';
    expect((await call('POST', '/api/mod/ip-bans', { cookie: mod.cookie, body: { ip, reason: 'spam' } })).data.error.code).toBe('FORBIDDEN_ROLE');
    expect((await call('POST', '/api/mod/ip-bans', { cookie: admin.cookie, body: { ip, reason: 'spam' } })).status).toBe(204);
    const guest = await call('POST', '/api/session', { ip, body: { handle: `banned${randomTag()}` } });
    expect([guest.status, guest.data.error.code]).toEqual([403, 'BANNED']);
    const bot = await call('POST', '/api/agents', { ip, body: { name: `banned${randomTag()}` } });
    expect([bot.status, bot.data.error.code]).toEqual([403, 'BANNED']);
    expect((await call('DELETE', `/api/mod/ip-bans/${ip}`, { cookie: admin.cookie, body: { reason: 'lifted' } })).status).toBe(204);
    expect((await call('POST', '/api/session', { ip, body: { handle: `welcome${randomTag()}` } })).status).toBe(201);
  });

  test('people search and a person page', async () => {
    const mod = await makeStaff('mod');
    const bob = await signUp('findme');
    const found = await call('GET', `/api/mod/people?q=${bob.identity.handle.slice(0, 10)}&filter=guests`, { cookie: mod.cookie });
    expect(found.data.people.some((p: { identity: { id: string } }) => p.identity.id === bob.identity.id)).toBe(true);
    expect((await call('GET', '/api/mod/people?filter=nope', { cookie: mod.cookie })).data.error.code).toBe('BAD_FILTER');
    const detail = await call('GET', `/api/mod/people/${bob.identity.handle}`, { cookie: mod.cookie });
    expect(detail.data).toMatchObject({ profile: { identity: { id: bob.identity.id } }, sanction: null, sessions: 1, history: [] });
  });

  test('a mod removes a message directly', async () => {
    const mod = await makeStaff('mod');
    const bob = await signUp('bob');
    const posted = await call('POST', '/api/chat/lobby', { cookie: bob.cookie, body: { text: 'oops' } });
    const removed = await call('DELETE', `/api/mod/messages/${posted.data.message.id}`, { cookie: mod.cookie, body: { reason: 'off topic' } });
    expect(removed.data.message).toMatchObject({ id: posted.data.message.id, text: '', removed: { by: mod.identity.handle } });
    expect((await call('DELETE', '/api/mod/messages/abc', { cookie: mod.cookie, body: { reason: 'x' } })).data.error.code).toBe('BAD_MESSAGE');

    // its text stays visible to mods reading chat (S145-146): the route passes the reader as viewer
    const rereadByMod = await call('GET', '/api/chat/lobby', { cookie: mod.cookie });
    expect(rereadByMod.data.messages.find((m: { id: number }) => m.id === posted.data.message.id)).toMatchObject({ text: 'oops' });
    const rereadByBob = await call('GET', '/api/chat/lobby', { cookie: bob.cookie });
    expect(rereadByBob.data.messages.find((m: { id: number }) => m.id === posted.data.message.id)).toMatchObject({ text: '' });
  });
});

describe('ignore and block over HTTP', () => {
  test('set, list and clear', async () => {
    const [ann, bob] = [await signUp('ann'), await signUp('bob')];
    const set = await call('PUT', `/api/me/ignores/${bob.identity.handle}`, { cookie: ann.cookie });
    expect(set.data.ignores.map((i: { id: string }) => i.id)).toEqual([bob.identity.id]);
    expect((await call('GET', '/api/me/relations', { cookie: ann.cookie })).data.ignores).toHaveLength(1);
    expect((await call('DELETE', `/api/me/ignores/${bob.identity.handle}`, { cookie: ann.cookie })).data.ignores).toEqual([]);
    expect((await call('PUT', `/api/me/blocks/${bob.identity.handle}`, { cookie: ann.cookie })).data.blocks).toHaveLength(1);
    expect((await call('PUT', '/api/me/blocks/nobody_here_2', { cookie: ann.cookie })).data.error.code).toBe('NO_USER');
  });
});

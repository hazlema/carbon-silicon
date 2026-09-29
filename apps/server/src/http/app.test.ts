import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import type { InboxPoll, MatchEnvelope } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { FakeClock } from '../lib/clock';
import { randomTag } from '../lib/testing';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, houseFallbackMs: 60_000 });
const app = createApp(core, { apiDocs: '# API reference', llmsTxt: 'llms quickstart', trustProxy: true });
afterAll(() => core.close());

let ipCounter = 0;
async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown; ip?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? `10.0.0.${++ipCounter % 250}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined || opts.raw !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}
const tag = () => randomTag();
async function agent(prefix = 'bot') {
  const r = await call('POST', '/api/agents', { body: { name: `${prefix}${tag()}` } });
  expect(r.status).toBe(201);
  return { token: r.data.token as string, id: r.data.identity.id as string, handle: r.data.identity.handle as string };
}

const cookieOf = (r: { headers: Headers }) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const PW = 'correct horse battery';

/** A human with a locked name, signed in from one browser. */
async function lockedHuman(prefix = 'acct') {
  const handle = `${prefix}${tag()}`;
  const joined = await call('POST', '/api/session', { body: { handle } });
  const cookie = cookieOf(joined);
  const locked = await call('POST', '/api/me/lock', { cookie, body: { password: PW } });
  expect(locked.status).toBe(200);
  return { handle, cookie, id: joined.data.identity.id as string, recoveryCode: locked.data.recoveryCode as string };
}

describe('discovery', () => {
  test('GET /api describes the door', async () => {
    const r = await call('GET', '/api');
    expect(r.status).toBe(200);
    expect(r.data.docs.quickstart).toBe('/llms.txt');
    expect(r.data.endpoints.some((e: { path: string }) => e.path === '/api/inbox')).toBe(true);
    expect(r.data.games[0].id).toBe('critical-mass');
  });
  test('docs, llms.txt, games, rules, tally and diary are served', async () => {
    expect((await call('GET', '/llms.txt')).data).toBe('llms quickstart');
    const docs = await call('GET', '/api/docs');
    expect(docs.headers.get('content-type')).toContain('text/markdown');
    expect((await call('GET', '/api/games')).data.games).toHaveLength(2);
    const rules = await call('GET', '/api/games/critical-mass/rules');
    expect(rules.data.rulesMarkdown).toContain('# Critical Mass');
    expect(rules.data.turnSeconds).toBe(90);
    expect((await call('GET', '/api/games/chess/rules')).status).toBe(404);
    expect(Object.keys((await call('GET', '/api/tally')).data).sort()).toEqual(['carbon', 'draws', 'season', 'silicon']);
    expect((await call('GET', '/api/diary')).data.entries).toHaveLength(2);
    expect((await call('GET', '/api/diary/2026-01-01-first')).data.entry.title).toBe('The first entry');
    expect((await call('GET', '/api/diary/nope')).status).toBe(404);
  });
  test("a game's rules come from its Markdown file, with the pictures beside it served too", async () => {
    const rules = await call('GET', '/api/games/critical-mass/rules');
    expect(rules.data.rulesMarkdown).toContain('](/api/games/critical-mass/files/hero.jpg)');
    const art = await call('GET', '/api/games/critical-mass/files/hero.jpg');
    expect(art.status).toBe(200);
    expect(art.headers.get('content-type')).toBe('image/jpeg');
    for (const bad of ['rules.md', 'nope.jpg', '..%2Fsrc%2Findex.ts', '%2Eenv.png']) {
      expect((await call('GET', `/api/games/critical-mass/files/${bad}`)).status).toBe(404);
    }
    expect((await call('GET', '/api/games/chess/files/hero.jpg')).status).toBe(404);
  });
  test('unknown routes and bad JSON get the standard error body', async () => {
    const r = await call('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.data.error.code).toBe('NOT_FOUND');
    const bad = await call('POST', '/api/agents', { raw: '{nope' });
    expect([bad.status, bad.data.error.code]).toEqual([400, 'BAD_JSON']);
  });
});

describe('identity over HTTP', () => {
  test('agents register and authenticate with a bearer token', async () => {
    const r = await call('POST', '/api/agents', { body: { name: `Byte${tag()}`, tagline: 'nom', model: 'Fable 5.1' } });
    expect(r.status).toBe(201);
    expect(r.data.identity).toMatchObject({ kind: 'agent', tagline: 'nom', model: 'Fable 5.1' });
    const me = await call('GET', '/api/me', { token: r.data.token });
    expect(me.data.identity.id).toBe(r.data.identity.id);
    expect(me.data.presence.status).toBe('ready');
    expect(me.data.activeMatch).toBeNull();
  });
  test('missing or bad credentials get 401 with a helpful message', async () => {
    const r = await call('GET', '/api/me');
    expect(r.status).toBe(401);
    expect(r.data.error.message).toContain('POST /api/agents');
    expect((await call('GET', '/api/me', { token: 'cs_nope' })).status).toBe(401);
  });
  test('humans get an httpOnly cookie; a second POST returns the same identity', async () => {
    const handle = `Human${tag()}`;
    const r = await call('POST', '/api/session', { body: { handle } });
    expect(r.status).toBe(201);
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('cs_key=csk_');
    expect(setCookie).toContain('HttpOnly');
    const cookie = setCookie.split(';')[0];
    const me = await call('GET', '/api/me', { cookie });
    expect(me.data.identity).toMatchObject({ handle, kind: 'human' });
    const again = await call('POST', '/api/session', { cookie, body: { handle: 'whatever' } });
    expect([again.status, again.data.identity.handle]).toEqual([200, handle]);
    expect((await call('POST', '/api/session', { body: { handle: 'no spaces' } })).data.error.code).toBe('HANDLE_INVALID');
  });
  test('status can be set to afk and back; playing cannot be set by hand', async () => {
    const a = await agent();
    expect((await call('PATCH', '/api/me', { token: a.token, body: { status: 'afk' } })).data.presence.status).toBe('afk');
    expect((await call('PATCH', '/api/me', { token: a.token, body: { status: 'playing' } })).data.error.code).toBe('BAD_STATUS');
    expect((await call('PATCH', '/api/me', { token: a.token, body: { status: 'ready' } })).data.presence.status).toBe('ready');
    const who = await call('GET', '/api/who');
    expect(who.data.presence.some((p: { identity: { id: string } }) => p.identity.id === a.id)).toBe(true);
  });
  test('registration is limited to 5 per hour per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/agents', { ip: '192.168.9.9', body: { name: `lim${tag()}` } })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
  test('new human identities are limited to 10 per hour per IP; an existing cookie is unaffected', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call('POST', '/api/session', { ip: '192.168.9.10', body: { handle: `Slow${tag()}` } })).status);
    expect(statuses).toEqual(Array(10).fill(201));
    const blocked = await call('POST', '/api/session', { ip: '192.168.9.10', body: { handle: `Slow${tag()}` } });
    expect(blocked.status).toBe(429);
    expect(blocked.data.error).toEqual({ code: 'SLOW_DOWN', message: 'Too many new names from here. Try again later.' });
    // the "already have a human cookie" branch never touches the limiter, even once it's exhausted
    const fresh = await call('POST', '/api/session', { ip: '192.168.9.11', body: { handle: `Steady${tag()}` } });
    expect(fresh.status).toBe(201);
    const cookie = (fresh.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await call('POST', '/api/session', { ip: '192.168.9.10', cookie, body: { handle: 'whatever' } })).status).toBe(200);
  });
});

describe('human auto-AFK', () => {
  test('a GET does not reset the idle timer; a POST does', async () => {
    const clock = new FakeClock();
    const afkCore = await createCore({
      databaseUrl: await testDatabaseUrl(),
      houseKey: 'hk',
      diaryDir,
      countdownMs: 0,
      houseFallbackMs: 60_000,
      clock,
    });
    const afkApp = createApp(afkCore, { apiDocs: '# API reference', llmsTxt: 'llms quickstart', trustProxy: true });
    try {
      const idle = await afkCore.identities.createHuman(`Idle${tag()}`);
      afkCore.presence.humanConnected(idle.identity);
      clock.advance(9 * 60_000);
      const me = await afkApp.request('/api/me', { headers: { cookie: `cs_key=${idle.key}`, 'x-forwarded-for': '10.1.0.1' } });
      expect(me.status).toBe(200);
      clock.advance(60_000);
      expect(afkCore.presence.get(idle.identity.id)?.status).toBe('afk');

      const active = await afkCore.identities.createHuman(`Active${tag()}`);
      afkCore.presence.humanConnected(active.identity);
      clock.advance(9 * 60_000);
      const post = await afkApp.request('/api/chat/lobby', {
        method: 'POST',
        headers: { cookie: `cs_key=${active.key}`, 'x-forwarded-for': '10.1.0.2', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'still here' }),
      });
      expect(post.status).toBe(201);
      clock.advance(60_000);
      expect(afkCore.presence.get(active.identity.id)?.status).toBe('ready');
    } finally {
      await afkCore.close();
    }
  });
});

describe('accounts over HTTP', () => {
  test('lock a name, sign in from a second browser, see both, sign the other out', async () => {
    const { handle, cookie: first, id, recoveryCode } = await lockedHuman();
    expect(recoveryCode).toMatch(/^csr_/);
    expect((await call('GET', '/api/me', { cookie: first })).data.identity.locked).toBe(true);
    const login = await call('POST', '/api/session/login', { body: { handle: ` ${handle.toUpperCase()} `, password: PW } });
    expect(login.status).toBe(200);
    expect(login.data.identity.id).toBe(id);
    const second = cookieOf(login);
    expect(second).toContain('cs_key=csk_');
    const listed = await call('GET', '/api/me/sessions', { cookie: second });
    expect(listed.data.sessions).toHaveLength(2);
    expect(listed.data.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect((await call('DELETE', '/api/me/sessions', { cookie: second })).data).toEqual({ revoked: 1 });
    expect((await call('GET', '/api/me', { cookie: first })).status).toBe(401);
    expect((await call('GET', '/api/me', { cookie: second })).status).toBe(200);
  });
  test('GET /api/me carries the sanction slot', async () => {
    const { cookie } = await lockedHuman('me');
    const me = await call('GET', '/api/me', { cookie });
    expect(Object.keys(me.data).sort()).toEqual(['activeMatch', 'identity', 'invites', 'presence', 'queued', 'sanction', 'table']);
    expect(me.data.sanction).toBeNull();
  });
  test('changing the password keeps this browser and signs out the rest', async () => {
    const { handle, cookie: first } = await lockedHuman('pw');
    const second = cookieOf(await call('POST', '/api/session/login', { body: { handle, password: PW } }));
    await call('GET', '/api/me', { cookie: second }); // warm the auth cache
    const wrong = await call('POST', '/api/me/password', { cookie: first, body: { current: 'nope nope nope', next: 'a whole new one' } });
    expect([wrong.status, wrong.data.error.code]).toEqual([401, 'BAD_PASSWORD']);
    expect((await call('POST', '/api/me/password', { cookie: first, body: { current: PW, next: 'a whole new one' } })).status).toBe(204);
    expect((await call('GET', '/api/me', { cookie: first })).status).toBe(200);
    expect((await call('GET', '/api/me', { cookie: second })).status).toBe(401);
    expect((await call('POST', '/api/session/login', { body: { handle, password: 'a whole new one' } })).status).toBe(200);
  });
  test('the recovery code gets a player back in and signs every old browser out', async () => {
    const { handle, cookie, recoveryCode } = await lockedHuman('lost');
    const r = await call('POST', '/api/session/recover', { body: { handle, code: recoveryCode, password: 'found it again' } });
    expect(r.status).toBe(200);
    expect(r.data.recoveryCode).toMatch(/^csr_/);
    expect((await call('GET', '/api/me', { cookie })).status).toBe(401);
    expect((await call('GET', '/api/me', { cookie: cookieOf(r) })).status).toBe(200);
    const again = await call('POST', '/api/session/recover', { body: { handle, code: recoveryCode, password: 'found it twice' } });
    expect([again.status, again.data.error.code]).toEqual([401, 'BAD_CODE']);
  });
  test('failed sign-ins are limited per handle and per IP; successes do not count', async () => {
    const { handle } = await lockedHuman('limit');
    for (let i = 0; i < 3; i++) expect((await call('POST', '/api/session/login', { body: { handle, password: PW } })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/session/login', { body: { handle, password: 'wrong wrong wrong' } })).status).toBe(401);
    const locked = await call('POST', '/api/session/login', { body: { handle, password: PW } });
    expect([locked.status, locked.data.error.code]).toEqual([429, 'SLOW_DOWN']);

    const ip = '192.168.44.44';
    for (let i = 0; i < 20; i++) {
      expect((await call('POST', '/api/session/login', { ip, body: { handle: `ghost${tag()}`, password: PW } })).status).toBe(401);
    }
    expect((await call('POST', '/api/session/login', { ip, body: { handle: `ghost${tag()}`, password: PW } })).status).toBe(429);
  });
  test('concurrent failed sign-ins cannot all slip past the limit', async () => {
    const { handle } = await lockedHuman('race');
    const ip = '192.168.55.55';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('POST', '/api/session/login', { ip, body: { handle, password: 'wrong wrong wrong' } })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([...Array(5).fill(401), ...Array(5).fill(429)]);
    expect(results.filter((r) => r.status === 429).every((r) => r.data.error.code === 'SLOW_DOWN')).toBe(true);
  });
  test('a successful login does not spend a failure token', async () => {
    const { handle } = await lockedHuman('nospend');
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/session/login', { body: { handle, password: PW } })).status).toBe(200);
    const wrong = await call('POST', '/api/session/login', { body: { handle, password: 'wrong wrong wrong' } });
    expect([wrong.status, wrong.data.error.code]).toEqual([401, 'BAD_PASSWORD']);
  });
  test('password checks on /api/me/password are limited per person: concurrent guesses cannot all slip through', async () => {
    const { cookie } = await lockedHuman('guess');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('POST', '/api/me/password', { cookie, body: { current: 'wrong wrong wrong', next: 'a whole new one' } })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([...Array(5).fill(401), ...Array(5).fill(429)]);
    expect(results.filter((r) => r.status === 429).every((r) => r.data.error.code === 'SLOW_DOWN')).toBe(true);
  });
  test('password checks on DELETE /api/me are limited per person too', async () => {
    const { cookie } = await lockedHuman('guessdel');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('DELETE', '/api/me', { cookie, body: { password: 'wrong wrong wrong' } })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([...Array(5).fill(401), ...Array(5).fill(429)]);
    expect(results.filter((r) => r.status === 429).every((r) => r.data.error.code === 'SLOW_DOWN')).toBe(true);
    expect((await call('GET', '/api/me', { cookie })).status).toBe(200); // still there
  });
  test('a right password does not spend a token on /api/me/password', async () => {
    const { cookie } = await lockedHuman('rightpw');
    let current = PW;
    for (let i = 0; i < 6; i++) {
      const next = `a new password no ${i}`;
      expect((await call('POST', '/api/me/password', { cookie, body: { current, next } })).status).toBe(204);
      current = next;
    }
    const wrong = await call('POST', '/api/me/password', { cookie, body: { current: 'wrong wrong wrong', next: 'whatever it is' } });
    expect([wrong.status, wrong.data.error.code]).toEqual([401, 'BAD_PASSWORD']);
  });
  test('even successful sign-ins are capped per IP (30 per 15 minutes)', async () => {
    const { handle } = await lockedHuman('often');
    const ip = '192.168.66.66';
    for (let i = 0; i < 30; i++) expect((await call('POST', '/api/session/login', { ip, body: { handle, password: PW } })).status).toBe(200);
    const capped = await call('POST', '/api/session/login', { ip, body: { handle, password: PW } });
    expect([capped.status, capped.data.error.code]).toEqual([429, 'SLOW_DOWN']);
    expect((await call('POST', '/api/session/login', { body: { handle, password: PW } })).status).toBe(200); // another address is fine
  });
  test('signing out revokes this browser only', async () => {
    const { handle, cookie: first } = await lockedHuman('out');
    const second = cookieOf(await call('POST', '/api/session/login', { body: { handle, password: PW } }));
    const out = await call('DELETE', '/api/session', { cookie: first });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('cs_key=;');
    expect((await call('GET', '/api/me', { cookie: first })).status).toBe(401);
    expect((await call('GET', '/api/me', { cookie: second })).status).toBe(200);
  });
});

describe('profiles over HTTP', () => {
  test('set a bio and read the profile; unknown names are 404', async () => {
    const { handle, cookie } = await lockedHuman('bio');
    const patched = await call('PATCH', '/api/me', { cookie, body: { tagline: 'Human. Asks about technology.' } });
    expect(patched.data.identity.tagline).toBe('Human. Asks about technology.');
    const p = await call('GET', `/api/users/${handle}`);
    expect(p.status).toBe(200);
    expect(p.data).toMatchObject({ identity: { handle, tagline: 'Human. Asks about technology.', locked: true }, matches: [] });
    const missing = await call('GET', '/api/users/nobody-at-all');
    expect([missing.status, missing.data.error.code]).toEqual([404, 'NO_USER']);
  });
  test('a guest deletes their account; the name is free again', async () => {
    const handle = `short${tag()}`;
    const cookie = cookieOf(await call('POST', '/api/session', { body: { handle } }));
    expect((await call('DELETE', '/api/me', { cookie })).status).toBe(204);
    expect((await call('GET', '/api/me', { cookie })).status).toBe(401);
    expect((await call('POST', '/api/session', { body: { handle } })).status).toBe(201);
  });
  test('a locked name needs its password to delete', async () => {
    const { cookie } = await lockedHuman('keep');
    const refused = await call('DELETE', '/api/me', { cookie, body: { password: 'not the password' } });
    expect([refused.status, refused.data.error.code]).toEqual([401, 'BAD_PASSWORD']);
    expect((await call('DELETE', '/api/me', { cookie, body: { password: PW } })).status).toBe(204);
  });
});

describe('chat and inbox over HTTP', () => {
  test('post, read, and get mentioned', async () => {
    const a = await agent('talker');
    const b = await agent('listener');
    const posted = await call('POST', '/api/chat/lobby', { token: a.token, body: { text: `hi @${b.handle}` } });
    expect(posted.status).toBe(201);
    const read = await call('GET', '/api/chat/lobby?limit=5');
    expect(read.data.messages.at(-1).text).toBe(`hi @${b.handle}`);
    const inbox = (await call('GET', '/api/inbox?since=0&waitMs=0', { token: b.token })).data as InboxPoll;
    expect(inbox.events.map((e) => e.type)).toEqual(['chat.mention']);
    expect((await call('POST', '/api/chat/nowhere', { token: a.token, body: { text: 'x' } })).status).toBe(404);
    expect((await call('POST', '/api/chat/lobby', { body: { text: 'x' } })).status).toBe(401);
  });
});

describe('a full match over plain HTTP', () => {
  test('two agents quick-match and play Critical Mass to the end', async () => {
    const red = await agent('alpha');
    const blue = await agent('omega');
    expect((await call('POST', '/api/quickmatch', { token: red.token, body: { gameId: 'critical-mass' } })).data).toEqual({ status: 'queued' });
    expect((await call('GET', '/api/me', { token: red.token })).data.queued).toBe('critical-mass');
    const matched = await call('POST', '/api/quickmatch', { token: blue.token, body: { gameId: 'critical-mass' } });
    expect(matched.data.status).toBe('matched');
    const matchId: string = matched.data.match.id;
    const byId: Record<string, string> = { [red.id]: red.token, [blue.id]: blue.token };

    let env = (await call('GET', `/api/matches/${matchId}?since=1&waitMs=3000`, { token: red.token })).data as MatchEnvelope;
    expect(env.match.status).toBe('live');

    let moves = 0;
    let usedShorthand = false;
    while (env.match.status === 'live' && moves < 2000) {
      const seatInfo = env.match.seats.find((s) => s.seat === env.match.toMove[0])!;
      const token = byId[seatInfo.identity.id];
      const mine = (await call('GET', `/api/matches/${matchId}`, { token })).data as MatchEnvelope;
      const cell = (mine.legal[moves % mine.legal.length] as CMCommand).cell;
      const body = usedShorthand ? { revision: mine.match.revision, command: { cell } } : { revision: mine.match.revision, cell };
      usedShorthand = true;
      const r = await call('POST', `/api/matches/${matchId}/move`, { token, body });
      expect(r.status).toBe(200);
      env = r.data;
      moves++;
    }
    expect(env.match.status).toBe('over');
    expect(env.match.outcome?.winners).toHaveLength(1);
    const winnerSeat = env.match.outcome!.winners[0];
    const winner = env.match.seats.find((s) => s.seat === winnerSeat)!.identity.id;
    let sawOver = false;
    for (let i = 0; i < 50 && !sawOver; i++) {
      const inbox = (await call('GET', '/api/inbox?since=0&waitMs=100', { token: byId[winner] })).data as InboxPoll;
      sawOver = inbox.events.some((e) => e.type === 'match.over' && e.result === 'win');
    }
    expect(sawOver).toBe(true);
    const spectator = (await call('GET', `/api/matches/${matchId}`)).data as MatchEnvelope;
    expect(spectator.you).toBeNull();
  });
  test('stale revisions and missing commands are explained', async () => {
    const a = await agent('stale');
    const b = await agent('fresh');
    await call('POST', '/api/quickmatch', { token: a.token, body: { gameId: 'critical-mass' } });
    const m = await call('POST', '/api/quickmatch', { token: b.token, body: { gameId: 'critical-mass' } });
    const id = m.data.match.id;
    const env = (await call('GET', `/api/matches/${id}?since=1&waitMs=3000`, { token: a.token })).data as MatchEnvelope;
    const mover = env.match.seats.find((s) => s.seat === env.match.toMove[0])!.identity.id === a.id ? a : b;
    const stale = await call('POST', `/api/matches/${id}/move`, { token: mover.token, body: { revision: 1, cell: 'a1' } });
    expect([stale.status, stale.data.error.code]).toEqual([409, 'STALE_REVISION']);
    const missing = await call('POST', `/api/matches/${id}/move`, { token: mover.token, body: { revision: env.match.revision } });
    expect([missing.status, missing.data.error.code]).toEqual([400, 'BAD_COMMAND']);
    const resign = await call('POST', `/api/matches/${id}/resign`, { token: mover.token });
    expect(resign.data.match.status).toBe('over');
    expect((await call('DELETE', '/api/quickmatch', { token: a.token })).data).toEqual({ left: false });
  });
  test('long-polling a match needs credentials; a plain read does not', async () => {
    const a = await agent('poller');
    const b = await agent('polled');
    await call('POST', '/api/quickmatch', { token: a.token, body: { gameId: 'critical-mass' } });
    const id = (await call('POST', '/api/quickmatch', { token: b.token, body: { gameId: 'critical-mass' } })).data.match.id;
    const anon = await call('GET', `/api/matches/${id}?since=1&waitMs=10`);
    expect([anon.status, anon.data.error.code]).toEqual([401, 'UNAUTHORIZED']);
    expect((await call('GET', `/api/matches/${id}?since=1&waitMs=10`, { token: a.token })).status).toBe(200);
    expect((await call('GET', `/api/matches/${id}`)).status).toBe(200);
    await call('POST', `/api/matches/${id}/resign`, { token: a.token });
  });
});

describe('client IPs', () => {
  test('without trustProxy, a forged X-Forwarded-For does not dodge the per-IP limits', async () => {
    const strict = createApp(core, { apiDocs: '', llmsTxt: '' });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await strict.request('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `172.16.0.${i + 1}` },
        body: JSON.stringify({ name: `forge${tag()}` }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

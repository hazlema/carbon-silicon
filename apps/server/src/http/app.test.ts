import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import type { InboxPoll, MatchEnvelope } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: [], diaryDir, countdownMs: 0, houseFallbackMs: 60_000 });
const app = createApp(core, { apiDocs: '# API reference', llmsTxt: 'llms quickstart' });
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
const tag = () => Math.random().toString(36).slice(2, 8);
async function agent(prefix = 'bot') {
  const r = await call('POST', '/api/agents', { body: { name: `${prefix}${tag()}` } });
  expect(r.status).toBe(201);
  return { token: r.data.token as string, id: r.data.identity.id as string, handle: r.data.identity.handle as string };
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
    expect((await call('GET', '/api/games')).data.games).toHaveLength(1);
    const rules = await call('GET', '/api/games/critical-mass/rules');
    expect(rules.data.rulesMarkdown).toContain('# Critical Mass');
    expect(rules.data.turnSeconds).toBe(90);
    expect((await call('GET', '/api/games/chess/rules')).status).toBe(404);
    expect(Object.keys((await call('GET', '/api/tally')).data).sort()).toEqual(['carbon', 'draws', 'season', 'silicon']);
    expect((await call('GET', '/api/diary')).data.entries).toHaveLength(2);
    expect((await call('GET', '/api/diary/2026-01-01-first')).data.entry.title).toBe('The first entry');
    expect((await call('GET', '/api/diary/nope')).status).toBe(404);
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
});

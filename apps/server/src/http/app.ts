import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { seasonOf, type IdentityPublic } from '@cs/shared/protocol';
import type { Core } from '../core/core';
import { AppError, badRequest, notFound, tooMany, unauthorized } from '../lib/errors';
import { RateLimiter } from '../lib/ratelimit';
import { apiIndex } from './index-doc';

export type AppEnv = { Bindings: { ip?: string }; Variables: { identity: IdentityPublic | null } };
export interface AppOptions {
  apiDocs: string;
  llmsTxt: string;
  secureCookies?: boolean;
}

const COOKIE = 'cs_key';
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;

export function createApp(core: Core, opts: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const registrations = new RateLimiter(core.clock, 5, 5 / 3_600_000);
  const sessions = new RateLimiter(core.clock, 10, 10 / 3_600_000);

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error('[http]', err);
    return c.json({ error: { code: 'INTERNAL', message: 'Something broke on our side. The Proprietor will look into it.' } }, 500);
  });
  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route ${c.req.method} ${c.req.path}. Try GET /api.` } }, 404),
  );

  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const identity = await core.identities.authenticate(bearer ?? getCookie(c, COOKIE));
    c.set('identity', identity);
    if (identity?.kind === 'agent') core.presence.agentSeen(identity);
    else if (identity && c.req.method !== 'GET') core.presence.humanActivity(identity.id);
    await next();
  });

  const me = (c: Context<AppEnv>): IdentityPublic => {
    const identity = c.get('identity');
    if (!identity) {
      throw unauthorized('UNAUTHORIZED', 'Send "Authorization: Bearer <token>". Agents get a token from POST /api/agents.');
    }
    return identity;
  };
  const body = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      throw badRequest('BAD_JSON', 'The body must be a JSON object.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('BAD_JSON', 'The body must be a JSON object.');
    return data as Record<string, unknown>;
  };
  const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw badRequest('BAD_QUERY', `"${raw}" is not a number.`);
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const clientIp = (c: Context<AppEnv>) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.env?.ip || 'local';

  // ── discovery ──
  app.get('/api', (c) => c.json(apiIndex(core)));
  app.get('/api/docs', (c) => c.body(opts.apiDocs, 200, { 'content-type': 'text/markdown; charset=utf-8' }));
  app.get('/llms.txt', (c) => c.text(opts.llmsTxt));

  // ── identity ──
  app.post('/api/agents', async (c) => {
    if (!registrations.take(clientIp(c))) throw tooMany('SLOW_DOWN', 'Too many registrations from here. Try again later.');
    const b = await body(c);
    const result = await core.identities.registerAgent(b, c.req.header('x-house-key') ?? null);
    core.presence.agentSeen(result.identity);
    return c.json(result, 201);
  });
  app.post('/api/session', async (c) => {
    const current = c.get('identity');
    if (current?.kind === 'human') return c.json({ identity: current }, 200);
    if (!sessions.take(clientIp(c))) throw tooMany('SLOW_DOWN', 'Too many new names from here. Try again later.');
    const b = await body(c);
    const { identity, key } = await core.identities.createHuman(b.handle);
    setCookie(c, COOKIE, key, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      secure: opts.secureCookies ?? false,
    });
    return c.json({ identity }, 201);
  });
  app.delete('/api/session', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  app.get('/api/me', (c) => {
    const who = me(c);
    return c.json({
      identity: who,
      presence: core.presence.get(who.id),
      activeMatch: core.games.activeMatchOf(who.id),
      queued: core.invites.queuedFor(who.id),
    });
  });
  app.patch('/api/me', async (c) => {
    const who = me(c);
    const b = await body(c);
    if (b.status !== undefined) {
      if (b.status !== 'ready' && b.status !== 'afk') {
        throw badRequest('BAD_STATUS', 'status is "ready" or "afk" ("playing" is set automatically).');
      }
      core.presence.setManualStatus(who, b.status);
    }
    return c.json({ presence: core.presence.get(who.id) });
  });
  app.get('/api/who', (c) => c.json({ presence: core.presence.list() }));

  // ── inbox and chat ──
  app.get('/api/inbox', async (c) => {
    const who = me(c);
    const since = int(c.req.query('since'), 0, 0, MAX_CURSOR);
    const waitMs = int(c.req.query('waitMs'), 25_000, 0, 30_000);
    return c.json(await core.comms.poll(who.id, since, waitMs));
  });
  app.get('/api/chat/:channel', async (c) => {
    const sinceRaw = c.req.query('since');
    const messages = await core.comms.history(c.req.param('channel'), {
      since: sinceRaw === undefined ? undefined : int(sinceRaw, 0, 0, MAX_CURSOR),
      limit: int(c.req.query('limit'), 50, 1, 200),
    });
    return c.json({ messages });
  });
  app.post('/api/chat/:channel', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ message: await core.comms.post(who, c.req.param('channel'), b.text) }, 201);
  });

  // ── matchmaking ──
  app.post('/api/quickmatch', async (c) => {
    const who = me(c);
    const b = await body(c);
    if (typeof b.gameId !== 'string') throw badRequest('BAD_GAME', 'Send {"gameId": "critical-mass"}.');
    return c.json(await core.invites.quickMatch(who, b.gameId));
  });
  app.delete('/api/quickmatch', (c) => c.json({ left: core.invites.leave(me(c).id) }));

  // ── games and matches ──
  app.get('/api/games', (c) => c.json({ games: core.games.catalog() }));
  app.get('/api/games/:id/rules', (c) => {
    const module = core.games.module(c.req.param('id'));
    const game = core.games.catalog().find((g) => g.id === module.meta.id);
    return c.json({
      game,
      rulesMarkdown: module.meta.rulesMarkdown,
      turnSeconds: module.turn?.turnSeconds ?? null,
      doctrine: module.realtime?.catalog ?? null,
    });
  });
  app.get('/api/matches/:id', async (c) => {
    const id = c.req.param('id');
    const sinceRaw = c.req.query('since');
    if (sinceRaw !== undefined) {
      await core.games.wait(id, int(sinceRaw, 0, 0, MAX_CURSOR), int(c.req.query('waitMs'), 25_000, 0, 30_000));
    }
    return c.json(core.games.envelope(id, c.get('identity')?.id ?? null));
  });
  app.post('/api/matches/:id/move', async (c) => {
    const who = me(c);
    const { revision, command, ...rest } = await body(c);
    const cmd = command !== undefined ? command : Object.keys(rest).length > 0 ? rest : undefined;
    if (cmd === undefined) {
      throw badRequest('BAD_COMMAND', 'Send {"revision": n, "command": {...}}, e.g. {"revision": 7, "command": {"cell": "c4"}}.');
    }
    return c.json(await core.games.move(c.req.param('id'), who, revision, cmd));
  });
  app.post('/api/matches/:id/resign', async (c) => c.json(await core.games.resign(c.req.param('id'), me(c))));

  // ── the rest ──
  app.get('/api/tally', async (c) => c.json(await core.leaderboard.tally(c.req.query('season') ?? seasonOf(core.clock.now()))));
  app.get('/api/diary', (c) => c.json({ entries: core.diary.summaries() }));
  app.get('/api/diary/:slug', (c) => {
    const entry = core.diary.get(c.req.param('slug'));
    if (!entry) throw notFound('NO_ENTRY', 'No such diary entry.');
    return c.json({ entry });
  });

  return app;
}

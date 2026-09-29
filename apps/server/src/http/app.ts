import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { LiveText, textOf, type TextSource } from '@cs/shared/live-text';
import { seasonOf, type IdentityPublic, type MeResponse, type ProfilePage } from '@cs/shared/protocol';
import type { Core } from '../core/core';
import type { SessionMeta } from '../core/identity';
import { peopleFilterOf } from '../core/moderation';
import { assertStaff, type Actor } from '../core/powers';
import { AppError, badRequest, forbidden, notFound, tooMany } from '../lib/errors';
import { clientIp as resolveIp } from '../lib/ip';
import { RateLimiter } from '../lib/ratelimit';
import { sessionLabel } from '../lib/ua';
import { consoleRoutes } from './console';
import { dmRoutes } from './dms';
import { apiIndex } from './index-doc';
import { body, me, optionalBody } from './request';
import { tableRoutes } from './tables';

export type AppEnv = { Bindings: { ip?: string }; Variables: { identity: IdentityPublic | null; sessionId: string | null } };
export interface AppOptions {
  apiDocs: TextSource;
  llmsTxt: TextSource;
  /** Where games' `rulesPath`s start from; defaults to the repo root. */
  root?: string;
  secureCookies?: boolean;
  /** The console's shared secret (`bun run admin`); null or unset switches the console off. */
  adminKey?: string | null;
  /** Trust X-Forwarded-For (set when nginx is in front). */
  trustProxy?: boolean;
}

const COOKIE = 'cs_key';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** Pictures a game's rules may show, by extension. Anything else beside the rules stays unserved. */
const RULES_ART: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
/** `![alt](hero.jpg)` → `![alt](/api/games/<id>/files/hero.jpg)`, so the file previews in an editor and renders on the site. */
const pointArtAt = (markdown: string, gameId: string) =>
  markdown.replace(/(!\[[^\]]*\]\()([\w-]+\.\w+)(\))/g, `$1/api/games/${gameId}/files/$2$3`);
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;

export function createApp(core: Core, opts: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const registrations = new RateLimiter(core.clock, 5, 5 / 3_600_000);
  const sessions = new RateLimiter(core.clock, 10, 10 / 3_600_000);
  // Failed sign-ins and recoveries only: 5 per handle and 20 per IP per 15 minutes.
  const loginsByHandle = new RateLimiter(core.clock, 5, 5 / 900_000);
  const loginsByIp = new RateLimiter(core.clock, 20, 20 / 900_000);
  // Wrong passwords on /api/me/password and DELETE /api/me: 5 per signed-in person per 15 minutes
  // (and they share the per-IP failure budget above).
  const checksByIdentity = new RateLimiter(core.clock, 5, 5 / 900_000);
  // Wrong agent tokens on POST /api/me/agents: 5 per person per 15 minutes (and the shared per-IP failure budget).
  const linksByIdentity = new RateLimiter(core.clock, 5, 5 / 900_000);
  // Every sign-in, right or wrong: 30 per IP per 15 minutes, so a known password can't drive
  // unlimited argon2 verifies and session rows.
  const signInsByIp = new RateLimiter(core.clock, 30, 30 / 900_000);

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error('[http]', err);
    return c.json({ error: { code: 'INTERNAL', message: 'Something broke on our side. The Proprietor will look into it.' } }, 500);
  });
  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route ${c.req.method} ${c.req.path}. Try GET /api.` } }, 404),
  );

  const clientIp = (c: Context<AppEnv>) => resolveIp(c.req.header('x-forwarded-for'), c.env?.ip, opts.trustProxy ?? false);

  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const auth = await core.identities.authenticateSession(bearer ?? getCookie(c, COOKIE));
    const identity = auth?.identity ?? null;
    c.set('identity', identity);
    c.set('sessionId', auth?.sessionId ?? null);
    if (auth) core.identities.touch(auth.identity.id, clientIp(c), auth.sessionId);
    if (identity?.kind === 'agent') core.presence.agentSeen(identity);
    else if (identity && c.req.method !== 'GET') core.presence.humanActivity(identity.id);
    await next();
  });

  const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw badRequest('BAD_QUERY', `"${raw}" is not a number.`);
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const meta = (c: Context<AppEnv>): SessionMeta => ({ label: sessionLabel(c.req.header('user-agent')), ip: clientIp(c) });
  const setSessionCookie = (c: Context<AppEnv>, key: string) =>
    setCookie(c, COOKIE, key, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      secure: opts.secureCookies ?? false,
    });
  /**
   * Runs a password (or recovery code) check under the failure limits; only a wrong password or
   * code spends a token. Both tokens — per IP and per `key` — are reserved up front (synchronously,
   * so concurrent requests can't all slip past the check before any of them spends one) and
   * refunded unless the attempt ends in a counted failure.
   */
  const limitedCheck = async <T>(
    c: Context<AppEnv>,
    byKey: RateLimiter,
    key: string,
    message: string,
    attempt: () => Promise<T>,
  ): Promise<T> => {
    const ip = clientIp(c);
    const ipReserved = loginsByIp.take(ip);
    const keyReserved = byKey.take(key);
    if (!ipReserved || !keyReserved) {
      if (ipReserved) loginsByIp.refund(ip);
      if (keyReserved) byKey.refund(key);
      throw tooMany('SLOW_DOWN', message);
    }
    try {
      const result = await attempt();
      loginsByIp.refund(ip);
      byKey.refund(key);
      return result;
    } catch (e) {
      if (e instanceof AppError && (e.code === 'BAD_PASSWORD' || e.code === 'BAD_CODE' || e.code === 'BAD_TOKEN')) throw e; // counted: keep the spent token
      loginsByIp.refund(ip);
      byKey.refund(key);
      throw e;
    }
  };
  const limitedSignIn = <T>(c: Context<AppEnv>, handle: unknown, attempt: () => Promise<T>): Promise<T> =>
    limitedCheck(c, loginsByHandle, typeof handle === 'string' ? handle.trim().toLowerCase() : '', 'Too many sign-in attempts. Try again in a few minutes.', attempt);
  /** For a signed-in person re-entering their password (change it, delete the name). */
  const limitedPasswordCheck = <T>(c: Context<AppEnv>, who: IdentityPublic, attempt: () => Promise<T>): Promise<T> =>
    limitedCheck(c, checksByIdentity, who.id, 'Too many password attempts. Try again in a few minutes.', attempt);

  // ── discovery ──
  app.get('/api', (c) => c.json(apiIndex(core)));
  app.get('/api/docs', async (c) => c.body(await textOf(opts.apiDocs), 200, { 'content-type': 'text/markdown; charset=utf-8' }));
  app.get('/llms.txt', async (c) => c.text(await textOf(opts.llmsTxt)));

  // ── identity ──
  app.post('/api/agents', async (c) => {
    if (core.moderation.isIpBanned(clientIp(c))) throw forbidden('BANNED', 'New names are not accepted from your network.');
    if (!registrations.take(clientIp(c))) throw tooMany('SLOW_DOWN', 'Too many registrations from here. Try again later.');
    const b = await body(c);
    const result = await core.identities.registerAgent(b, c.req.header('x-house-key') ?? null);
    core.presence.agentSeen(result.identity);
    return c.json(result, 201);
  });
  app.post('/api/session', async (c) => {
    const current = c.get('identity');
    if (current?.kind === 'human') return c.json({ identity: current }, 200);
    if (core.moderation.isIpBanned(clientIp(c))) throw forbidden('BANNED', 'New names are not accepted from your network.');
    if (!sessions.take(clientIp(c))) throw tooMany('SLOW_DOWN', 'Too many new names from here. Try again later.');
    const b = await body(c);
    const { identity, key } = await core.identities.createHuman(b.handle, meta(c));
    setSessionCookie(c, key);
    return c.json({ identity }, 201);
  });
  app.post('/api/session/login', async (c) => {
    const b = await body(c);
    if (!signInsByIp.take(clientIp(c))) throw tooMany('SLOW_DOWN', 'Too many sign-ins from here. Try again in a few minutes.');
    const { identity, key } = await limitedSignIn(c, b.handle, () => core.accounts.login(b.handle, b.password, meta(c)));
    setSessionCookie(c, key);
    return c.json({ identity });
  });
  app.post('/api/session/recover', async (c) => {
    const b = await body(c);
    const { identity, key, recoveryCode } = await limitedSignIn(c, b.handle, () =>
      core.accounts.recover(b.handle, b.code, b.password, meta(c)),
    );
    setSessionCookie(c, key);
    return c.json({ identity, recoveryCode });
  });
  app.delete('/api/session', async (c) => {
    const who = c.get('identity');
    const sessionId = c.get('sessionId');
    if (who && sessionId) await core.accounts.revokeSession(who.id, sessionId);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  app.get('/api/me', (c) => {
    const who = me(c);
    const out: MeResponse = {
      identity: who,
      presence: core.presence.get(who.id),
      activeMatch: core.games.activeMatchOf(who.id),
      queued: core.invites.queuedFor(who.id),
      sanction: core.moderation.sanctionOf(who.id),
      table: core.tables.tableFor(who.id),
      invites: core.tables.offersFor(who.id),
    };
    return c.json(out);
  });
  app.patch('/api/me', async (c) => {
    let who = me(c);
    const b = await body(c);
    if (b.status !== undefined) {
      if (b.status !== 'ready' && b.status !== 'afk') {
        throw badRequest('BAD_STATUS', 'status is "ready" or "afk" ("playing" is set automatically).');
      }
      core.presence.setManualStatus(who, b.status);
    }
    if (b.tagline !== undefined) who = await core.accounts.setBio(who, b.tagline);
    return c.json({ identity: who, presence: core.presence.get(who.id) });
  });
  app.delete('/api/me', async (c) => {
    const who = me(c);
    const b = await optionalBody(c);
    // guard and password come first: a refusal touches nothing
    await limitedPasswordCheck(c, who, () => core.accounts.deleteSelf(who, b.password));
    // Only once deletion actually happens: leave the queue and resign any match in progress,
    // exactly like a moderator's release (ModerationManager.bench does the same two calls).
    await core.moderation.bench(who);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  app.post('/api/me/lock', async (c) => {
    const b = await body(c);
    return c.json(await core.accounts.lock(me(c), b.password));
  });
  app.post('/api/me/password', async (c) => {
    const who = me(c);
    const b = await body(c);
    await limitedPasswordCheck(c, who, () => core.accounts.changePassword(who, b.current, b.next, c.get('sessionId')));
    return c.body(null, 204);
  });
  app.get('/api/me/sessions', async (c) => {
    const who = me(c);
    return c.json({ sessions: await core.accounts.sessions(who.id, c.get('sessionId')) });
  });
  app.delete('/api/me/sessions', async (c) => {
    const who = me(c);
    return c.json({ revoked: await core.accounts.revokeOthers(who.id, c.get('sessionId')) });
  });
  app.delete('/api/me/sessions/:id', async (c) => {
    const who = me(c);
    if (!(await core.accounts.revokeSession(who.id, c.req.param('id')))) throw notFound('NO_SESSION', 'No such session.');
    return c.body(null, 204);
  });
  app.get('/api/me/agents', async (c) => c.json({ agents: await core.owners.agents(me(c).id) }));
  app.post('/api/me/agents', async (c) => {
    const who = me(c);
    const b = await body(c);
    const agent = await limitedCheck(c, linksByIdentity, who.id, 'Too many wrong tokens. Try again in a few minutes.', () => core.owners.link(who, b.token));
    return c.json({ agent }, 201);
  });
  app.delete('/api/me/agents/:handle', async (c) => c.json({ agents: await core.owners.unlink(me(c), c.req.param('handle')) }));
  app.delete('/api/me/owner', async (c) => c.json({ identity: await core.owners.drop(me(c)) }));
  app.get('/api/users/:handle', async (c) => {
    const profile = await core.profiles.profile(c.req.param('handle'));
    const agents = profile.identity.kind === 'human' ? await core.owners.agents(profile.identity.id) : [];
    // A sanction's reason can quote a reported DM: only the owner and staff see it.
    const viewer = c.get('identity');
    const seesSanctions = viewer?.id === profile.identity.id || viewer?.role === 'mod' || viewer?.role === 'admin';
    const page: ProfilePage = { ...profile, agents: seesSanctions ? agents : agents.map((a) => ({ ...a, sanction: null })) };
    return c.json(page);
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
      viewer: c.get('identity'),
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
  const rulesTexts = new Map<string, LiveText>();
  const rulesFile = (meta: { rulesPath: string }) => join(opts.root ?? REPO_ROOT, meta.rulesPath);
  app.get('/api/games/:id/rules', async (c) => {
    const module = core.games.module(c.req.param('id'));
    const { id, name } = module.meta;
    const game = core.games.catalog().find((g) => g.id === id);
    let rules = rulesTexts.get(id);
    if (!rules) rulesTexts.set(id, (rules = new LiveText({ path: rulesFile(module.meta), fallback: `# ${name}\n\nThe rules aren't written yet.` })));
    return c.json({
      game,
      rulesMarkdown: pointArtAt(await rules.get(), id),
      turnSeconds: module.turn?.turnSeconds ?? null,
      doctrine: module.realtime?.catalog ?? null,
    });
  });
  app.get('/api/games/:id/files/:name', async (c) => {
    const module = core.games.module(c.req.param('id'));
    const name = c.req.param('name');
    const ext = /^[\w-]+\.(\w+)$/.exec(name)?.[1];
    const type = ext && RULES_ART[ext.toLowerCase()];
    const file = Bun.file(join(dirname(rulesFile(module.meta)), name));
    if (!type || !(await file.exists())) throw notFound('NO_FILE', 'No such file beside these rules.');
    return c.body(await file.arrayBuffer(), 200, { 'content-type': type, 'cache-control': 'no-cache' });
  });
  app.get('/api/matches/:id', async (c) => {
    const id = c.req.param('id');
    const sinceRaw = c.req.query('since');
    if (sinceRaw !== undefined) {
      me(c); // a long-poll holds a connection open for up to 30 s; only signed-in callers may park one
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

  // ── ignore, block and reports ──
  const actorOf = (c: Context<AppEnv>): Actor => ({ kind: 'identity', identity: me(c) });
  /** Every mod route needs "is staff, and not suspended" (the read-only ones included); the
   *  managers then check the power table and the guard again for each action. */
  const staffOf = (c: Context<AppEnv>): Actor => {
    const actor = actorOf(c);
    assertStaff(actor);
    core.guard.assert(me(c), 'moderate');
    return actor;
  };
  const personId = async (handle: string): Promise<string> => {
    const target = await core.identities.getByHandle(handle);
    if (!target || target.released) throw notFound('NO_USER', `There is no @${handle}.`);
    return target.id;
  };

  app.get('/api/me/relations', async (c) => c.json(await core.relations.list(me(c).id)));
  for (const [path, kind] of [
    ['ignores', 'ignore'],
    ['blocks', 'block'],
  ] as const) {
    app.put(`/api/me/${path}/:handle`, async (c) => c.json(await core.relations.set(me(c), c.req.param('handle'), kind)));
    app.delete(`/api/me/${path}/:handle`, async (c) => c.json(await core.relations.clear(me(c), c.req.param('handle'), kind)));
  }
  app.post('/api/report', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ report: await core.reports.create(who, b.messageId, b.reason) }, 201);
  });

  // ── moderation ──
  app.get('/api/mod/reports', async (c) => {
    staffOf(c);
    const status = c.req.query('status') ?? 'open';
    if (status !== 'open' && status !== 'resolved' && status !== 'all') {
      throw badRequest('BAD_QUERY', 'status is "open", "resolved" or "all".');
    }
    return c.json({ reports: await core.reports.list(status, { resolvedBy: c.req.query('resolvedBy') || undefined }) });
  });
  app.post('/api/mod/reports/:id/resolve', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ report: await core.reports.resolve(actor, c.req.param('id'), b.resolution, b.reason, b.minutes) });
  });
  app.post('/api/mod/reports/:id/reopen', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ report: await core.reports.reopen(actor, c.req.param('id'), b.reason) });
  });
  app.post('/api/mod/reports/:id/notes', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ report: await core.reports.addNote(actor, c.req.param('id'), b.text) });
  });
  app.get('/api/mod/people', async (c) => {
    staffOf(c);
    return c.json({ people: await core.moderation.people(c.req.query('q') ?? '', peopleFilterOf(c.req.query('filter'))) });
  });
  app.get('/api/mod/people/:handle', async (c) => {
    staffOf(c);
    return c.json(await core.moderation.person(c.req.param('handle')));
  });
  app.post('/api/mod/people/:handle/mute', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ sanction: await core.moderation.mute(actor, await personId(c.req.param('handle')), b.reason, b.minutes) });
  });
  app.post('/api/mod/people/:handle/suspend', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ sanction: await core.moderation.suspend(actor, await personId(c.req.param('handle')), b.reason, b.minutes) });
  });
  app.post('/api/mod/people/:handle/lift', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    await core.moderation.lift(actor, await personId(c.req.param('handle')), b.reason);
    return c.body(null, 204);
  });
  app.post('/api/mod/people/:handle/role', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ identity: await core.moderation.setRole(actor, await personId(c.req.param('handle')), b.role, b.reason) });
  });
  app.post('/api/mod/people/:handle/reset-password', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ code: await core.moderation.resetPassword(actor, await personId(c.req.param('handle')), b.reason) });
  });
  app.post('/api/mod/people/:handle/release', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    await core.moderation.release(actor, await personId(c.req.param('handle')), b.reason);
    return c.body(null, 204);
  });
  app.delete('/api/mod/messages/:id', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    return c.json({ message: await core.moderation.deleteMessage(actor, Number(c.req.param('id')), b.reason) });
  });
  app.post('/api/mod/ip-bans', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    await core.moderation.banIp(actor, b.ip, b.reason);
    return c.body(null, 204);
  });
  app.delete('/api/mod/ip-bans/:ip', async (c) => {
    const actor = staffOf(c);
    const b = await body(c);
    await core.moderation.unbanIp(actor, c.req.param('ip'), b.reason);
    return c.body(null, 204);
  });
  app.get('/api/mod/log', async (c) => {
    staffOf(c);
    const handle = c.req.query('handle');
    const beforeRaw = c.req.query('before');
    return c.json({
      entries: await core.moderation.log({
        before: beforeRaw === undefined ? undefined : int(beforeRaw, 0, 0, MAX_CURSOR),
        targetId: handle ? await personId(handle) : undefined,
      }),
    });
  });

  app.route('/api', tableRoutes(core));
  app.route('/api', dmRoutes(core));

  app.route('/api/console', consoleRoutes(core, opts.adminKey ?? null));

  return app;
}

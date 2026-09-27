import { Hono, type Context } from 'hono';
import type { IdentityPublic, Role } from '@cs/shared/protocol';
import type { Core } from '../core/core';
import type { Actor } from '../core/powers';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type { AppEnv } from './app';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CONSOLE: Actor = { kind: 'console' };

/** The socket address only. Task 10 swaps this for the shared isLoopback in lib/ip.ts. */
const isLoopback = (ip: string | undefined | null): boolean => !!ip && LOOPBACK.has(ip);

/**
 * `bun run admin` lands here. Shell access to the server is the root of trust: the request must
 * come from the machine itself (the socket address, never X-Forwarded-For, which anyone can write)
 * and carry ADMIN_KEY. Everything then goes through ModerationManager as the `console` actor.
 *
 * Deployed behind nginx, *every* request has a loopback socket address, so the loopback check
 * alone would leave the console reachable from the internet, guarded only by ADMIN_KEY. nginx
 * always sets X-Forwarded-For on proxied requests; the CLI, calling loopback directly, never
 * sends that header. So: any X-Forwarded-For at all is refused, loopback or not.
 */
export function consoleRoutes(core: Core, adminKey: string | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    if (!adminKey) throw forbidden('CONSOLE_OFF', 'The console is off: set ADMIN_KEY on the server.');
    if (!isLoopback(c.env?.ip)) throw forbidden('CONSOLE_OFF', 'The console only answers from the server itself.');
    if (c.req.header('x-forwarded-for')) throw forbidden('CONSOLE_OFF', 'The console only answers from the server itself.');
    if (c.req.header('x-admin-key') !== adminKey) throw forbidden('CONSOLE_OFF', 'Wrong admin key.');
    await next();
  });

  const input = async (c: Context<AppEnv>): Promise<{ handle?: unknown; reason?: unknown }> => {
    try {
      const data = await c.req.json();
      return data && typeof data === 'object' ? (data as { handle?: unknown; reason?: unknown }) : {};
    } catch {
      return {};
    }
  };
  const target = async (raw: unknown): Promise<IdentityPublic> => {
    if (typeof raw !== 'string' || !raw.trim()) throw badRequest('BAD_HANDLE', 'Name someone: bun run admin <command> <handle>.');
    const handle = raw.trim().replace(/^@/, '');
    const who = await core.identities.getByHandle(handle);
    if (!who || who.released) throw notFound('NO_USER', `There is no @${handle}.`);
    return who;
  };
  const reasonFrom = (b: { reason?: unknown }, command: string): string =>
    typeof b.reason === 'string' && b.reason.trim() ? b.reason : `bun run admin ${command}`;
  const roleChange = (command: string, role: Role, requireCurrent: Role | null, message: (h: string) => string) =>
    app.post(`/${command}`, async (c) => {
      const b = await input(c);
      const who = await target(b.handle);
      if (requireCurrent && who.role !== requireCurrent) {
        throw conflict('NO_ROLE', `@${who.handle} is not ${requireCurrent === 'admin' ? 'an admin' : 'a moderator'}.`);
      }
      const identity = await core.moderation.setRole(CONSOLE, who.id, role, reasonFrom(b, command));
      return c.json({ identity, message: message(identity.handle) });
    });

  app.post('/list', async (c) => {
    const staff = await core.moderation.people('', 'mods');
    const pick = (role: Role) => staff.filter((p) => p.identity.role === role).map((p) => p.identity);
    return c.json({ admins: pick('admin'), mods: pick('mod') });
  });
  roleChange('grant', 'admin', null, (h) => `@${h} is now an admin.`);
  roleChange('revoke', 'user', 'admin', (h) => `@${h} is no longer an admin.`);
  roleChange('grant-mod', 'mod', null, (h) => `@${h} is now a moderator.`);
  roleChange('revoke-mod', 'user', 'mod', (h) => `@${h} is no longer a moderator.`);
  app.post('/reset-password', async (c) => {
    const b = await input(c);
    const who = await target(b.handle);
    const code = await core.moderation.resetPassword(CONSOLE, who.id, reasonFrom(b, 'reset-password'));
    return c.json({
      code,
      message: `One-time reset code for @${who.handle}: ${code}\nThey redeem it with "Forgot your password?" when signing in. Their sessions were signed out.`,
    });
  });
  app.post('/lift', async (c) => {
    const b = await input(c);
    const who = await target(b.handle);
    await core.moderation.lift(CONSOLE, who.id, reasonFrom(b, 'lift'));
    return c.json({ message: `@${who.handle} is free to talk and play again.` });
  });

  return app;
}

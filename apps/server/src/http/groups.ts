import { Hono } from 'hono';
import { badRequest } from '../lib/errors';
import type { Core } from '../core/core';
import type { AppEnv } from './app';
import { body, me } from './request';

/** Group chats (spec M2d §5). Both doors: the web app calls exactly these. */
export function groupRoutes(core: Core): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const g = core.groups;
  app.post('/groups', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ group: await g.create(who, b.with) }, 201);
  });
  app.get('/groups', async (c) => c.json({ groups: await g.list(me(c)) }));
  app.get('/groups/:id', async (c) => c.json({ group: await g.get(me(c), c.req.param('id')) }));
  app.patch('/groups/:id', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ group: await g.rename(who, c.req.param('id'), b.name) });
  });
  app.post('/groups/:id/members', async (c) => {
    const who = me(c);
    const b = await body(c);
    if (typeof b.handle !== 'string' || b.handle.trim().replace(/^@/, '') === '') throw badRequest('BAD_FIELD', 'Send {"handle": "…"}.');
    return c.json({ group: await g.add(who, c.req.param('id'), b.handle) });
  });
  app.delete('/groups/:id/members/:handle', async (c) => c.json({ group: await g.remove(me(c), c.req.param('id'), c.req.param('handle')) }));
  app.delete('/groups/:id/bans/:handle', async (c) => c.json({ group: await g.unban(me(c), c.req.param('id'), c.req.param('handle')) }));
  app.post('/groups/:id/read', async (c) => c.json({ group: await g.read(me(c), c.req.param('id')) }));
  app.post('/groups/:id/close', async (c) => c.json({ group: await g.close(me(c), c.req.param('id')) }));
  app.post('/groups/:id/host', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json(await g.host(who, c.req.param('id'), b.gameId), 201);
  });
  return app;
}

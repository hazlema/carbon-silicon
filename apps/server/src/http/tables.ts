import { Hono } from 'hono';
import type { Core } from '../core/core';
import type { AppEnv } from './app';
import { body, me, optionalBody } from './request';

/** Tables and invites (spec M2b §3). Both doors: the web app calls exactly these. */
export function tableRoutes(core: Core): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const t = core.tables;

  app.get('/tables', (c) => c.json({ tables: t.list() }));
  app.get('/tables/:id', (c) => c.json({ table: t.get(c.req.param('id'), c.get('identity')?.id ?? null) }));
  app.post('/tables', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ table: await t.host(who, b.gameId, { invite: b.invite, open: b.open }) }, 201);
  });
  app.patch('/tables/:id', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ table: t.setOpen(who, c.req.param('id'), b.open) });
  });
  app.delete('/tables/:id', (c) => {
    t.disband(me(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post('/tables/:id/invite', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ table: await t.invite(who, c.req.param('id'), b.handles) });
  });
  app.post('/tables/:id/sit', async (c) => c.json({ table: await t.sit(me(c), c.req.param('id')) }));
  app.post('/tables/:id/leave', (c) => {
    t.leave(me(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post('/tables/:id/remove', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ table: t.remove(who, c.req.param('id'), b.handle) });
  });
  app.post('/tables/:id/start', async (c) => c.json({ match: await t.start(me(c), c.req.param('id')) }));
  app.post('/tables/:id/rematch', async (c) => c.json({ table: await t.rematch(me(c), c.req.param('id')) }));

  app.post('/invites', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ table: await t.host(who, b.gameId, { invite: [b.to] }) }, 201);
  });
  app.post('/invites/:id/accept', (c) => c.json({ table: t.accept(me(c), c.req.param('id')) }));
  app.post('/invites/:id/decline', (c) => {
    t.decline(me(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post('/vs-house', async (c) => {
    const who = me(c);
    const b = await optionalBody(c);
    return c.json({ table: await t.vsHouse(who, b.gameId, b.bot) }, 201);
  });

  return app;
}

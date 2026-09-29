import { Hono } from 'hono';
import type { Core } from '../core/core';
import { badRequest } from '../lib/errors';
import type { AppEnv } from './app';
import { body, me } from './request';

/** Direct messages (spec M2c §4). Both doors: the web app calls exactly these. */
export function dmRoutes(core: Core): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const d = core.dms;

  app.get('/dms', async (c) => c.json({ conversations: await d.list(me(c)) }));
  app.get('/dms/:handle', async (c) => {
    const who = me(c);
    const raw = c.req.query('before');
    const before = raw === undefined ? undefined : Number(raw);
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) throw badRequest('BAD_QUERY', `"${raw}" is not a message id.`);
    return c.json(await d.history(who, c.req.param('handle'), before));
  });
  app.post('/dms/:handle', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ message: await d.send(who, c.req.param('handle'), b.text) }, 201);
  });
  app.post('/dms/:handle/read', async (c) => c.json({ conversation: await d.read(me(c), c.req.param('handle')) }));
  app.post('/dms/:handle/close', async (c) => c.json({ conversation: await d.close(me(c), c.req.param('handle')) }));
  return app;
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@cs/shared/brand';
import { createCore } from './core/core';
import { createApp } from './http/app';
import { startServer } from './server';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = process.env;
const production = env.NODE_ENV === 'production';

const houseKey = env.HOUSE_KEY ?? (production ? null : 'dev-house-key');
if (!houseKey) console.warn('[main] HOUSE_KEY is not set — house bots cannot register.');

const core = await createCore({
  databaseUrl: env.DATABASE_URL ?? `pglite:${join(root, '.data/pglite')}`,
  houseKey,
  diaryDir: join(root, 'diary'),
});

const read = async (path: string, fallback: string) => {
  const file = Bun.file(join(root, path));
  return (await file.exists()) ? file.text() : fallback;
};
const app = createApp(core, {
  apiDocs: await read('docs/API.md', '# API reference\n\nNot written yet.'),
  llmsTxt: await read('docs/llms.txt', 'Not written yet.'),
  secureCookies: production,
});

const webDir = join(root, 'apps/web/build');
const running = startServer(core, app, {
  port: Number(env.PORT ?? 3000),
  hostname: env.HOST ?? '127.0.0.1',
  webDir: existsSync(join(webDir, 'index.html')) ? webDir : null,
  allowedOrigins: [
    ...(production ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']),
    ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  ],
});
console.log(`${BRAND.name} is open at ${running.url}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('Closing up the parlor…');
  await running.stop();
  await core.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

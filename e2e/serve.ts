import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { runBot } from '../apps/bots/src/bot';
import { sprocket } from '../apps/bots/src/personalities/sprocket';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.E2E_PORT ?? 3100);
const core = await createCore({
  databaseUrl: 'pglite:memory',
  houseKey: 'e2e-house',
  diaryDir: join(root, 'diary'),
  countdownMs: 500,
  houseFallbackMs: 3000,
});
const app = createApp(core, {
  apiDocs: await Bun.file(join(root, 'docs/API.md')).text(),
  llmsTxt: await Bun.file(join(root, 'docs/llms.txt')).text(),
});
const running = startServer(core, app, { port, hostname: '127.0.0.1', webDir: join(root, 'apps/web/build'), allowedOrigins: [] });
const controller = new AbortController();
void runBot({
  base: running.url,
  personality: sprocket,
  houseKey: 'e2e-house',
  tokenFile: join(root, `.data/e2e/${crypto.randomUUID()}.token`),
  thinkMs: [30, 80],
  pollWaitMs: 5000,
  signal: controller.signal,
  log: () => {},
});
console.log(`e2e server on ${running.url}`);
const stop = async () => {
  controller.abort();
  await running.stop();
  await core.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

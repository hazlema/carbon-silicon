import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@cs/shared/brand';
import { LiveText } from '@cs/shared/live-text';
import { createCore } from './core/core';
import { clampGroupMax } from './core/groups';
import { clampFloor } from './core/realtime';
import { createApp } from './http/app';
import { systemClock } from './lib/clock';
import { LlmUsage } from './lib/llm-usage';
import { secretFromEnv } from './lib/secrets';
import { startServer } from './server';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = process.env;
const production = env.NODE_ENV === 'production';

const houseKey = secretFromEnv('HOUSE_KEY', env.HOUSE_KEY, production);
if (!houseKey) console.warn('[main] HOUSE_KEY is not set — house bots cannot register.');

const adminKey = secretFromEnv('ADMIN_KEY', env.ADMIN_KEY, production);
if (!adminKey) console.warn('[main] ADMIN_KEY is not set — `bun run admin` is switched off.');

const core = await createCore({
  databaseUrl: env.DATABASE_URL ?? `pglite:${join(root, '.data/pglite')}`,
  houseKey,
  diaryDir: join(root, 'diary'),
  doctrineFloorMs: clampFloor(env.DOCTRINE_FLOOR_MS, console.warn),
  groupMaxMembers: clampGroupMax(env.GROUP_MAX_MEMBERS, console.warn),
});

// The admins' Usage tab: what the bots' OpenRouter key has spent. Read from the same file the bots
// use (.data/llm.json, or LLM_SETTINGS), on each refresh, so a new key needs no restart.
const llmSettingsPath = env.LLM_SETTINGS || join(root, '.data/llm.json');
const llmUsage = new LlmUsage({
  settings: async () => {
    const file = Bun.file(llmSettingsPath);
    if (!(await file.exists())) return null;
    const s = (await file.json()) as { baseUrl?: unknown; apiKey?: unknown };
    return typeof s.baseUrl === 'string' ? { baseUrl: s.baseUrl, apiKey: typeof s.apiKey === 'string' ? s.apiKey : null } : null;
  },
  clock: systemClock,
});

// Docs and games' rules are re-read when their files change, so editing them needs no restart.
const live = (path: string, fallback: string) => new LiveText({ path: join(root, path), fallback });
const app = createApp(core, {
  apiDocs: live('docs/API.md', '# API reference\n\nNot written yet.'),
  llmsTxt: live('docs/llms.txt', 'Not written yet.'),
  root,
  llmUsage,
  secureCookies: production,
  adminKey,
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
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
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
});
console.log(`${BRAND.name} is open at ${running.url}`);

let closing = false;
const shutdown = async () => {
  // A second Ctrl-C or SIGTERM while closing means "now".
  if (closing) process.exit(1);
  closing = true;
  console.log('Closing up the parlor…');
  // Wake the parked long-polls first: the server's stop waits for every request in flight.
  core.drain();
  await running.stop();
  await core.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

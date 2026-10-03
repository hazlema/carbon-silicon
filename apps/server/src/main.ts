import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@cs/shared/brand';
import { readEnvFile } from '@cs/shared/env-file';
import { LiveText } from '@cs/shared/live-text';
import { createCore } from './core/core';
import { clampGroupMax } from './core/groups';
import { clampFloor } from './core/realtime';
import { createApp } from './http/app';
import { systemClock } from './lib/clock';
import { databaseUrlFor } from './lib/database-url';
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

let databaseUrl: string;
try {
  databaseUrl = databaseUrlFor(env, root);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const core = await createCore({
  databaseUrl,
  houseKey,
  diaryDir: join(root, 'diary'),
  doctrineFloorMs: clampFloor(env.DOCTRINE_FLOOR_MS, console.warn),
  groupMaxMembers: clampGroupMax(env.GROUP_MAX_MEMBERS, console.warn),
});

// The admins' Usage tab: what the bots' OpenRouter key has spent. Read from the same .env the bots
// use (or LLM_ENV_FILE), on each refresh, so a new key needs no restart; process.env is the fallback.
const llmEnvPath = env.LLM_ENV_FILE || join(root, '.env');
const llmUsage = new LlmUsage({
  settings: async () => {
    const merged = { ...env, ...((await readEnvFile(llmEnvPath)) ?? {}) };
    return { baseUrl: merged.LLM_BASE_URL?.trim() || 'http://127.0.0.1:1234/v1', apiKey: merged.LLM_API_KEY?.trim() || null };
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

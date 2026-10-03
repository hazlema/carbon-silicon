import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBot, type BotOptions } from './bot';
import { runBouncer } from './bouncer';
import { instructions } from './instructions';
import { LlmJudge } from './judge';
import { connectionFor, describeSettings, EnvSettings } from './llm-settings';
import { gameOver } from './personalities/game-over';
import { oldIron } from './personalities/old-iron';
import { sprocket } from './personalities/sprocket';
import { LlmVoice } from './voice';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = process.env;
const [lo, hi] = (env.BOT_THINK_MS ?? '900-2600').split('-').map(Number);
const tokenDir = env.BOT_TOKEN_DIR || join(root, '.data/bots');

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

const common = {
  base: env.CS_BASE ?? 'http://127.0.0.1:3000',
  houseKey: env.HOUSE_KEY ?? 'dev-house-key',
  thinkMs: [lo || 0, hi || lo || 0] as [number, number],
  signal: controller.signal,
} satisfies Partial<BotOptions>;

// The model settings come from the environment plus the repo-root .env, which the bots re-read while
// running (see docs/llm-settings.md); the file's values win.
const settingsPath = env.LLM_ENV_FILE || join(root, '.env');
const llmLog = (m: string) => console.log(`[llm] ${m}`);
if (await Bun.file(join(root, '.data/llm.json')).exists()) {
  llmLog('.data/llm.json is no longer read — put LLM_BASE_URL, LLM_MODEL and LLM_API_KEY in .env (see docs/llm-settings.md)');
}
const settings = new EnvSettings({ path: settingsPath, env, log: llmLog });
llmLog(`settings file: ${settingsPath}; starting with ${describeSettings(await settings.get())}`);

// What the residents are told lives in apps/bots/instructions/*.md, re-read while running like the .env settings.
const houseRules = await instructions('house-rules.md');

const ironLog = (m: string) => console.log(`[${oldIron.name}] ${m}`);
const ironVoice = new LlmVoice({
  persona: await instructions('old-iron.md'),
  houseRules,
  name: oldIron.name,
  log: ironLog,
  settings: async () => connectionFor(await settings.get(), 'voice'),
});

// GAME_OVER speaks through the same model settings, with his own persona. He keeps out of the lobby:
// no ambient chatter and no unprompted answers, so OLD IRON stays its voice.
const overLog = (m: string) => console.log(`[${gameOver.name}] ${m}`);
const overVoice = new LlmVoice({
  persona: await instructions('game-over.md'),
  houseRules,
  name: gameOver.name,
  log: overLog,
  settings: async () => connectionFor(await settings.get(), 'voice'),
});

// Sprocket speaks through the same settings too, sunny where GAME_OVER is dry. Like GAME_OVER he keeps out of the lobby:
// no ambient chatter and no unprompted answers (OLD IRON owns the lobby), but he answers his name and his table's talk.
const sprocketLog = (m: string) => console.log(`[${sprocket.name}] ${m}`);
const sprocketVoice = new LlmVoice({
  persona: await instructions('sprocket.md'),
  houseRules,
  name: sprocket.name,
  log: sprocketLog,
  settings: async () => connectionFor(await settings.get(), 'voice'),
});

// The Bouncer reads the same settings file as OLD IRON (bouncerModel, else model), live.
const bouncerLog = (m: string) => console.log(`[Bouncer] ${m}`);
const judge = new LlmJudge({ rules: await instructions('bouncer.md'), connection: async () => connectionFor(await settings.get(), 'bouncer'), log: bouncerLog });
const bouncerModel = connectionFor(await settings.get(), 'bouncer')?.model ?? null;
bouncerLog(`judge: ${bouncerModel ?? 'off — every report goes to a human'}`);

await Promise.all([
  runBot({ ...common, personality: sprocket, voice: sprocketVoice, ambientEveryMs: 0, watchPublic: false, tokenFile: join(tokenDir, 'sprocket.token'), log: sprocketLog }),
  runBot({ ...common, personality: oldIron, voice: ironVoice, tokenFile: join(tokenDir, 'old-iron.token'), log: ironLog }),
  runBot({ ...common, personality: gameOver, voice: overVoice, ambientEveryMs: 0, watchPublic: false, tokenFile: join(tokenDir, 'game-over.token'), log: overLog }),
  runBouncer({ base: common.base, houseKey: common.houseKey, tokenFile: join(tokenDir, 'bouncer.token'), judge, model: bouncerModel, signal: controller.signal, log: bouncerLog }),
]);

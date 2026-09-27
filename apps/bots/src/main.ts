import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBot, type BotOptions } from './bot';
import { connectionFor, describeSettings, SettingsFile, settingsFromEnv } from './llm-settings';
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

// The model settings live in one file the bots re-read while running (see docs/llm-settings.md);
// the LLM_* environment variables are the fallback for anything the file leaves out.
const settingsPath = env.LLM_SETTINGS || join(root, '.data/llm.json');
const llmLog = (m: string) => console.log(`[llm] ${m}`);
const settings = new SettingsFile({ path: settingsPath, base: settingsFromEnv(env), log: llmLog });
llmLog(`settings file: ${settingsPath}; starting with ${describeSettings(await settings.get())}`);

const ironLog = (m: string) => console.log(`[${oldIron.name}] ${m}`);
const ironVoice = new LlmVoice({
  persona: oldIron.persona!,
  name: oldIron.name,
  log: ironLog,
  settings: async () => connectionFor(await settings.get(), 'voice'),
});

await Promise.all([
  runBot({ ...common, personality: sprocket, tokenFile: join(tokenDir, 'sprocket.token') }),
  runBot({ ...common, personality: oldIron, voice: ironVoice, tokenFile: join(tokenDir, 'old-iron.token'), log: ironLog }),
]);

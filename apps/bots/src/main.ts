import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBot, type BotOptions } from './bot';
import { oldIron } from './personalities/old-iron';
import { sprocket } from './personalities/sprocket';
import { LlmVoice } from './voice';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = process.env;
const [lo, hi] = (env.BOT_THINK_MS ?? '900-2600').split('-').map(Number);
const llmBase = env.LLM_BASE_URL?.trim() || 'http://127.0.0.1:1234/v1';
const llmModel = env.LLM_MODEL?.trim() || 'google/gemma-4-e2b';
const voiceOff = llmBase.toLowerCase() === 'off';

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

const common = {
  base: env.CS_BASE ?? 'http://127.0.0.1:3000',
  houseKey: env.HOUSE_KEY ?? 'dev-house-key',
  thinkMs: [lo || 0, hi || lo || 0] as [number, number],
  signal: controller.signal,
} satisfies Partial<BotOptions>;

const ironLog = (m: string) => console.log(`[${oldIron.name}] ${m}`);
const ironVoice = voiceOff ? undefined : new LlmVoice({ baseUrl: llmBase, model: llmModel, persona: oldIron.persona!, name: oldIron.name, log: ironLog });
ironLog(`voice: ${ironVoice ? `llm ${llmModel} @ ${llmBase}` : 'canned'}`);

await Promise.all([
  runBot({ ...common, personality: sprocket, tokenFile: join(root, '.data/bots/sprocket.token') }),
  runBot({ ...common, personality: oldIron, voice: ironVoice, tokenFile: join(root, '.data/bots/old-iron.token'), log: ironLog }),
]);

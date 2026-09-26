import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBot } from './bot';
import { sprocket } from './personalities/sprocket';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = process.env;
const [lo, hi] = (env.BOT_THINK_MS ?? '900-2600').split('-').map(Number);

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

await runBot({
  base: env.CS_BASE ?? 'http://127.0.0.1:3000',
  personality: sprocket,
  houseKey: env.HOUSE_KEY ?? 'dev-house-key',
  tokenFile: join(root, '.data/bots/sprocket.token'),
  thinkMs: [lo || 0, hi || lo || 0],
  signal: controller.signal,
});

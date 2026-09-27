/** Lists the models OpenRouter offers for free right now: `bun run bots:free-models`. */

export interface FreeModel {
  id: string;
  name: string;
  context: number | null;
}

/** A chat model reads text and writes only text (this skips music and image generators). */
const chats = (m: { architecture?: { input_modalities?: unknown; output_modalities?: unknown } }) => {
  const input = m.architecture?.input_modalities;
  const output = m.architecture?.output_modalities;
  return Array.isArray(input) && input.includes('text') && Array.isArray(output) && output.length === 1 && output[0] === 'text';
};

export function freeModels(body: unknown): FreeModel[] {
  const list = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m?.pricing?.prompt === '0' && m?.pricing?.completion === '0' && typeof m.id === 'string' && chats(m))
    .map((m) => ({ id: m.id as string, name: String(m.name ?? m.id), context: typeof m.context_length === 'number' ? m.context_length : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

if (import.meta.main) {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) {
    console.error(`OpenRouter answered HTTP ${res.status}`);
    process.exit(1);
  }
  const models = freeModels(await res.json());
  console.log(`${models.length} free models on OpenRouter right now:\n`);
  for (const m of models) console.log(`  ${m.id.padEnd(52)} ${m.context ? `${Math.round(m.context / 1000)}k context` : ''}`);
  console.log('\nPut one in .data/llm.json as "model" (with "baseUrl": "https://openrouter.ai/api/v1" and your "apiKey").');
}

import { stat } from 'node:fs/promises';
import { readEnvFile } from '@cs/shared/env-file';

/** Where the residents' model lives. One file serves every bot with a model (OLD IRON's voice, the Bouncer). */
export interface LlmSettings {
  /** An OpenAI-compatible base URL (LM Studio, OpenRouter, …), or "off". */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  temperature: number;
  /** The Bouncer's model; null means it uses `model`. */
  bouncerModel: string | null;
}

/** What one request needs. */
export interface LlmConnection {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  temperature: number;
}

const DEFAULT_TEMPERATURE = 0.9;
const text = (v: string | undefined) => v?.trim() || null;

export function settingsFromEnv(env: Record<string, string | undefined>): LlmSettings {
  const t = Number(env.LLM_TEMPERATURE);
  return {
    baseUrl: text(env.LLM_BASE_URL) ?? 'http://127.0.0.1:1234/v1',
    model: text(env.LLM_MODEL) ?? 'google/gemma-4-e2b',
    apiKey: text(env.LLM_API_KEY),
    temperature: env.LLM_TEMPERATURE !== undefined && Number.isFinite(t) && t >= 0 && t <= 2 ? t : DEFAULT_TEMPERATURE,
    bouncerModel: text(env.BOUNCER_MODEL),
  };
}

/** The connection one resident should use, or null when the model is switched off. */
export function connectionFor(s: LlmSettings, who: 'voice' | 'bouncer'): LlmConnection | null {
  if (s.baseUrl.toLowerCase() === 'off') return null;
  return { baseUrl: s.baseUrl, model: who === 'bouncer' ? (s.bouncerModel ?? s.model) : s.model, apiKey: s.apiKey, temperature: s.temperature };
}

export const describeSettings = (s: LlmSettings) =>
  s.baseUrl.toLowerCase() === 'off' ? 'off (canned lines)' : `${s.model} @ ${s.baseUrl}, temperature ${s.temperature}${s.apiKey ? ', with key' : ''}`;

/**
 * The settings, from the environment plus a `.env` file the bots re-read while running, so the model
 * can change without a restart. The file's values win over the process environment. Checked at most
 * every `minCheckMs`; an unreadable file is reported once and the last good settings stay.
 */
export class EnvSettings {
  private current: LlmSettings;
  private checkedAt = -Infinity;
  private seenMtime: number | null = null;
  private readonly minCheckMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: { path: string; env: Record<string, string | undefined>; log: (m: string) => void; minCheckMs?: number; now?: () => number }) {
    this.current = settingsFromEnv(opts.env);
    this.minCheckMs = opts.minCheckMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  async get(): Promise<LlmSettings> {
    const now = this.now();
    if (now - this.checkedAt < this.minCheckMs) return this.current;
    this.checkedAt = now;
    const info = await stat(this.opts.path).catch(() => null);
    if (!info) {
      if (this.seenMtime !== null) {
        this.seenMtime = null;
        this.current = settingsFromEnv(this.opts.env);
        this.opts.log(`settings file gone; back to the environment: ${describeSettings(this.current)}`);
      }
      return this.current;
    }
    if (info.mtimeMs === this.seenMtime) return this.current;
    this.seenMtime = info.mtimeMs;
    try {
      const values = await readEnvFile(this.opts.path);
      if (values === null) throw new Error('it vanished while being read');
      this.current = settingsFromEnv({ ...this.opts.env, ...values });
      this.opts.log(`settings: ${describeSettings(this.current)}`);
    } catch (e) {
      this.opts.log(`settings file ignored (${(e as Error).message}); still using ${describeSettings(this.current)}`);
    }
    return this.current;
  }
}

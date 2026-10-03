import type { UsageReport } from '@cs/shared/protocol';
import type { Clock } from './clock';

/** The voice's connection as the .env gives it; only the address and the key matter here. */
export interface UsageSettings {
  baseUrl: string;
  apiKey: string | null;
}

const CACHE_MS = 60_000;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * What the bots' OpenRouter key has spent, asked of OpenRouter's GET /key and kept for a minute.
 * The key itself never leaves the server: reports carry dollars and counts only.
 */
export class LlmUsage {
  private cached: { at: number; report: UsageReport } | null = null;

  constructor(
    private readonly opts: {
      /** Read on every refresh, so a new key in .env is picked up without a restart. */
      settings: () => Promise<UsageSettings | null>;
      fetchImpl?: typeof fetch;
      clock: Clock;
    },
  ) {}

  async get(): Promise<UsageReport> {
    const now = this.opts.clock.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.report;
    const report = await this.ask();
    this.cached = { at: now, report };
    return report;
  }

  private async ask(): Promise<UsageReport> {
    const s = await this.opts.settings().catch(() => null);
    const base = (s?.baseUrl ?? '').replace(/\/+$/, '');
    if (base && !/^https:\/\/openrouter\.ai\//.test(`${base}/`)) {
      return { status: 'unconfigured', message: `The voice runs on ${base}, not OpenRouter: no usage to show.` };
    }
    if (!s?.apiKey || !base) return { status: 'unconfigured', message: 'No OpenRouter key configured (.env).' };
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${base}/key`, { headers: { authorization: `Bearer ${s.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      return { status: 'unavailable', message: "OpenRouter didn't answer (network error)." };
    }
    if (!res.ok) return { status: 'unavailable', message: `OpenRouter didn't answer (HTTP ${res.status}).` };
    const d = ((await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null)?.data;
    if (!d) return { status: 'unavailable', message: "OpenRouter's answer had no usage in it." };
    const free = d.free_model_daily_requests as { used?: unknown; limit?: unknown } | undefined;
    const freeUsed = num(free?.used);
    const freeLimit = num(free?.limit);
    return {
      status: 'ok',
      today: num(d.usage_daily) ?? 0,
      week: num(d.usage_weekly) ?? 0,
      month: num(d.usage_monthly) ?? 0,
      total: num(d.usage) ?? 0,
      limit: num(d.limit),
      limitRemaining: num(d.limit_remaining),
      freeRequests: freeUsed !== null && freeLimit !== null ? { used: freeUsed, limit: freeLimit } : null,
      checkedAt: new Date(this.opts.clock.now()).toISOString(),
    };
  }
}

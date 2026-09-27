import type { ReportInfo } from '@cs/shared/protocol';
import { connect } from './bot';
import { ApiError, Client } from './client';
import type { Judge, Verdict } from './judge';

export const BOUNCER = {
  name: 'Bouncer',
  tagline: 'Keeps the peace. Reads the reports.',
  color: '#9aa1cf',
} as const;

export interface BouncerOptions {
  base: string;
  houseKey: string;
  tokenFile: string;
  /** Null when the model is off: every report then goes to a human untouched. */
  judge: Judge | null;
  /** Shown on the Bouncer's profile. */
  model?: string | null;
  pollWaitMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export type Decision = { resolve: 'dismiss' | 'delete' | 'mute'; reason: string; minutes?: number } | { note: string };

/** What the Bouncer does with a verdict. Anything but a dismissal, a deletion or a short mute is a note for a human. */
export function decide(v: Verdict | null): Decision {
  if (!v) return { note: 'no opinion' };
  const reason = v.reason.trim().slice(0, 250) || 'no reason given';
  switch (v.action) {
    case 'dismiss':
    case 'delete':
      return { resolve: v.action, reason };
    case 'mute':
      return { resolve: 'mute', reason, minutes: Math.min(60, Math.max(1, Math.round(v.minutes ?? 10))) };
    default:
      return { note: `escalate: ${reason}` };
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * The Bouncer: a house resident with no games and no chat voice. Each time around its loop it
 * reads the open report queue and handles every report it hasn't touched; `report.opened` inbox
 * events only wake it early. The server caps what a house mod may do, and `decide` stays inside
 * those caps anyway.
 */
export async function runBouncer(opts: BouncerOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[${BOUNCER.name}] ${m}`));
  const client = new Client(opts.base, null, opts.signal);
  const handled = new Set<string>();
  let powerless = false;
  let myHandle: string = BOUNCER.name;

  for (let attempt = 0; !opts.signal?.aborted; attempt++) {
    try {
      await connect(client, { ...BOUNCER, model: opts.model ?? null }, opts.houseKey, opts.tokenFile, log);
      break;
    } catch (e) {
      if (opts.signal?.aborted) return;
      log(`cannot reach ${opts.base} (${(e as Error).message}); retrying`);
      await sleep(Math.min(10_000, 500 * 2 ** attempt), opts.signal);
    }
  }
  if (opts.signal?.aborted) return;
  // Set afk before anything else: a fresh registration arrives ready, and the quick-match fallback
  // seats any ready house resident. The Bouncer never plays, so this closes that window instead of
  // waiting for the main loop's first pass to notice.
  await client.setStatus('afk');

  const note = (id: string, text: string) => client.call('POST', `/api/mod/reports/${id}/notes`, { text: text.slice(0, 300) });

  async function handle(report: ReportInfo): Promise<void> {
    const verdict = opts.judge ? await opts.judge.judge(report, opts.signal).catch(() => null) : null;
    if (opts.signal?.aborted) return;
    const d = decide(verdict);
    if ('note' in d) {
      await note(report.id, d.note);
      log(`report ${report.id}: ${d.note}`);
      return;
    }
    try {
      await client.call('POST', `/api/mod/reports/${report.id}/resolve`, {
        resolution: d.resolve,
        reason: d.reason,
        ...(d.minutes ? { minutes: d.minutes } : {}),
      });
    } catch (e) {
      // The server has the last word either way, and not just about its own caps: the world can
      // also have moved on since the report was filed (the target released, the message already
      // gone). Only a rejected token (401) or a rate limit (429) are worth retrying — every other
      // 4xx means this report can never be acted on, so it goes to a human. Either way it gets a
      // note, its durable mark, so it is never re-judged again.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) {
        const escalate = `escalate: could not act (${e.code})`;
        await note(report.id, escalate);
        log(`report ${report.id}: ${escalate}`);
        return;
      }
      throw e;
    }
    // Resolved: also leave a note recording what happened. `reports.reopen` clears the resolution
    // and resolvedBy fields but never touches notes, so without this a report the Bouncer resolved
    // looks untouched to it after a human reopens it — and, worse, after a restart, since `handled`
    // lives only in memory. The note is what "skip if a note by me exists" actually finds.
    const verb = d.resolve === 'dismiss' ? 'dismissed' : d.resolve === 'delete' ? 'deleted' : `muted ${d.minutes} min`;
    await note(report.id, `${verb}: ${d.reason}`);
    log(`report ${report.id}: ${d.resolve}${d.minutes ? ` ${d.minutes} min` : ''} (${d.reason})`);
  }

  async function sweep(): Promise<void> {
    let reports: ReportInfo[];
    try {
      reports = (await client.call<{ reports: ReportInfo[] }>('GET', '/api/mod/reports?status=open')).reports;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        if (!powerless) log('no powers yet — run: bun run admin grant-mod Bouncer');
        powerless = true;
        return;
      }
      throw e;
    }
    if (powerless) log('powers granted; reading the reports');
    powerless = false;
    for (const report of reports) {
      if (opts.signal?.aborted) return;
      if (handled.has(report.id) || report.notes.some((n) => n.by === myHandle)) continue;
      handled.add(report.id);
      try {
        await handle(report);
      } catch (e) {
        // A retryable failure (a rejected token, a rate limit, a network hiccup): try this report
        // again next sweep. It must not take the rest of the queue down with it.
        handled.delete(report.id);
        log(`report ${report.id}: ${(e as Error).message}; will retry`);
      }
    }
  }

  let cursor: number | null = null;
  while (!opts.signal?.aborted) {
    try {
      const me = await client.me();
      myHandle = me.identity.handle;
      // The quick-match fallback seats any *ready* house resident. The Bouncer doesn't play.
      if (me.presence?.status !== 'afk') await client.setStatus('afk');
      if (cursor === null) cursor = (await client.inbox(0, 0)).cursor;
      await sweep();
      cursor = (await client.inbox(cursor, opts.pollWaitMs ?? 25_000)).cursor;
    } catch (e) {
      if (opts.signal?.aborted) break;
      log(`error: ${(e as Error).message}`);
      await sleep(2000, opts.signal);
    }
  }
}

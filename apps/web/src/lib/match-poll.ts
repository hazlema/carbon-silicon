import type { MatchEnvelope } from '@cs/shared/protocol';

/** The pause between a guest's reads: five frames a second, and no connection left parked on the server. */
export const GUEST_POLL_MS = 200;
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A guest has no socket, and the server refuses anonymous long-polls on purpose (it won't let
 * guests park connections), so a guest's table page reads the match five times a second instead.
 * Only a newer revision is handed on. It stops when the match is over or abandoned, or when
 * `signal` aborts, and backs off 1 s, 2 s, … 10 s after an error.
 */
export async function pollMatch(
  matchId: string,
  since: number,
  onEnvelope: (e: MatchEnvelope) => void,
  get: (path: string) => Promise<MatchEnvelope>,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = nap,
  everyMs = GUEST_POLL_MS,
): Promise<void> {
  let rev = since;
  let backoff = 1000;
  while (!signal.aborted) {
    let e: MatchEnvelope;
    try {
      e = await get(`/api/matches/${matchId}`);
    } catch {
      if (signal.aborted) return;
      await sleep(backoff);
      backoff = Math.min(10_000, backoff * 2);
      continue;
    }
    if (signal.aborted) return;
    backoff = 1000;
    if (e.match.revision > rev) {
      rev = e.match.revision;
      onEnvelope(e);
    }
    if (e.match.status === 'over' || e.match.status === 'abandoned') return;
    await sleep(everyMs);
  }
}

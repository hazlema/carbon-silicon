/** Poll until `check` is truthy (real time). For async side effects such as DB writes after a timer fires. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** A short random tag for building test handles, e.g. `ann${randomTag()}`. Digits only — unlike
 *  a base-36 tag, it can never accidentally spell something the profanity filter rejects. */
export function randomTag(): string {
  return String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
}

/**
 * Was this request sent by a page of this site in a browser? Browsers stamp every fetch with
 * `Sec-Fetch-Site` (Chrome 76+, Firefox 90+, Safari 16.4+), and a script can't set it; older browsers
 * still send `Origin` on a POST. A program sends neither unless it forges them, which is cheating on
 * purpose, not wandering in. So humans' front doors (a new name, sign-in, recovery) ask for one, and an
 * agent that knocks there is pointed at its own door (403 USE_AN_AGENT).
 */
export function fromThisSite(headers: { get(name: string): string | null | undefined }, host: string | null | undefined): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'same-site';
  const origin = headers.get('origin');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The address a request came from. Behind a trusted proxy (nginx sets `X-Forwarded-For
 * $remote_addr`), the last entry is the one the proxy saw; anything before it came from the client
 * and proves nothing. Without a trusted proxy the header is ignored entirely.
 */
export function clientIp(xff: string | null | undefined, socketIp: string | null | undefined, trustProxy: boolean): string {
  if (trustProxy && xff) {
    const last = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .at(-1);
    if (last) return last;
  }
  return socketIp || 'local';
}

export function isLoopback(ip: string | null | undefined): boolean {
  return !!ip && LOOPBACK.has(ip);
}

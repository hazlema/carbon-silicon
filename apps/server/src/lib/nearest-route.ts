/**
 * The route a lost request most likely meant, for the 404's "Did you mean …?". Routes are Hono's
 * `{ method, path }` list; only real API routes count (no middleware, no catch-alls). Paths of the same
 * length are compared with each `:param` standing in for whatever the request had there, so
 * `/api/tables/t_1/invit` is one letter from `/api/tables/:id/invite`. A wrong method on a real path
 * is the closest miss of all. Null when nothing is close enough to be worth saying.
 */
export interface RouteLike {
  method: string;
  path: string;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Edit distance (insert, delete, substitute), capped: anything past `cap` is just "far". */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

export function nearestRoute(method: string, path: string, routes: RouteLike[]): RouteLike | null {
  const want = path.replace(/\/+$/, '') || '/';
  const segs = want.split('/');
  const seen = new Set<string>();
  let best: { route: RouteLike; score: number } | null = null;
  for (const r of routes) {
    if (!METHODS.has(r.method) || !r.path.startsWith('/api') || r.path.includes('*')) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rsegs = r.path.split('/');
    // The request's own values where the route has a parameter, so only the fixed words are compared.
    const filled = rsegs.length === segs.length ? rsegs.map((s, i) => (s.startsWith(':') ? segs[i] : s)).join('/') : r.path;
    const cap = Math.max(2, Math.floor(want.length / 6));
    const score = distance(want.toLowerCase(), filled.toLowerCase(), cap) + (r.method === method ? 0 : 1) + (rsegs.length === segs.length ? 0 : 1);
    if (score <= cap && (!best || score < best.score)) best = { route: { method: r.method, path: r.path }, score };
  }
  return best?.route ?? null;
}

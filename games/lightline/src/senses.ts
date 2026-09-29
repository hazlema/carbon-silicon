import type { SeatId } from '@cs/game-api';
import { DX, idx, inside, LEFT, RIGHT, SHRINK_AT, W, type Dir, type LLState } from './engine';

const SIGHT = 40;
const FLOOD = 600;

function ray(s: LLState, x: number, y: number, d: Dir): number {
  const [dx, dy] = DX[d];
  let n = 0;
  while (n < SIGHT) {
    x += dx;
    y += dy;
    if (!inside(x, y) || s.cells[idx(x, y)] !== '.') break;
    n++;
  }
  return n;
}

/** Free cells reachable from (x, y), counting (x, y) itself; 0 when it's blocked. */
function flood(s: LLState, x: number, y: number): number {
  if (!inside(x, y) || s.cells[idx(x, y)] !== '.') return 0;
  const seen = new Set([idx(x, y)]);
  const queue = [idx(x, y)];
  while (queue.length > 0 && seen.size < FLOOD) {
    const i = queue.shift()!;
    const cx = i % W;
    const cy = (i - cx) / W;
    for (const [dx, dy] of Object.values(DX)) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inside(nx, ny)) continue;
      const j = idx(nx, ny);
      if (s.cells[j] !== '.' || seen.has(j)) continue;
      seen.add(j);
      queue.push(j);
      if (seen.size >= FLOOD) break;
    }
  }
  return Math.min(seen.size, FLOOD);
}

function bearing(h: Dir, dx: number, dy: number): string {
  const [fx, fy] = DX[h];
  const [rx, ry] = DX[RIGHT[h]];
  const f = dx * fx + dy * fy;
  const r = dx * rx + dy * ry;
  if (Math.abs(f) >= Math.abs(r)) return f >= 0 ? 'ahead' : 'behind';
  return r > 0 ? 'right' : 'left';
}

export function senses(s: LLState, seat: SeatId): Record<string, number | string | boolean> {
  const me = s.cycles.find((c) => c.seat === seat)!;
  const h = me.heading;
  const open = (d: Dir) => flood(s, me.x + DX[d][0], me.y + DX[d][1]);
  const enemies = s.cycles.filter((c) => c.alive && c.seat !== seat);
  let dist = 999;
  let where = 'none';
  for (const e of enemies) {
    const d = Math.abs(e.x - me.x) + Math.abs(e.y - me.y);
    if (d < dist) [dist, where] = [d, bearing(h, e.x - me.x, e.y - me.y)];
  }
  return {
    ahead: ray(s, me.x, me.y, h),
    left: ray(s, me.x, me.y, LEFT[h]),
    right: ray(s, me.x, me.y, RIGHT[h]),
    open_ahead: open(h),
    open_left: open(LEFT[h]),
    open_right: open(RIGHT[h]),
    enemy_dist: dist,
    enemy_bearing: where,
    boosts: me.boosts,
    boosting: me.boostTicks > 0,
    heading: h,
    round: s.round,
    round_tick: s.roundTick,
    enemies_alive: enemies.length,
    shrinking: s.phase === 'play' && s.roundTick >= SHRINK_AT,
  };
}

import type { Action, Outcome, RoundEvent, SeatId } from '@cs/game-api';

export const W = 64;
export const H = 40;
export const TICK_HZ = 10;
export const BOOSTS = 3;
export const BOOST_TICKS = 8;
export const SHRINK_AT = 450;
export const SHRINK_EVERY = 20;
export const INTERMISSION = 50;
export const ROUNDS = 3;
export const WINS = 2;
export const LETTER: Record<string, string> = { red: 'R', blue: 'B', green: 'G', gold: 'Y' };

export type Dir = 'n' | 'e' | 's' | 'w';
export interface Cycle {
  seat: SeatId;
  x: number;
  y: number;
  heading: Dir;
  alive: boolean;
  boosts: number;
  boostTicks: number;
  resigned: boolean;
}
export interface LLState {
  seats: SeatId[];
  /** W×H cells, top row first: '.' free, '#' wall, a seat letter for its trail (heads included). */
  cells: string[];
  cycles: Cycle[];
  round: number;
  roundTick: number;
  phase: 'play' | 'intermission' | 'over';
  intermissionLeft: number;
  rings: number;
  score: Record<SeatId, number>;
  roundsPlayed: number;
  /** Who took the round that just ended; null when it was drawn (or none has ended). */
  lastWinner: SeatId | null;
  endReason: string | null;
}

export const DX: Record<Dir, [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
export const LEFT: Record<Dir, Dir> = { n: 'w', w: 's', s: 'e', e: 'n' };
export const RIGHT: Record<Dir, Dir> = { n: 'e', e: 's', s: 'w', w: 'n' };
const BACK: Record<Dir, Dir> = { n: 's', s: 'n', e: 'w', w: 'e' };
export const idx = (x: number, y: number) => y * W + x;
export const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
const ringOf = (x: number, y: number) => Math.min(x, y, W - 1 - x, H - 1 - y);

function starts(n: number): { x: number; y: number; heading: Dir }[] {
  if (n === 2) return [{ x: 8, y: 20, heading: 'e' }, { x: W - 9, y: 20, heading: 'w' }];
  return [
    { x: 8, y: 8, heading: 'e' as Dir },
    { x: W - 9, y: H - 9, heading: 'w' as Dir },
    { x: W - 9, y: 8, heading: 's' as Dir },
    { x: 8, y: H - 9, heading: 'n' as Dir },
  ].slice(0, n);
}

/** A fresh arena for a round; resigned seats stay out. */
export function arena(seats: SeatId[], previous: Cycle[] | null): { cells: string[]; cycles: Cycle[] } {
  const cells = new Array<string>(W * H).fill('.');
  const pos = starts(seats.length);
  const cycles = seats.map((seat, i) => {
    const resigned = previous?.[i]?.resigned ?? false;
    const c: Cycle = { seat, ...pos[i], alive: !resigned, boosts: BOOSTS, boostTicks: 0, resigned };
    if (!resigned) cells[idx(c.x, c.y)] = LETTER[seat];
    return c;
  });
  return { cells, cycles };
}

export function initial(seats: SeatId[]): LLState {
  const { cells, cycles } = arena(seats, null);
  return {
    seats: [...seats],
    cells,
    cycles,
    round: 1,
    roundTick: 0,
    phase: 'play',
    intermissionLeft: 0,
    rings: 0,
    score: Object.fromEntries(seats.map((s) => [s, 0])),
    roundsPlayed: 0,
    lastWinner: null,
    endReason: null,
  };
}

function steer(heading: Dir, a: Action | undefined): Dir {
  if (!a) return heading;
  if (a.act === 'turn') return a.dir === 'left' ? LEFT[heading] : a.dir === 'right' ? RIGHT[heading] : heading;
  if (a.act === 'head' && typeof a.dir === 'string' && a.dir in DX && a.dir !== BACK[heading]) return a.dir as Dir;
  return heading;
}

/** Ends the round when at most one cycle is left, and the match when it's decided. */
function settle(s: LLState): LLState {
  const alive = s.cycles.filter((c) => c.alive);
  if (alive.length > 1) return s;
  const winner = alive.length === 1 ? alive[0].seat : null;
  const score = { ...s.score };
  if (winner) score[winner] += 1;
  const roundsPlayed = s.roundsPlayed + 1;
  const standing = s.cycles.filter((c) => !c.resigned);
  const done = roundsPlayed >= ROUNDS || Object.values(score).some((n) => n >= WINS) || standing.length <= 1;
  const endReason = !done ? null : standing.length <= 1 && s.cycles.some((c) => c.resigned) ? 'forfeit' : 'rounds';
  return { ...s, score, roundsPlayed, lastWinner: winner, phase: done ? 'over' : 'intermission', intermissionLeft: done ? 0 : INTERMISSION, endReason };
}

export function step(s: LLState, actions: Record<SeatId, Action>): LLState {
  if (s.phase === 'over') return s;
  if (s.phase === 'intermission') {
    if (s.intermissionLeft > 1) return { ...s, intermissionLeft: s.intermissionLeft - 1 };
    const { cells, cycles } = arena(s.seats, s.cycles);
    return { ...s, cells, cycles, round: s.round + 1, roundTick: 0, phase: 'play', intermissionLeft: 0, rings: 0, lastWinner: null };
  }
  const cells = s.cells.slice();
  const cycles = s.cycles.map((c) => ({ ...c }));
  for (const c of cycles) {
    if (!c.alive) continue;
    const a = actions[c.seat];
    c.heading = steer(c.heading, a);
    if (a?.boost === true && c.boosts > 0 && c.boostTicks === 0) {
      c.boosts -= 1;
      c.boostTicks = BOOST_TICKS;
    }
  }
  // Everyone moves together, one sub-step at a time; boosting cycles take a second sub-step.
  for (let sub = 0; sub < 2; sub++) {
    const targets = new Map<Cycle, number | null>();
    for (const c of cycles) {
      if (!c.alive || (sub === 1 && c.boostTicks === 0)) continue;
      const [dx, dy] = DX[c.heading];
      const x = c.x + dx;
      const y = c.y + dy;
      targets.set(c, inside(x, y) && cells[idx(x, y)] === '.' ? idx(x, y) : null);
    }
    const claims = new Map<number, number>();
    for (const t of targets.values()) if (t !== null) claims.set(t, (claims.get(t) ?? 0) + 1);
    for (const [c, t] of targets) {
      if (t === null || claims.get(t)! > 1) {
        c.alive = false;
        continue;
      }
      c.x = t % W;
      c.y = (t - c.x) / W;
      cells[t] = LETTER[c.seat];
    }
  }
  for (const c of cycles) if (c.boostTicks > 0) c.boostTicks -= 1;
  const roundTick = s.roundTick + 1;
  let rings = s.rings;
  if (roundTick >= SHRINK_AT && (roundTick - SHRINK_AT) % SHRINK_EVERY === 0) {
    const r = rings;
    rings += 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ringOf(x, y) === r) cells[idx(x, y)] = '#';
    for (const c of cycles) if (c.alive && ringOf(c.x, c.y) <= r) c.alive = false;
  }
  return settle({ ...s, cells, cycles, roundTick, rings });
}

export function forfeit(s: LLState, seat: SeatId): LLState {
  const next = { ...s, cycles: s.cycles.map((c) => (c.seat === seat ? { ...c, alive: false, resigned: true } : c)) };
  if (next.cycles.filter((c) => !c.resigned).length <= 1) return { ...next, phase: 'over', endReason: 'forfeit' };
  return s.phase === 'play' ? settle(next) : next;
}

export function outcome(s: LLState): Outcome | null {
  if (s.phase !== 'over') return null;
  const standing = s.cycles.filter((c) => !c.resigned).map((c) => c.seat);
  const resigned = s.cycles.filter((c) => c.resigned).map((c) => c.seat);
  const best = Math.max(0, ...standing.map((seat) => s.score[seat]));
  const top = standing.filter((seat) => s.score[seat] === best);
  const winners = standing.length > 1 && top.length === standing.length ? [] : top;
  const levels = [...new Set(standing.map((seat) => s.score[seat]))].sort((a, b) => b - a);
  const placement = levels.map((n) => standing.filter((seat) => s.score[seat] === n));
  if (resigned.length > 0) placement.push(resigned);
  return { winners, placement, reason: s.endReason ?? 'rounds' };
}

export function roundEvent(before: LLState, after: LLState): RoundEvent | null {
  if (after.round > before.round) return { round: after.round, ended: false, winner: null, score: after.score };
  if (before.phase === 'play' && after.phase !== 'play') return { round: before.round, ended: true, winner: after.lastWinner, score: after.score };
  return null;
}

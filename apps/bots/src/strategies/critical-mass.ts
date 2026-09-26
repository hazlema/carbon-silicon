import { criticalMass, criticalMassGame, type CMCommand, type CMState } from '@cs/critical-mass';

const turn = criticalMassGame.turn!;
const WIN = 1e6;

/** Material plus bonuses for loaded cells (one short of exploding) and corners. */
export function evaluate(s: CMState, me: string): number {
  if (s.winner) return s.winner === me ? WIN : -WIN;
  let score = 0;
  s.cells.forEach((c, i) => {
    if (!c.owner) return;
    const crit = criticalMass(s.cols, s.rows, i);
    const value = c.orbs + 1 + (c.orbs === crit - 1 ? 1.5 : 0) + (crit === 2 ? 0.5 : 0);
    score += c.owner === me ? value : -value;
  });
  return score;
}

export interface CMStrategyOptions {
  depth: 1 | 2;
  /** Chance of picking one of the top three moves instead of the best, to stay beatable. */
  randomness: number;
  rng: () => number;
}

export function chooseCriticalMassMove(s: CMState, me: string, opts: CMStrategyOptions): CMCommand {
  const moves = turn.legal(s, me) as CMCommand[];
  if (moves.length === 0) throw new Error('No legal moves.');
  const jitter = () => opts.rng() * 0.01;
  // Ply 1: score every move.
  let ranked = moves
    .map((m) => {
      const next = turn.apply(s, me, m);
      return { m, next, score: evaluate(next, me) + jitter() };
    })
    .sort((a, b) => b.score - a.score);
  if (ranked[0].score >= WIN) return ranked[0].m;
  // Ply 2: for the ten most promising moves, assume the opponent's best reply.
  if (opts.depth === 2) {
    ranked = ranked
      .slice(0, 10)
      .map((c) => {
        if (c.next.winner || !c.next.turn) return c;
        const opp = c.next.turn;
        let worst = Infinity;
        for (const reply of turn.legal(c.next, opp) as CMCommand[]) {
          worst = Math.min(worst, evaluate(turn.apply(c.next, opp, reply), me));
          if (worst <= -WIN) break;
        }
        return worst === Infinity ? c : { ...c, score: worst + jitter() };
      })
      .sort((a, b) => b.score - a.score);
  }
  if (opts.rng() < opts.randomness) return ranked[Math.min(ranked.length - 1, Math.floor(opts.rng() * 3))].m;
  return ranked[0].m;
}

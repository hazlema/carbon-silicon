import { checkersGame, coords, opponent, type CheckersCommand, type CheckersState, type Side } from '@cs/checkers';

const legal = (s: CheckersState, side: Side) => checkersGame.turn.legal(s, side);
const play = (s: CheckersState, side: Side, c: CheckersCommand) => checkersGame.turn.apply(s, side, c);

/** From `side`'s point of view: men 1, kings 1.6, a little for each row a man has marched toward its crown. */
export function evaluate(s: CheckersState, side: Side): number {
  if (s.winner) return s.winner === 'draw' ? 0 : s.winner === side ? 1000 : -1000;
  let score = 0;
  for (const p of s.pieces) {
    const rank = coords(p.square)[1];
    const v = p.king ? 1.6 : 1 + 0.05 * (p.side === 'red' ? rank : 7 - rank);
    score += p.side === side ? v : -v;
  }
  return score;
}

/** Two plies: each march, then the opponent's best answer by the same measure. `randomness` is how
 *  often it plays any legal march instead (how the weaker residents blunder). */
export function chooseCheckersMove(s: CheckersState, side: Side, o: { randomness: number; rng: () => number }): CheckersCommand {
  const moves = legal(s, side);
  if (moves.length <= 1) return moves[0];
  if (o.rng() < o.randomness) return moves[Math.floor(o.rng() * moves.length)];
  let top = -Infinity;
  let picks: CheckersCommand[] = [];
  for (const m of moves) {
    const after = play(s, side, m);
    const replies = after.winner ? [] : legal(after, opponent(side));
    const score = replies.length === 0 ? evaluate(after, side) : Math.min(...replies.map((r) => evaluate(play(after, opponent(side), r), side)));
    if (score > top + 1e-9) {
      top = score;
      picks = [m];
    } else if (Math.abs(score - top) <= 1e-9) picks.push(m);
  }
  return picks[Math.floor(o.rng() * picks.length)];
}

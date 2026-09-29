import { GameRuleError, type GameModule, type SeatId } from '@cs/game-api';
import { CATALOG, DEFAULT_DOCTRINE } from './catalog';
import { H, initial, forfeit, outcome, roundEvent, SHRINK_AT, step, TICK_HZ, W, type LLState } from './engine';
import { senses } from './senses';

export { CATALOG, DEFAULT_DOCTRINE } from './catalog';
export { H, W, type Dir, type LLState } from './engine';

export const SEATS = ['red', 'blue', 'green', 'gold'];

/** What everyone sees, spectators included: the arena, the cycles, and the score. */
export interface LLView {
  grid: string[];
  cycles: { seat: SeatId; x: number; y: number; heading: string; alive: boolean; boosts: number; boosting: boolean }[];
  round: number;
  roundTick: number;
  phase: LLState['phase'];
  score: Record<SeatId, number>;
  shrinking: boolean;
  lastWinner: SeatId | null;
}

export const lightlineGame: GameModule<LLState> = {
  meta: {
    id: 'lightline',
    name: 'Lightline',
    tagline: 'Neon light-cycles. Leave a wall; outlast the rest.',
    mode: 'realtime',
    minPlayers: 2,
    maxPlayers: 4,
    seats: SEATS,
    rulesPath: 'games/lightline/docs/rules.md',
    humans: false,
    thumbnail: 'thumbnail.png',
  },
  setup({ seats }) {
    if (seats.length < 2 || seats.length > 4) throw new GameRuleError('BAD_SEATS', 'Lightline takes 2–4 players.');
    return initial(seats);
  },
  view(s): LLView {
    return {
      grid: Array.from({ length: H }, (_, y) => s.cells.slice(y * W, (y + 1) * W).join('')),
      cycles: s.cycles.map(({ seat, x, y, heading, alive, boosts, boostTicks }) => ({ seat, x, y, heading, alive, boosts, boosting: boostTicks > 0 })),
      round: s.round,
      roundTick: s.roundTick,
      phase: s.phase,
      score: s.score,
      shrinking: s.phase === 'play' && s.roundTick >= SHRINK_AT,
      lastWinner: s.lastWinner,
    };
  },
  outcome,
  forfeit: (s, seat) => forfeit(s, seat),
  isOut: (s, seat) => s.cycles.some((c) => c.seat === seat && c.resigned),
  realtime: {
    tickHz: TICK_HZ,
    countdownSeconds: 10,
    catalog: CATALOG,
    defaultDoctrine: DEFAULT_DOCTRINE,
    defaultAction: { act: 'straight' },
    senses,
    step: (s, actions) => step(s, actions),
    roundEvent,
  },
};

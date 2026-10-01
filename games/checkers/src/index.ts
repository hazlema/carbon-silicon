import {GameRuleError, type GameModule, type Outcome, type SeatId} from '@cs/game-api';
import {applyMove, createGame, legalMoves, opponent, type Game, type Side} from './rules';

export type {Side, Piece, Move, Entry, Game} from './rules';
export {coords, squareAt, opponent} from './rules';

/** One complete turn: starting square followed by every landing square. */
export interface CheckersCommand { steps: string[] }
export interface CheckersState extends Game {
  moveCount: number;
  endReason: string | null;
}
/** Checkers has no secrets. Include repetition data so agents can simulate faithfully. */
export interface CheckersView extends CheckersState {
  rows: number;
  cols: number;
  you: Side | null;
}

function validSeat(seat: SeatId): asserts seat is Side {
  if (seat !== 'red' && seat !== 'blue') throw new GameRuleError('BAD_SEAT', 'Choose red or blue.');
}

export function isCheckersCommand(command: unknown): command is CheckersCommand {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  const steps = (command as CheckersCommand).steps;
  return Object.keys(command).length === 1 && Object.keys(command)[0] === 'steps' && Array.isArray(steps)
    && steps.length >= 2 && steps.length <= 13
    && steps.every(square => typeof square === 'string' && /^[a-h][1-8]$/.test(square));
}

function legal(state: CheckersState, seat: SeatId): CheckersCommand[] {
  if (state.winner || seat !== state.turn) return [];
  const commands: CheckersCommand[] = [];
  function walk(game: Game, steps: string[]) {
    for (const move of legalMoves(game)) {
      const path = steps.length ? [...steps, move.to] : [move.from, move.to];
      const next = applyMove(game, move.from, move.to);
      if (next.forcedPiece) walk(next, path);
      else commands.push({steps: path});
    }
  }
  walk(state, []);
  return commands;
}

function outcome(state: CheckersState): Outcome | null {
  if (!state.winner) return null;
  return state.winner === 'draw'
    ? {winners: [], placement: [['red', 'blue']], reason: state.endReason ?? 'draw'}
    : {winners: [state.winner], placement: [[state.winner], [opponent(state.winner)]], reason: state.endReason ?? 'no-moves'};
}

function apply(state: CheckersState, seat: SeatId, command: unknown): CheckersState {
  validSeat(seat);
  if (state.winner) throw new GameRuleError('GAME_OVER', 'The match is already decided.');
  if (seat !== state.turn) throw new GameRuleError('NOT_YOUR_TURN', `It is ${state.turn}'s turn.`);
  if (!isCheckersCommand(command)) throw new GameRuleError('BAD_COMMAND', 'Send {"steps":["a3","b4"]}, including every jump in the turn.');
  const choice = legal(state, seat).find(candidate => candidate.steps.length === command.steps.length
    && candidate.steps.every((square, i) => square === command.steps[i]));
  if (!choice) throw new GameRuleError('ILLEGAL_MOVE', 'Choose a complete command from legal. Captures and continued jumps are mandatory.');

  let game: Game = state;
  for (let i = 1; i < choice.steps.length; i++) game = applyMove(game, choice.steps[i - 1], choice.steps[i]);
  let endReason: string | null = null;
  if (game.winner === 'draw') endReason = Object.values(game.positions).some(count => count >= 3) ? 'repetition' : 'quiet-moves';
  else if (game.winner) endReason = game.pieces.some(piece => piece.side === opponent(game.winner as Side)) ? 'no-moves' : 'last-piece';
  // The host owns its match revision. This local revision counts complete commands, not hops.
  return {...game, revision: state.revision + 1, moveCount: state.moveCount + 1, endReason};
}

export const checkersGame = {
  meta: {
    id: 'checkers', name: 'Crown & Steel', tagline: 'Two houses. One throne. Let strategy decide.',
    mode: 'turn', minPlayers: 2, maxPlayers: 2, seats: ['red', 'blue'],
    rulesPath: 'games/checkers/docs/rules.md', humans: true, thumbnail: 'thumbnail.jpg',
  },
  setup({seats}): CheckersState {
    if (seats.length !== 2 || seats[0] !== 'red' || seats[1] !== 'blue') {
      throw new GameRuleError('BAD_SEATS', 'Crown & Steel requires seats ["red", "blue"] in join order.');
    }
    return {...createGame(), moveCount: 0, endReason: null};
  },
  view(state: CheckersState, seat: SeatId | null): CheckersView {
    if (seat !== null) validSeat(seat);
    return {...structuredClone(state), rows: 8, cols: 8, you: seat};
  },
  outcome,
  forfeit(state: CheckersState, seat: SeatId, reason: string): CheckersState {
    validSeat(seat);
    const next = structuredClone(state);
    if (next.winner) return next;
    next.pieces = next.pieces.filter(piece => piece.side !== seat);
    next.winner = opponent(seat);
    next.forcedPiece = null;
    next.endReason = reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'forfeit';
    next.revision++;
    return next;
  },
  isOut: (state: CheckersState, seat: SeatId): boolean =>
    (seat === 'red' || seat === 'blue') && !!state.winner && state.winner !== 'draw' && state.winner !== seat,
  turn: {
    turnSeconds: 90,
    toMove: (state: CheckersState): SeatId[] => state.winner ? [] : [state.turn],
    legal, apply,
    describe: (command: unknown): string => isCheckersCommand(command) ? command.steps.join('→') : 'move',
  },
} satisfies GameModule<CheckersState>;

export default checkersGame;

import { GameRuleError, type GameModule, type Outcome, type SeatId } from '@cs/game-api';
import { renderAscii } from './ascii';
import { cellIndex, cellName, criticalMass, neighbors } from './board';
import { RULES } from './rules';

export { cellIndex, cellName, criticalMass, neighbors } from './board';

export const SEATS = ['red', 'blue', 'green', 'gold'];
export const MAX_EXPLOSIONS = 10_000;

export interface Cell {
  owner: SeatId | null;
  orbs: number;
}
export interface LastMove {
  seat: SeatId;
  cell: string;
  /** Cells that exploded, wave by wave. */
  waves: string[][];
}
export interface CMState {
  cols: number;
  rows: number;
  seats: SeatId[];
  cells: Cell[];
  turn: SeatId | null;
  moved: SeatId[];
  eliminated: SeatId[];
  moveCount: number;
  lastMove: LastMove | null;
  winner: SeatId | null;
  endReason: string | null;
}
export interface CMCommand {
  cell: string;
}
export interface CMBoardCell {
  cell: string;
  owner: SeatId | null;
  orbs: number;
  critical: number;
}
export interface CMView {
  cols: number;
  rows: number;
  seats: SeatId[];
  turn: SeatId | null;
  you: SeatId | null;
  moved: SeatId[];
  eliminated: SeatId[];
  moveCount: number;
  lastMove: LastMove | null;
  winner: SeatId | null;
  endReason: string | null;
  board: CMBoardCell[];
  counts: Record<SeatId, { cells: number; orbs: number }>;
  ascii: string;
}

const clone = (s: CMState): CMState => structuredClone(s);
const living = (s: CMState) => s.seats.filter((x) => !s.eliminated.includes(x));
const cellsOwned = (s: CMState, seat: SeatId) => s.cells.reduce((n, c) => n + (c.owner === seat ? 1 : 0), 0);
const allMoved = (s: CMState) => s.seats.every((x) => s.moved.includes(x) || s.eliminated.includes(x));
const crit = (s: CMState, i: number) => criticalMass(s.cols, s.rows, i);

function nextSeat(s: CMState, from: SeatId): SeatId {
  const live = living(s);
  const start = s.seats.indexOf(from);
  for (let k = 1; k <= s.seats.length; k++) {
    const candidate = s.seats[(start + k) % s.seats.length];
    if (live.includes(candidate)) return candidate;
  }
  return from;
}

function unstable(s: CMState): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.cells.length; i++) if (s.cells[i].orbs >= crit(s, i)) out.push(i);
  return out;
}

/** Explode unstable cells in waves; every hit cell becomes the mover's. Mutates `s`. */
function resolve(s: CMState, seat: SeatId): string[][] {
  const waves: string[][] = [];
  let explosions = 0;
  let wave = unstable(s);
  while (wave.length > 0) {
    waves.push(wave.map((i) => cellName(s.cols, i)));
    for (const i of wave) {
      s.cells[i].orbs -= crit(s, i);
      if (s.cells[i].orbs === 0) s.cells[i].owner = null;
      for (const n of neighbors(s.cols, s.rows, i)) {
        s.cells[n].orbs += 1;
        s.cells[n].owner = seat;
      }
    }
    explosions += wave.length;
    if (explosions >= MAX_EXPLOSIONS) {
      s.winner = seat;
      s.endReason = 'overload';
      break;
    }
    if (allMoved(s) && living(s).every((x) => x === seat || cellsOwned(s, x) === 0)) break;
    wave = unstable(s);
  }
  return waves;
}

/** Eliminate empty seats, decide a winner, pass the turn. Mutates `s`. */
function settle(s: CMState, seat: SeatId): void {
  if (s.winner) {
    for (const x of living(s)) if (x !== seat) s.eliminated.push(x);
  } else if (allMoved(s)) {
    for (const x of living(s)) if (x !== seat && cellsOwned(s, x) === 0) s.eliminated.push(x);
  }
  const live = living(s);
  if (live.length === 1) {
    s.winner = live[0];
    s.endReason ??= 'last-standing';
    s.turn = null;
    return;
  }
  s.turn = nextSeat(s, seat);
}

function apply(state: CMState, seat: SeatId, command: unknown): CMState {
  if (state.winner) throw new GameRuleError('GAME_OVER', 'The game is over.');
  if (state.turn !== seat) throw new GameRuleError('NOT_YOUR_TURN', `It is ${state.turn}'s turn.`);
  const cellArg = (command as { cell?: unknown } | null)?.cell;
  if (typeof cellArg !== 'string') throw new GameRuleError('BAD_COMMAND', 'Send {"cell": "c4"}.');
  const s = clone(state);
  const i = cellIndex(s.cols, s.rows, cellArg);
  if (i === null) throw new GameRuleError('BAD_CELL', `There is no cell "${cellArg}" on a ${s.cols}×${s.rows} board.`);
  const target = s.cells[i];
  if (target.owner !== null && target.owner !== seat) {
    throw new GameRuleError('OCCUPIED', `${cellName(s.cols, i)} belongs to ${target.owner}.`);
  }
  target.owner = seat;
  target.orbs += 1;
  if (!s.moved.includes(seat)) s.moved.push(seat);
  s.moveCount += 1;
  const waves = resolve(s, seat);
  s.lastMove = { seat, cell: cellName(s.cols, i), waves };
  settle(s, seat);
  return s;
}

function outcome(s: CMState): Outcome | null {
  if (!s.winner) return null;
  return {
    winners: [s.winner],
    placement: [[s.winner], ...[...s.eliminated].reverse().map((x) => [x])],
    reason: s.endReason ?? 'last-standing',
  };
}

function forfeit(state: CMState, seat: SeatId, reason: string): CMState {
  const s = clone(state);
  if (s.winner || s.eliminated.includes(seat)) return s;
  for (const c of s.cells) {
    if (c.owner === seat) {
      c.owner = null;
      c.orbs = 0;
    }
  }
  s.eliminated.push(seat);
  const live = living(s);
  if (live.length === 1) {
    s.winner = live[0];
    s.endReason = reason;
    s.turn = null;
  } else if (s.turn === seat) {
    s.turn = nextSeat(s, seat);
  }
  return s;
}

function view(s: CMState, seat: SeatId | null): CMView {
  const counts: CMView['counts'] = {};
  for (const x of s.seats) counts[x] = { cells: 0, orbs: 0 };
  for (const c of s.cells) {
    if (!c.owner) continue;
    counts[c.owner].cells += 1;
    counts[c.owner].orbs += c.orbs;
  }
  return {
    cols: s.cols,
    rows: s.rows,
    seats: [...s.seats],
    turn: s.turn,
    you: seat,
    moved: [...s.moved],
    eliminated: [...s.eliminated],
    moveCount: s.moveCount,
    lastMove: s.lastMove,
    winner: s.winner,
    endReason: s.endReason,
    board: s.cells.map((c, i) => ({ cell: cellName(s.cols, i), owner: c.owner, orbs: c.orbs, critical: crit(s, i) })),
    counts,
    ascii: renderAscii(s.cols, s.rows, s.cells),
  };
}

/** Rebuild a simulatable state from an agent's view (used by bots). */
export function stateFromView(v: CMView): CMState {
  return {
    cols: v.cols,
    rows: v.rows,
    seats: [...v.seats],
    cells: v.board.map((b) => ({ owner: b.owner, orbs: b.orbs })),
    turn: v.turn,
    moved: [...v.moved],
    eliminated: [...v.eliminated],
    moveCount: v.moveCount,
    lastMove: v.lastMove,
    winner: v.winner,
    endReason: v.endReason,
  };
}

export const criticalMassGame: GameModule<CMState> = {
  meta: {
    id: 'critical-mass',
    name: 'Critical Mass',
    tagline: 'Stack orbs. Start chain reactions. Own the board.',
    mode: 'turn',
    minPlayers: 2,
    maxPlayers: 4,
    seats: SEATS,
    rulesMarkdown: RULES,
  },
  setup({ seats }) {
    if (seats.length < 2 || seats.length > 4) throw new GameRuleError('BAD_SEATS', 'Critical Mass takes 2–4 players.');
    const [cols, rows] = seats.length === 2 ? [6, 9] : [8, 10];
    return {
      cols,
      rows,
      seats: [...seats],
      cells: Array.from({ length: cols * rows }, () => ({ owner: null, orbs: 0 })),
      turn: seats[0],
      moved: [],
      eliminated: [],
      moveCount: 0,
      lastMove: null,
      winner: null,
      endReason: null,
    };
  },
  view,
  outcome,
  forfeit,
  turn: {
    turnSeconds: 90,
    toMove: (s) => (s.turn ? [s.turn] : []),
    legal(s, seat) {
      if (s.winner || s.turn !== seat) return [];
      const out: CMCommand[] = [];
      s.cells.forEach((c, i) => {
        if (c.owner === null || c.owner === seat) out.push({ cell: cellName(s.cols, i) });
      });
      return out;
    },
    apply,
    describe: (command) => String((command as CMCommand).cell),
  },
};

export default criticalMassGame;

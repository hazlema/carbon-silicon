import type { Rng } from './rng';

export type SeatId = string;

export interface GameMeta {
  id: string;
  name: string;
  tagline: string;
  mode: 'turn' | 'realtime';
  minPlayers: number;
  maxPlayers: number;
  /** Seat names in join order; a match with n players uses the first n. */
  seats: SeatId[];
  /** The rules as Markdown, from the repo root. Images beside it are served with it; edits show without a restart. */
  rulesPath: string;
  /** Humans may play it: they steer Lightline with keys or swipes; Critical Mass takes their moves. */
  humans: boolean;
  /** The game chooser's picture: a file beside the rules (e.g. "thumbnail.jpg"), about 16:10. */
  thumbnail?: string;
  /** Better crowded: on start, empty seats fill with free house bots up to maxPlayers (humans and bots count the same). */
  houseFill?: boolean;
  /** How many finished matches of this game each player plays before their matches can be rated (default 3). */
  practiceGames?: number;
}

/** `winners: []` means a draw. `placement` lists seats best-first; ties share an inner array. */
export interface Outcome {
  winners: SeatId[];
  placement: SeatId[][];
  reason: string;
  /** Optional points per seat, shown with names in the table's closing line (Lightline: rounds won). */
  score?: Record<SeatId, number>;
}

export interface SetupContext {
  seats: SeatId[];
  seed: number;
  options?: unknown;
}

export interface GameModule<S = unknown> {
  meta: GameMeta;
  setup(ctx: SetupContext): S;
  /** JSON view for a seat; `null` = spectator. Must hide secrets from other seats. */
  view(state: S, seat: SeatId | null): unknown;
  /** `null` while the game is still being played. */
  outcome(state: S): Outcome | null;
  /** Remove a seat (resign, timeout, disconnect). Must return a state whose outcome reflects it. */
  forfeit(state: S, seat: SeatId, reason: string): S;
  /** Is this seat already out of the game (eliminated or forfeited)? Optional; without it a seat is never out. */
  isOut?(state: S, seat: SeatId): boolean;
  /** Out of the running but still at the table (Salvo's wreck ghosts). Without it, an out seat is released at once. */
  stillSeated?(state: S, seat: SeatId): boolean;
  turn?: TurnRules<S>;
  realtime?: RealtimeRules<S>;
}

export interface TurnRules<S> {
  /** Seconds each seat gets per move before the autopilot plays for them. */
  turnSeconds: number;
  toMove(state: S): SeatId[];
  /** Every legal command for the seat, as JSON-serializable values. */
  legal(state: S, seat: SeatId): unknown[];
  /** Validate and apply. Throws GameRuleError for illegal input. Must not mutate `state`. */
  apply(state: S, seat: SeatId, command: unknown): S;
  /** Short human text for a command, e.g. "c4". */
  describe?(command: unknown): string;
  /**
   * The move as a phrase whose subject is the mover, for the match's recent-moves log and the
   * residents' table talk: "places at b4 — small chain, takes 2 of {blue}'s cells". Write other
   * seats as {seat}; the server swaps in their handles. Optional: without it the log says "plays <describe>".
   */
  narrate?(before: S, after: S, seat: SeatId, command: unknown): string;
  /**
   * Every seat in toMove() moves at once (Salvo). The deadline covers the whole round, any revision
   * since the round opened is accepted, a timeout autopilots every seat still owing, and nothing a
   * seat commits is narrated until the round resolves: the log says "is ready", then roundSummary().
   */
  simultaneous?: boolean;
  /** Required when simultaneous: the current round number. A change opens a new round. */
  round?(state: S): number;
  /** Simultaneous only: the round's story once it has resolved (or the game has ended), credited to no seat. Seats are written {seat}. */
  roundSummary?(before: S, after: S): string[];
  /**
   * Optional: the game's own clock. Called with the current time after every accepted move (and the
   * autopilot's) and at every wake-up asked for by wakeAt(); returns the new state, or the same
   * object when nothing is due. Must be deterministic in nowMs. A change is told through
   * roundSummary(before, after), which then decides what (if anything) the table hears.
   */
  clock?(state: S, nowMs: number): S;
  /** Optional: when the game next wants clock() called (epoch ms), or null. Re-read after every change. */
  wakeAt?(state: S): number | null;
  /**
   * Optional: a seat that owes nothing (not in toMove) may still send a command now, e.g. a bid after
   * firing. Such a move never resets the seat's misses, moves the deadline or changes who owes.
   */
  mayAct?(state: S, seat: SeatId): boolean;
}

// ── Doctrine (standing orders for real-time games, rule 11). Validated and evaluated in doctrine.ts. ──
export type Operand = number | string | boolean | { sense: string };
export interface Condition {
  sense: string;
  op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne';
  value: Operand;
}
export type When = Condition | { all: When[] } | { any: When[] } | { not: When };
export interface Action {
  act: string;
  [param: string]: unknown;
}
export interface Rule {
  when?: When;
  do: Action;
  label?: string;
}
export interface Doctrine {
  rules: Rule[];
}
export interface DoctrineCatalog {
  senses: Record<string, { type: 'number' | 'string' | 'boolean'; doc: string; values?: string[] }>;
  actions: Record<string, { doc: string; params: Record<string, { type: string; doc: string; values?: string[]; required?: boolean }> }>;
}

/** A round started or ended on this step (real-time games with rounds). */
export interface RoundEvent {
  round: number;
  ended: boolean;
  winner: SeatId | null;
  score: Record<SeatId, number>;
}

export interface SteerRules {
  /** Keys that queue, at most two waiting (Lightline: n, e, s, w). */
  moves: readonly string[];
  /** Keys that ride on the next action taken instead of queueing (Lightline: boost). */
  modifiers: readonly string[];
  /** One tick's action: the queued move (null when none) with the modifiers pressed since the last. */
  action(move: string | null, modifiers: readonly string[]): Action;
}

export interface RealtimeRules<S> {
  tickHz: number;
  /** Real-time countdowns are longer, so a machine can think before the first tick. */
  countdownSeconds: number;
  catalog: DoctrineCatalog;
  defaultDoctrine: Doctrine;
  /** What a seat does when no rule of its doctrine holds. */
  defaultAction: Action;
  senses(state: S, seat: SeatId): Record<string, number | string | boolean>;
  step(state: S, actions: Record<SeatId, Action>, rng: Rng): S;
  /** Between rounds: nothing moves, and a person's presses are dropped. */
  paused?(state: S): boolean;
  /** How a person's keys become actions; a game without it can't be steered. */
  steer?: SteerRules;
  roundEvent?(before: S, after: S): RoundEvent | null;
}

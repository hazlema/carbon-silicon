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
  /** Humans may play it (M3a: Lightline is machines-only until steering arrives). */
  humans: boolean;
  /** The game chooser's picture: a file beside the rules (e.g. "thumbnail.jpg"), about 16:10. */
  thumbnail?: string;
}

/** `winners: []` means a draw. `placement` lists seats best-first; ties share an inner array. */
export interface Outcome {
  winners: SeatId[];
  placement: SeatId[][];
  reason: string;
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

import { evaluate, type Action, type Doctrine, type SeatId, type SteerRules } from '@cs/game-api';
import type { FiredRule } from '@cs/shared/protocol';

export type { FiredRule };

export const FLOOR_DEFAULT_MS = 300;
export const FLOOR_MIN_MS = 100;
export const FLOOR_MAX_MS = 2000;

/** The reaction floor in whole ticks: a machine's doctrine changes at most once per this many. */
export function floorTicks(floorMs: number, tickMs: number): number {
  return Math.max(1, Math.ceil(floorMs / tickMs));
}

/** DOCTRINE_FLOOR_MS from the environment: 300 by default, held to 100–2000. */
export function clampFloor(raw: string | undefined, warn: (m: string) => void): number {
  if (raw === undefined || raw.trim() === '') return FLOOR_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warn(`[main] DOCTRINE_FLOOR_MS=${raw} is not a number; using ${FLOOR_DEFAULT_MS}.`);
    return FLOOR_DEFAULT_MS;
  }
  const held = Math.min(FLOOR_MAX_MS, Math.max(FLOOR_MIN_MS, Math.round(n)));
  if (held !== n) warn(`[main] DOCTRINE_FLOOR_MS=${raw} is outside ${FLOOR_MIN_MS}–${FLOOR_MAX_MS}; using ${held}.`);
  return held;
}

/**
 * Each seat's standing orders in one real-time match. A change during the countdown applies at
 * once; once the match is live, a seat's doctrine changes at most once per `floor` ticks. A change
 * sent too soon waits, and a newer one replaces it. Nothing is refused for coming too soon.
 */
export class DoctrineDesk {
  /** Set when the match goes live; from then on the floor holds. */
  live = false;
  /** The next tick to run (so, the ticks run so far). */
  tick = 0;
  readonly fired: Record<SeatId, FiredRule | null> = {};
  private current = new Map<SeatId, Doctrine>();
  private pending = new Map<SeatId, Doctrine>();
  private changedAt = new Map<SeatId, number>();

  constructor(
    seats: SeatId[],
    private fallback: Doctrine,
    readonly floor: number,
  ) {
    for (const s of seats) this.fired[s] = null;
  }

  doctrineOf(seat: SeatId): Doctrine {
    return this.current.get(seat) ?? this.fallback;
  }

  pendingOf(seat: SeatId): Doctrine | null {
    return this.pending.get(seat) ?? null;
  }

  private due(seat: SeatId): number {
    const last = this.changedAt.get(seat);
    return last === undefined ? this.tick : Math.max(this.tick, last + this.floor);
  }

  private apply(seat: SeatId, d: Doctrine): void {
    this.current.set(seat, d);
    this.pending.delete(seat);
    if (this.live) this.changedAt.set(seat, this.tick);
  }

  set(seat: SeatId, d: Doctrine): { status: 'applied' | 'pending'; appliesAtTick: number } {
    const at = this.live ? this.due(seat) : this.tick;
    if (at <= this.tick) {
      this.apply(seat, d);
      return { status: 'applied', appliesAtTick: this.tick };
    }
    this.pending.set(seat, d);
    return { status: 'pending', appliesAtTick: at };
  }

  /** The start of a tick: waiting changes whose floor has passed take over. Returns those seats. */
  beginTick(): SeatId[] {
    const changed: SeatId[] = [];
    for (const [seat, d] of [...this.pending]) {
      if (this.due(seat) <= this.tick) {
        this.apply(seat, d);
        changed.push(seat);
      }
    }
    return changed;
  }

  /** The seat's action for this tick (null: no rule held), noting which rule fired. */
  decide(seat: SeatId, senses: Record<string, number | string | boolean>): Action | null {
    const d = this.doctrineOf(seat);
    const { action, fired } = evaluate(d, senses);
    this.fired[seat] = fired === null ? null : { index: fired, label: d.rules[fired].label ?? null };
    return action;
  }

  endTick(): void {
    this.tick += 1;
  }
}

/** The most moves a person may have waiting: enough for a quick double turn, not a macro. */
export const STEER_QUEUE_MAX = 2;

/**
 * A person's keys in one real-time match. Moves queue (a third replaces the last, and a repeat of
 * the last is dropped), modifiers ride on the next action, and each tick takes one. Humans have no
 * reaction floor: their own reflexes are the floor.
 */
export class SteerQueue {
  private moves: string[] = [];
  private mods = new Set<string>();

  constructor(private rules: SteerRules) {}

  press(key: string): boolean {
    if (this.rules.modifiers.includes(key)) {
      this.mods.add(key);
      return true;
    }
    if (!this.rules.moves.includes(key)) return false;
    if (this.moves.at(-1) === key) return true;
    if (this.moves.length >= STEER_QUEUE_MAX) this.moves[this.moves.length - 1] = key;
    else this.moves.push(key);
    return true;
  }

  take(): Action {
    const action = this.rules.action(this.moves.shift() ?? null, [...this.mods]);
    this.mods.clear();
    return action;
  }

  clear(): void {
    this.moves = [];
    this.mods.clear();
  }
}

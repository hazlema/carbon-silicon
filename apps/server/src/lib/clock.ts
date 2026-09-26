export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Deterministic clock for tests: timers only fire inside advance(). */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.UTC(2026, 8, 26, 12, 0, 0)) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Move time forward, firing due timers in order (timers scheduled while advancing also fire if due). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let next: { at: number; fn: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at > end) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && id < nextId)) {
          next = timer;
          nextId = id;
        }
      }
      if (!next) break;
      this.timers.delete(nextId);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  pending(): number {
    return this.timers.size;
  }
}

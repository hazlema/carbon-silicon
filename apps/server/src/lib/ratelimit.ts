import type { Clock } from './clock';

const PRUNE_EVERY = 1000;

/** Token bucket per key: `capacity` burst, refilling `refillPerMs` tokens per millisecond. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private calls = 0;

  constructor(
    private clock: Clock,
    private capacity: number,
    private refillPerMs: number,
  ) {}

  take(key: string): boolean {
    const now = this.clock.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
    bucket.at = now;
    this.buckets.set(key, bucket);
    const ok = bucket.tokens >= 1;
    if (ok) bucket.tokens -= 1;
    if (++this.calls % PRUNE_EVERY === 0) this.prune();
    return ok;
  }

  /** Gives a spent token back, capped at capacity. No effect on a key with no bucket (nothing was ever taken). */
  refund(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
  }

  /** Forgets buckets that have refilled to capacity: a full bucket behaves exactly like a missing one. */
  prune(): number {
    const now = this.clock.now();
    let dropped = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.at) * this.refillPerMs >= this.capacity) {
        this.buckets.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.buckets.size;
  }
}

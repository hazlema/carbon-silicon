import type { Clock } from './clock';

/** Token bucket per key: `capacity` burst, refilling `refillPerMs` tokens per millisecond. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

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
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Gives a spent token back, capped at capacity. No effect on a key with no bucket (nothing was ever taken). */
  refund(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
  }
}

import { describe, expect, test } from 'bun:test';
import { EventBus } from '../core/bus';
import { FakeClock } from './clock';
import { hashSecret, newId, newSecret } from './ids';
import { clientIp, isLoopback } from './ip';
import { RateLimiter } from './ratelimit';

describe('FakeClock', () => {
  test('fires timers in order, only when advanced', () => {
    const clock = new FakeClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 200);
    clock.setTimeout(() => fired.push('a'), 100);
    const c = clock.setTimeout(() => fired.push('c'), 150);
    clock.clearTimeout(c);
    clock.advance(99);
    expect(fired).toEqual([]);
    clock.advance(200);
    expect(fired).toEqual(['a', 'b']);
    expect(clock.now()).toBe(299);
  });
  test('timers scheduled during advance fire if due', () => {
    const clock = new FakeClock(0);
    const fired: number[] = [];
    clock.setTimeout(() => clock.setTimeout(() => fired.push(clock.now()), 50), 50);
    clock.advance(100);
    expect(fired).toEqual([100]);
  });
});

describe('ids', () => {
  test('ids and secrets are prefixed and unique; hashes are stable', () => {
    expect(newId('m')).toMatch(/^m_[0-9a-f]{16}$/);
    expect(newSecret('cs_')).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
    expect(newSecret('cs_')).not.toBe(newSecret('cs_'));
    expect(hashSecret('x')).toBe(hashSecret('x'));
    expect(hashSecret('x')).toHaveLength(64);
  });
});

describe('RateLimiter', () => {
  test('allows a burst then refills over time', () => {
    const clock = new FakeClock(0);
    const rl = new RateLimiter(clock, 5, 1 / 2000);
    for (let i = 0; i < 5; i++) expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    expect(rl.take('b')).toBe(true);
    clock.advance(2000);
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });
  test('refund gives a spent token back, capped at capacity, and no-ops on an unknown key', () => {
    const clock = new FakeClock(0);
    const rl = new RateLimiter(clock, 3, 0);
    rl.refund('never-taken'); // no bucket yet: nothing to do, and it must not create one that grants a free token
    expect(rl.take('never-taken')).toBe(true);
    expect(rl.take('never-taken')).toBe(true);
    expect(rl.take('never-taken')).toBe(true);
    expect(rl.take('never-taken')).toBe(false);

    for (let i = 0; i < 3; i++) expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    rl.refund('a');
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    // refunding past capacity doesn't overfill the bucket
    rl.refund('a');
    rl.refund('a');
    rl.refund('a');
    rl.refund('a');
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });
});

describe('clientIp', () => {
  test('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(clientIp('6.6.6.6', '203.0.113.9', false)).toBe('203.0.113.9');
    expect(clientIp('6.6.6.6', undefined, false)).toBe('local');
  });
  test('behind a trusted proxy, the last hop is the client (nginx sets or appends it)', () => {
    expect(clientIp('198.51.100.7', '127.0.0.1', true)).toBe('198.51.100.7');
    // a client that sends its own X-Forwarded-For can only prepend lies; the proxy's entry is last
    expect(clientIp('6.6.6.6, 198.51.100.7', '127.0.0.1', true)).toBe('198.51.100.7');
    expect(clientIp(' , ', '127.0.0.1', true)).toBe('127.0.0.1');
    expect(clientIp(null, '127.0.0.1', true)).toBe('127.0.0.1');
  });
  test('loopback addresses', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(ip)).toBe(true);
    for (const ip of ['10.0.0.1', '127.0.0.2x', '', null, undefined, 'local']) expect(isLoopback(ip)).toBe(false);
  });
});

describe('RateLimiter pruning', () => {
  test('prune drops only buckets that have refilled to capacity', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(clock, 2, 1 / 1000);
    rl.take('a');
    rl.take('b');
    rl.take('b');
    expect(rl.size).toBe(2);
    clock.advance(1000); // a is full again (1 + 1); b has 1 of 2
    expect(rl.prune()).toBe(1);
    expect(rl.size).toBe(1);
    // a pruned key behaves exactly like a fresh one
    expect([rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([true, true, false]);
  });
  test('take() prunes by itself every 1000 calls', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(clock, 1, 1 / 1000);
    for (let i = 0; i < 999; i++) rl.take(`k${i}`);
    expect(rl.size).toBe(999);
    clock.advance(2000);
    rl.take('last'); // the 1000th call
    expect(rl.size).toBe(1);
  });
});

describe('EventBus', () => {
  test('delivers to subscribers, isolates failures, unsubscribes', () => {
    const bus = new EventBus();
    const got: number[] = [];
    bus.on('match.updated', () => {
      throw new Error('boom');
    });
    const off = bus.on('match.updated', (p) => got.push(p.revision));
    bus.emit('match.updated', { matchId: 'm', revision: 1 });
    off();
    bus.emit('match.updated', { matchId: 'm', revision: 2 });
    expect(got).toEqual([1]);
  });
});

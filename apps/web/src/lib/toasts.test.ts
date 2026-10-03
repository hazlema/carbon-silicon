import { describe, expect, test } from 'bun:test';
import type { ChatMessage, IdentityPublic } from '@cs/shared/protocol';
import { CATCH_UP_MS, TOAST_MS, ToastQueue, recentLines } from './toasts';

const texts = (q: ToastQueue) => q.visible.map((l) => l.text);

const who = (id: string, kind: 'human' | 'agent' = 'agent') => ({ id, handle: id.toUpperCase(), kind }) as IdentityPublic;
let n = 0;
const msg = (author: IdentityPublic | null, text = `line ${++n}`): ChatMessage => ({
  id: ++n, channel: 'table:t_1', author, text, createdAt: '', system: author === null, removed: null,
});

function fakeTimers() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => (timers.set(++seq, { at: t + ms, fn }), seq),
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      t += ms;
      for (const [k, v] of [...timers]) if (v.at <= t) (timers.delete(k), v.fn());
    },
  };
}

describe('ToastQueue', () => {
  test('a line from someone else toasts for 6 s and counts as unread', () => {
    const timers = fakeTimers();
    const q = new ToastQueue({ meId: () => 'me', ...timers });
    q.push(msg(who('iron'), 'SQUARE.'));
    expect(q.visible[0]).toMatchObject({ text: 'SQUARE.', author: { handle: 'IRON', kind: 'agent' } });
    expect(q.unread).toBe(1);
    timers.advance(TOAST_MS - 1);
    expect(q.visible).toHaveLength(1);
    timers.advance(1);
    expect(q.visible).toEqual([]);
    expect(q.unread).toBe(1);
    expect(TOAST_MS).toBe(6000);
  });
  test('your own lines never toast; system lines do, without a name', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    q.push(msg(who('me', 'human')));
    expect(q.visible).toEqual([]);
    expect(q.unread).toBe(0);
    q.push(msg(null, '@ann dozed off — autopilot played c4.'));
    expect(q.visible[0]).toMatchObject({ author: null, text: '@ann dozed off — autopilot played c4.' });
  });
  test('up to three stack, oldest first; each lives 6 s from its own arrival', () => {
    const timers = fakeTimers();
    const q = new ToastQueue({ meId: () => 'me', ...timers });
    q.push(msg(who('a'), 'one'));
    timers.advance(2000);
    q.push(msg(who('b'), 'two'));
    timers.advance(1000);
    q.push(msg(who('c'), 'three'));
    expect(texts(q)).toEqual(['one', 'two', 'three']);
    expect(q.unread).toBe(3);
    timers.advance(3000); // 6 s since "one"
    expect(texts(q)).toEqual(['two', 'three']);
    timers.advance(2000); // 6 s since "two"
    expect(texts(q)).toEqual(['three']);
    timers.advance(1000);
    expect(texts(q)).toEqual([]);
  });
  test('a fourth arrival pushes the oldest out at once', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    for (const t of ['one', 'two', 'three', 'four']) q.push(msg(who('a'), t));
    expect(texts(q)).toEqual(['two', 'three', 'four']);
    expect(q.unread).toBe(4);
  });
  test('max is an option', () => {
    const q = new ToastQueue({ meId: () => 'me', max: 2, ...fakeTimers() });
    for (const t of ['one', 'two', 'three']) q.push(msg(who('a'), t));
    expect(texts(q)).toEqual(['two', 'three']);
  });
  test('with the sheet open nothing toasts and nothing counts; opening clears both', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    q.push(msg(who('a')));
    q.setOpen(true);
    expect([q.visible, q.unread]).toEqual([[], 0]);
    q.push(msg(who('a')));
    expect([q.visible, q.unread]).toEqual([[], 0]);
    q.setOpen(false);
    q.push(msg(who('a')));
    expect(q.unread).toBe(1);
  });
  test('dismiss(id) removes one toast; dismiss() clears all but keeps the count; reset clears both; removed lines are ignored', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    const a = msg(who('a'), 'one');
    q.push(a);
    q.push(msg(who('a'), 'two'));
    q.dismiss(a.id);
    expect(texts(q)).toEqual(['two']);
    q.dismiss();
    expect([q.visible, q.unread]).toEqual([[], 2]);
    q.reset();
    expect(q.unread).toBe(0);
    q.push({ ...msg(who('a')), removed: { by: 'mod' } });
    expect(q.visible).toEqual([]);
  });
  test('a dismissed toast does not come back when its timer would have fired', () => {
    const timers = fakeTimers();
    const q = new ToastQueue({ meId: () => 'me', ...timers });
    const a = msg(who('a'), 'one');
    q.push(a);
    q.dismiss(a.id);
    q.push(msg(who('a'), 'two'));
    timers.advance(TOAST_MS - 1);
    expect(texts(q)).toEqual(['two']);
  });
  test('onChange fires on every change', () => {
    const timers = fakeTimers();
    let calls = 0;
    const q = new ToastQueue({ meId: () => 'me', ...timers });
    q.onChange = () => calls++;
    q.push(msg(who('a')));
    timers.advance(TOAST_MS);
    q.setOpen(true);
    expect(calls).toBe(3);
  });
  test('lines from hidden (ignored or blocked) authors never toast or count', () => {
    const hidden = new Set(['pest']);
    const q = new ToastQueue({ meId: () => 'me', hidden: () => hidden, ...fakeTimers() });
    q.push(msg(who('pest', 'human'), 'you are bad'));
    expect([q.visible, q.unread]).toEqual([[], 0]);
    q.push(msg(who('iron'), 'SQUARE.'));
    expect([texts(q), q.unread]).toEqual([['SQUARE.'], 1]);
    hidden.clear(); // the set is read at push time, so unblocking takes effect at once
    q.push(msg(who('pest', 'human'), 'sorry'));
    expect([texts(q), q.unread]).toEqual([['SQUARE.', 'sorry'], 2]);
  });
  test('count: false toasts without adding to the unread count (DMs keep their own)', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    q.push(msg(who('ann', 'human'), 'psst'), { count: false });
    expect([texts(q), q.unread]).toEqual([['psst'], 0]);
    q.push(msg(who('iron'), 'SQUARE.'));
    expect(q.unread).toBe(1);
  });
  test('a line already shown or counted is ignored when it arrives again (history catch-up vs live)', () => {
    const timers = fakeTimers();
    const q = new ToastQueue({ meId: () => 'me', ...timers });
    const m = msg(who('a'), 'hello');
    q.push(m);
    q.push({ ...m });
    expect([texts(q), q.unread]).toEqual([['hello'], 1]);
    timers.advance(TOAST_MS); // gone from the screen, still remembered
    q.push({ ...m });
    expect([texts(q), q.unread]).toEqual([[], 1]);
  });
  test('a line that was skipped (sheet open, hidden author) can still toast later', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    const m = msg(who('a'), 'late');
    q.setOpen(true);
    q.push(m);
    q.setOpen(false);
    q.push(m);
    expect(texts(q)).toEqual(['late']);
  });
});

describe('ToastQueue.setLimits', () => {
  test('shrinking the stack keeps only the newest', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    for (const t of ['one', 'two', 'three']) q.push(msg(who('a'), t));
    q.setLimits(1, 2500);
    expect(texts(q)).toEqual(['three']);
    q.setLimits(3, 0);
    expect(texts(q)).toEqual(['three']);
  });
});

describe('ToastQueue, single slot with a minimum on-screen time (Lightline footer)', () => {
  const opts = (timers: ReturnType<typeof fakeTimers>) => ({ meId: () => 'me', max: 1, minShowMs: 2500, ...timers });
  test('a newer line waits until the older has had 2.5 s, then replaces it', () => {
    const timers = fakeTimers();
    const q = new ToastQueue(opts(timers));
    q.push(msg(who('a'), 'one'));
    timers.advance(800);
    q.push(msg(who('b'), 'two'));
    expect(texts(q)).toEqual(['one']);
    timers.advance(1699);
    expect(texts(q)).toEqual(['one']);
    timers.advance(1);
    expect(texts(q)).toEqual(['two']);
    expect(q.unread).toBe(2);
  });
  test('a newer line replaces an older one at once once it has been up 2.5 s', () => {
    const timers = fakeTimers();
    const q = new ToastQueue(opts(timers));
    q.push(msg(who('a'), 'one'));
    timers.advance(3000);
    q.push(msg(who('b'), 'two'));
    expect(texts(q)).toEqual(['two']);
  });
  test('a burst plays one after another, 2.5 s each', () => {
    const timers = fakeTimers();
    const q = new ToastQueue(opts(timers));
    for (const t of ['one', 'two', 'three']) q.push(msg(who('a'), t));
    expect(texts(q)).toEqual(['one']);
    timers.advance(2500);
    expect(texts(q)).toEqual(['two']);
    timers.advance(2499);
    expect(texts(q)).toEqual(['two']);
    timers.advance(1);
    expect(texts(q)).toEqual(['three']);
  });
  test('queued lines older than 6 s are dropped', () => {
    const timers = fakeTimers();
    const q = new ToastQueue(opts(timers));
    for (const t of ['one', 'two', 'three', 'four']) q.push(msg(who('a'), t)); // all arrive at t=0
    timers.advance(2500);
    timers.advance(2500); // "three" has just taken the slot
    expect(texts(q)).toEqual(['three']);
    timers.advance(2500); // "four" would show now, but it is 7.5 s old
    expect(texts(q)).toEqual(['three']);
    timers.advance(3500); // "three" has been up 6 s
    expect(texts(q)).toEqual([]);
  });
  test('a line left on screen still leaves after 6 s when nothing is waiting', () => {
    const timers = fakeTimers();
    const q = new ToastQueue(opts(timers));
    q.push(msg(who('a'), 'one'));
    timers.advance(TOAST_MS);
    expect(texts(q)).toEqual([]);
  });
  test('dismiss and open clear the waiting lines too', () => {
    const timers = fakeTimers();
    const q = new ToastQueue(opts(timers));
    q.push(msg(who('a'), 'one'));
    q.push(msg(who('b'), 'two'));
    q.dismiss();
    timers.advance(5000);
    expect(texts(q)).toEqual([]);
    q.push(msg(who('a'), 'three'));
    q.push(msg(who('b'), 'four'));
    q.setOpen(true);
    q.setOpen(false);
    timers.advance(5000);
    expect(texts(q)).toEqual([]);
  });
});

describe('recentLines (the opening line that arrived just before the page was listening)', () => {
  const at = (ageMs: number, now: number, text: string, id: number): ChatMessage => ({ ...msg(who('a'), text), id, createdAt: new Date(now - ageMs).toISOString() });
  test('keeps lines from the last 10 s, oldest first, at most max', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const history = [at(30_000, now, 'old', 1), at(9_000, now, 'a', 2), at(5_000, now, 'b', 3), at(1_000, now, 'c', 4)];
    expect(CATCH_UP_MS).toBe(10_000);
    expect(recentLines(history, now, 3).map((m) => m.text)).toEqual(['a', 'b', 'c']);
    expect(recentLines(history, now, 2).map((m) => m.text)).toEqual(['b', 'c']);
    expect(recentLines([at(10_001, now, 'x', 5)], now, 3)).toEqual([]);
  });
  test('system lines (the table intro, "sat down") are never caught up', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const sys = { ...at(2_000, now, '@a vs @b — Critical Mass. Talk trash; play fair.', 8), author: null, system: true };
    expect(recentLines([sys, at(1_000, now, 'hi', 9)], now, 3).map((m) => m.text)).toEqual(['hi']);
  });
  test('catching up and then hearing the same line live toasts it once', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    const now = Date.now();
    const m = at(2_000, now, 'Let us make some chain reactions', 77);
    for (const l of recentLines([m], now, q.max)) q.push(l);
    q.push({ ...m });
    expect([texts(q), q.unread]).toEqual([['Let us make some chain reactions'], 1]);
  });
});

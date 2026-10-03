import { describe, expect, test } from 'bun:test';
import type { ChatMessage, IdentityPublic } from '@cs/shared/protocol';
import { TOAST_MS, ToastQueue } from './toasts';

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
    setTimeout: (fn: () => void, ms: number) => (timers.set(++seq, { at: t + ms, fn }), seq),
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      t += ms;
      for (const [k, v] of [...timers]) if (v.at <= t) (timers.delete(k), v.fn());
    },
  };
}

describe('ToastQueue', () => {
  test('a line from someone else toasts for 5 s and counts as unread', () => {
    const timers = fakeTimers();
    const q = new ToastQueue({ meId: () => 'me', ...timers });
    q.push(msg(who('iron'), 'SQUARE.'));
    expect(q.current).toMatchObject({ text: 'SQUARE.', author: { handle: 'IRON', kind: 'agent' } });
    expect(q.unread).toBe(1);
    timers.advance(TOAST_MS - 1);
    expect(q.current).not.toBeNull();
    timers.advance(1);
    expect(q.current).toBeNull();
    expect(q.unread).toBe(1);
  });
  test('your own lines never toast; system lines do, without a name', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    q.push(msg(who('me', 'human')));
    expect(q.current).toBeNull();
    expect(q.unread).toBe(0);
    q.push(msg(null, '@ann dozed off — autopilot played c4.'));
    expect(q.current).toMatchObject({ author: null, text: '@ann dozed off — autopilot played c4.' });
  });
  test('a burst shows only the newest and counts them all; each new one restarts the 5 s', () => {
    const timers = fakeTimers();
    const q = new ToastQueue({ meId: () => 'me', ...timers });
    q.push(msg(who('a'), 'one'));
    timers.advance(4000);
    q.push(msg(who('b'), 'two'));
    q.push(msg(who('c'), 'three'));
    expect(q.current?.text).toBe('three');
    expect(q.unread).toBe(3);
    timers.advance(4000);
    expect(q.current?.text).toBe('three');
    timers.advance(1000);
    expect(q.current).toBeNull();
  });
  test('with the sheet open nothing toasts and nothing counts; opening clears both', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    q.push(msg(who('a')));
    q.setOpen(true);
    expect([q.current, q.unread]).toEqual([null, 0]);
    q.push(msg(who('a')));
    expect([q.current, q.unread]).toEqual([null, 0]);
    q.setOpen(false);
    q.push(msg(who('a')));
    expect(q.unread).toBe(1);
  });
  test('dismiss clears the toast but keeps the count; reset clears both; removed lines are ignored', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    q.push(msg(who('a')));
    q.dismiss();
    expect([q.current, q.unread]).toEqual([null, 1]);
    q.reset();
    expect(q.unread).toBe(0);
    q.push({ ...msg(who('a')), removed: { by: 'mod' } });
    expect(q.current).toBeNull();
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
    expect([q.current, q.unread]).toEqual([null, 0]);
    q.push(msg(who('iron'), 'SQUARE.'));
    expect([q.current?.text, q.unread]).toEqual(['SQUARE.', 1]);
    hidden.clear(); // the set is read at push time, so unblocking takes effect at once
    q.push(msg(who('pest', 'human'), 'sorry'));
    expect([q.current?.text, q.unread]).toEqual(['sorry', 2]);
  });
  test('count: false toasts without adding to the unread count (DMs keep their own)', () => {
    const q = new ToastQueue({ meId: () => 'me', ...fakeTimers() });
    q.push(msg(who('ann', 'human'), 'psst'), { count: false });
    expect([q.current?.text, q.unread]).toEqual(['psst', 0]);
    q.push(msg(who('iron'), 'SQUARE.'));
    expect(q.unread).toBe(1);
  });
});

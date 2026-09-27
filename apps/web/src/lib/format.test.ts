import { describe, expect, test } from 'bun:test';
import { clean, relativeTime, sanctionHeadline, untilText } from './format';

const opts = { now: Date.UTC(2026, 8, 27, 12, 0, 0), locale: 'en-US', timeZone: 'UTC' };

describe('clean', () => {
  test('turns a narrow no-break space or a no-break space into a plain space', () => {
    expect(clean('3:40 PM')).toBe('3:40 PM');
    expect(clean('3:40 PM')).toBe('3:40 PM');
  });
});

describe('untilText', () => {
  test('a permanent sanction has no end', () => {
    expect(untilText(null, opts)).toBe('until further notice');
  });
  test('an end later today shows only the time', () => {
    expect(untilText('2026-09-27T15:40:00Z', opts)).toBe('until 3:40 PM');
  });
  test('an end on another day shows the day too', () => {
    expect(untilText('2026-09-29T15:40:00Z', opts)).toBe('until Tue, Sep 29 at 3:40 PM');
  });
});

describe('sanctionHeadline', () => {
  test('says which sanction it is', () => {
    expect(sanctionHeadline({ kind: 'mute' })).toBe("You're muted");
    expect(sanctionHeadline({ kind: 'suspend' })).toBe('Your account is suspended');
  });
});

describe('relativeTime', () => {
  const ago = (ms: number) => new Date(opts.now - ms).toISOString();
  test('recent times read naturally', () => {
    expect(relativeTime(ago(30_000), opts)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), opts)).toBe('5 min ago');
    expect(relativeTime(ago(3 * 3_600_000), opts)).toBe('3 h ago');
    expect(relativeTime(ago(26 * 3_600_000), opts)).toBe('yesterday');
    expect(relativeTime(ago(4 * 86_400_000), opts)).toBe('4 days ago');
  });
  test('older times become a date', () => {
    expect(relativeTime('2026-09-17T12:00:00Z', opts)).toBe('Sep 17, 2026');
  });
});

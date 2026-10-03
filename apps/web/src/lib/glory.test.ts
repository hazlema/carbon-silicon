import { describe, expect, test } from 'bun:test';
import { standingOf, titleText } from './glory';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 3, 12);
const human = { kind: 'human' as const, locked: true };

describe('standingOf', () => {
  test('in the grace week: days remaining, rounded up, and the button for a human', () => {
    expect(standingOf(human, { rankedAt: new Date(now + 3.2 * DAY).toISOString() }, now)).toEqual({ text: 'Unranked games · 4 days remaining', canGoRanked: true });
    expect(standingOf(human, { rankedAt: new Date(now + 2 * 3_600_000).toISOString() }, now)).toEqual({ text: 'Unranked games · 1 day remaining', canGoRanked: true });
  });
  test('ranked', () => {
    expect(standingOf(human, { rankedAt: new Date(now - DAY).toISOString() }, now)).toEqual({ text: 'All games are ranked', canGoRanked: false });
    expect(standingOf({ kind: 'agent', locked: false }, { rankedAt: new Date(now).toISOString() }, now)).toEqual({ text: 'All games are ranked', canGoRanked: false });
  });
  test('a guest is told to lock, whatever the date says', () => {
    expect(standingOf({ kind: 'human', locked: false }, { rankedAt: new Date(now + DAY).toISOString() }, now)).toEqual({ text: 'Unranked · lock your name to be ranked', canGoRanked: false });
  });
});

describe('titleText', () => {
  test('Champion · game · month', () => {
    expect(titleText({ season: '2026-09', gameId: 'checkers' }, 'Crown & Steel')).toBe('Champion · Crown & Steel · September 2026');
  });
});

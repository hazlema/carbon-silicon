import { describe, expect, test } from 'bun:test';
import type { IdentityPublic, StandingRow } from '@cs/shared/protocol';
import { boardName, boardRows, emptyBoardText, monthLabel, monthName, ordinal } from './leaderboard';

const who = (id: string, released = false): IdentityPublic => ({
  id, handle: id, kind: 'agent', tagline: null, color: '#fff', model: null, isHouse: false, locked: false, role: 'user', ownerHandle: null, released,
});
const row = (rank: number, id: string): StandingRow => ({ rank, identity: who(id), points: 0, wins: 0, draws: 0, losses: 0, games: 1, elo: 1000 });

describe('months', () => {
  test('a season reads as its month', () => {
    expect(monthLabel('2026-09')).toBe('September 2026');
    expect(monthName('2026-10')).toBe('October');
  });
});

describe('ordinal', () => {
  test('1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 101st 111th', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });
});

describe('boardRows', () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(i + 1, `p${i + 1}`));
  test('the top 50; a viewer further down is pinned with their real rank', () => {
    const { top, pinned } = boardRows(rows, 'p57');
    expect(top).toHaveLength(50);
    expect(pinned?.rank).toBe(57);
  });
  test('no pin when the viewer is in the top 50, is not on the board, or is signed out', () => {
    expect(boardRows(rows, 'p3').pinned).toBeNull();
    expect(boardRows(rows, 'nobody').pinned).toBeNull();
    expect(boardRows(rows, null).pinned).toBeNull();
  });
});

describe('words', () => {
  test('a released player is "a former player"', () => {
    expect(boardName(who('ann'))).toBe('ann');
    expect(boardName(who('ann', true))).toBe('a former player');
  });
  test('empty boards', () => {
    expect(emptyBoardText('Lightline', '2026-10', '2026-10')).toBe('No ranked games of Lightline yet this month. The first win takes 1st place.');
    expect(emptyBoardText('Lightline', '2026-09', '2026-10')).toBe('No ranked games of Lightline in September.');
  });
});

import { describe, expect, test } from 'bun:test';
import type { IdentityPublic, ProfileRecord, ProfileRival } from '@cs/shared/protocol';
import { displayName, gameName, matchEndingText, recordSummaryLine, recordWinSharePercent, resultChip, rivalrySentence } from './profile';

const who = (over: Partial<IdentityPublic>): IdentityPublic => ({
  id: 'id_1',
  handle: 'Ada',
  kind: 'human',
  tagline: null,
  color: '#ff8a3d',
  model: null,
  isHouse: false,
  locked: false,
  role: 'user',
  ownerHandle: null,
  released: false,
  ...over,
});

describe('displayName', () => {
  test('a handle, or "a former player" once released', () => {
    expect(displayName(who({}))).toBe('Ada');
    expect(displayName(who({ handle: '~id_1', released: true }))).toBe('a former player');
  });
});

describe('gameName', () => {
  test('title-cases a game id', () => {
    expect(gameName('critical-mass')).toBe('Critical Mass');
    expect(gameName('lightline')).toBe('Lightline');
  });
});

describe('resultChip', () => {
  test('labels and tones', () => {
    expect(resultChip('win')).toEqual({ label: 'Win', tone: 'win' });
    expect(resultChip('loss')).toEqual({ label: 'Loss', tone: 'loss' });
    expect(resultChip('draw')).toEqual({ label: 'Draw', tone: 'draw' });
    expect(resultChip('abandoned')).toEqual({ label: 'Abandoned', tone: 'void' });
    expect(resultChip(null)).toEqual({ label: 'No result', tone: 'void' });
  });
});

describe('matchEndingText', () => {
  test('maps known end reasons to plain phrasing', () => {
    expect(matchEndingText('last-standing')).toBe('wiped out');
    expect(matchEndingText('resign')).toBe('resigned');
    expect(matchEndingText('timeout')).toBe('timed out');
    expect(matchEndingText('overload')).toBe('board went critical');
  });
  test('falls back to the raw reason with dashes as spaces', () => {
    expect(matchEndingText('server-restart')).toBe('server restart');
    expect(matchEndingText('mystery')).toBe('mystery');
  });
  test('is empty when there is no reason', () => {
    expect(matchEndingText(null)).toBe('');
  });
});

const record = (over: Partial<ProfileRecord>): ProfileRecord => ({
  versus: 'machines',
  wins: 0,
  losses: 0,
  draws: 0,
  played: 0,
  games: [],
  ...over,
});

describe('recordSummaryLine', () => {
  test('names the most-played game and its count', () => {
    expect(
      recordSummaryLine(
        record({ played: 4, wins: 0, losses: 4, games: [{ gameId: 'critical-mass', played: 4 }] }),
      ),
    ).toBe('Critical Mass · 4 played');
  });
  test('says so when nothing has been played yet', () => {
    expect(recordSummaryLine(record({ versus: 'machines' }))).toBe('No games vs machines yet');
    expect(recordSummaryLine(record({ versus: 'humans' }))).toBe('No games vs humans yet');
  });
});

describe('recordWinSharePercent', () => {
  test('the share of played matches that were wins', () => {
    expect(recordWinSharePercent(record({ wins: 3, losses: 1, played: 4 }))).toBe(75);
    expect(recordWinSharePercent(record({ wins: 0, losses: 4, played: 4 }))).toBe(0);
  });
  test('zero with nothing played, not NaN', () => {
    expect(recordWinSharePercent(record({}))).toBe(0);
  });
});

describe('rivalrySentence', () => {
  const opponent = who({ id: 'id_2', handle: 'OLD_IRON', kind: 'agent' });
  const rival = (over: Partial<ProfileRival>): ProfileRival => ({ opponent, wins: 0, losses: 0, draws: 0, ...over });

  test('the owner ahead, viewed by the owner, reads "You\'re"', () => {
    expect(rivalrySentence(rival({ wins: 3, losses: 1 }), { mine: true, ownerHandle: 'Ada' })).toBe("You're up 3–1.");
  });
  test('the owner ahead, viewed by a visitor, uses the owner\'s handle', () => {
    expect(rivalrySentence(rival({ wins: 3, losses: 1 }), { mine: false, ownerHandle: 'Ada' })).toBe('Ada is up 3–1.');
  });
  test('the rival ahead names the rival, regardless of viewer', () => {
    expect(rivalrySentence(rival({ wins: 0, losses: 4 }), { mine: true, ownerHandle: 'Ada' })).toBe('OLD_IRON is up 4–0.');
    expect(rivalrySentence(rival({ wins: 0, losses: 4 }), { mine: false, ownerHandle: 'Ada' })).toBe('OLD_IRON is up 4–0.');
  });
  test('level is "all square", not "up 0"', () => {
    expect(rivalrySentence(rival({ wins: 2, losses: 2 }), { mine: true, ownerHandle: 'Ada' })).toBe('All square at 2–2.');
  });
});

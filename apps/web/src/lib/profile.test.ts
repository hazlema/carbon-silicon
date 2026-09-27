import { describe, expect, test } from 'bun:test';
import type { IdentityPublic, ProfileRecord, ProfileRival } from '@cs/shared/protocol';
import { displayName, gameName, matchEndingText, recordScoreText, recordShares, recordSummaryLine, resultChip, rivalrySentence } from './profile';

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

describe('recordShares', () => {
  test('wins, draws and losses each as a share (0–100) of played matches', () => {
    expect(recordShares(record({ wins: 2, draws: 1, losses: 1, played: 4 }))).toEqual({ wins: 50, draws: 25, losses: 25 });
    expect(recordShares(record({ wins: 0, draws: 0, losses: 4, played: 4 }))).toEqual({ wins: 0, draws: 0, losses: 100 });
  });
  test('all zero with nothing played, not NaN', () => {
    expect(recordShares(record({}))).toEqual({ wins: 0, draws: 0, losses: 0 });
  });
});

describe('recordScoreText', () => {
  test('an accessible reading of the score, singular/plural, draws only when there are any', () => {
    expect(recordScoreText(record({ wins: 2, losses: 1, draws: 0 }))).toBe('2 wins, 1 loss');
    expect(recordScoreText(record({ wins: 1, losses: 1, draws: 0 }))).toBe('1 win, 1 loss');
    expect(recordScoreText(record({ wins: 2, losses: 1, draws: 3 }))).toBe('2 wins, 1 loss, 3 draws');
    expect(recordScoreText(record({ wins: 0, losses: 0, draws: 1 }))).toBe('0 wins, 0 losses, 1 draw');
  });
});

describe('rivalrySentence', () => {
  const opponent = who({ id: 'id_2', handle: 'OLD_IRON', kind: 'agent' });
  const rival = (over: Partial<ProfileRival>): ProfileRival => ({ opponent, wins: 0, losses: 0, draws: 0, ...over });

  test('the owner ahead, viewed by the owner, reads "You\'re" and names the rival', () => {
    expect(rivalrySentence(rival({ wins: 3, losses: 1 }), { mine: true, ownerHandle: 'Ada' })).toBe("You're up 3–1 on OLD_IRON.");
  });
  test('the owner ahead, viewed by a visitor, uses the owner\'s handle and names the rival', () => {
    expect(rivalrySentence(rival({ wins: 3, losses: 1 }), { mine: false, ownerHandle: 'Ada' })).toBe('Ada is up 3–1 on OLD_IRON.');
  });
  test('the rival ahead names the rival, regardless of viewer', () => {
    expect(rivalrySentence(rival({ wins: 0, losses: 4 }), { mine: true, ownerHandle: 'Ada' })).toBe('OLD_IRON is up 4–0.');
    expect(rivalrySentence(rival({ wins: 0, losses: 4 }), { mine: false, ownerHandle: 'Ada' })).toBe('OLD_IRON is up 4–0.');
  });
  test('a released rival ahead is named capitalised, sentence-initial', () => {
    const released = who({ id: 'id_3', handle: '~id_3', kind: 'agent', released: true });
    expect(rivalrySentence({ opponent: released, wins: 0, losses: 4, draws: 0 }, { mine: true, ownerHandle: 'Ada' })).toBe(
      'A former player is up 4–0.',
    );
  });
  test('level is "all square", not "up 0"', () => {
    expect(rivalrySentence(rival({ wins: 2, losses: 2 }), { mine: true, ownerHandle: 'Ada' })).toBe('All square at 2–2.');
  });
  test('a draws-only rivalry reads as draws, not "0–0"', () => {
    expect(rivalrySentence(rival({ wins: 0, losses: 0, draws: 3 }), { mine: true, ownerHandle: 'Ada' })).toBe('All square — 3 draws.');
    expect(rivalrySentence(rival({ wins: 0, losses: 0, draws: 1 }), { mine: true, ownerHandle: 'Ada' })).toBe('All square — 1 draw.');
  });
});

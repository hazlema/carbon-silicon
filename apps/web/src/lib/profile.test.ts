import { describe, expect, test } from 'bun:test';
import type { IdentityPublic } from '@cs/shared/protocol';
import { displayName, gameName, resultChip } from './profile';

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

import { describe, expect, test } from 'bun:test';
import { linesFor, NEUTRAL_FORBIDDEN, type Personality } from './personality';
import { oldIron } from './personalities/old-iron';
import { sprocket } from './personalities/sprocket';
import { gameOver } from './personalities/game-over';

const ALL: Personality[] = [sprocket, oldIron, gameOver];

describe('linesFor', () => {
  const p: Personality = {
    ...sprocket,
    lines: { ...sprocket.lines, hello: ['neutral hi'], win: ['neutral win'] },
    byGame: { checkers: { hello: ['knight hi'] }, lightline: { hello: [] } },
  };
  test("a table moment takes its game's bank", () => expect(linesFor(p, 'hello', 'checkers')).toEqual(['knight hi']));
  test('a kind the game bank lacks falls back to neutral', () => expect(linesFor(p, 'win', 'checkers')).toEqual(['neutral win']));
  test('an empty game list falls back to neutral', () => expect(linesFor(p, 'hello', 'lightline')).toEqual(['neutral hi']));
  test('a game with no bank at all (a future game) uses neutral', () => expect(linesFor(p, 'hello', 'tetrominoes')).toEqual(['neutral hi']));
  test('no game (lobby, DMs) uses neutral', () => expect(linesFor(p, 'hello')).toEqual(['neutral hi']));
});

describe('every resident', () => {
  for (const p of ALL) {
    test(`${p.name}: neutral lines stay game-free`, () => {
      for (const [kind, list] of Object.entries(p.lines)) for (const l of list ?? []) expect(`${kind}: ${l}`).not.toMatch(NEUTRAL_FORBIDDEN);
    });
    test(`${p.name}: has neutral lines for every everyday moment`, () => {
      for (const kind of ['hello', 'win', 'lose', 'draw', 'mentioned', 'busy'] as const) expect((p.lines[kind] ?? []).length).toBeGreaterThan(0);
    });
    test(`${p.name}: hello/win/lose/draw for every game`, () => {
      for (const game of ['critical-mass', 'lightline', 'checkers']) {
        for (const kind of ['hello', 'win', 'lose', 'draw'] as const) expect(linesFor(p, kind, game).length).toBeGreaterThan(0);
      }
      for (const kind of ['hello', 'win', 'lose'] as const) {
        expect((p.byGame?.lightline?.[kind] ?? []).length).toBeGreaterThanOrEqual(3);
        expect((p.byGame?.checkers?.[kind] ?? []).length).toBeGreaterThanOrEqual(3);
      }
    });
    test(`${p.name}: Critical Mass keeps its cascade lines`, () => {
      expect(linesFor(p, 'bigCascade', 'critical-mass').length).toBeGreaterThan(0);
      expect(linesFor(p, 'gotHit', 'critical-mass').length).toBeGreaterThan(0);
    });
  }
});

test('GAME_OVER keeps out of the lobby: no ambient lines, no unprompted answers, lowercase', () => {
  expect(gameOver.lines.ambient).toEqual([]);
  expect(gameOver.lines.unanswered).toBeUndefined();
  expect(gameOver.shout).toBeFalsy();
  for (const list of [...Object.values(gameOver.lines), ...Object.values(gameOver.byGame ?? {}).flatMap((b) => Object.values(b ?? {}))])
    for (const l of list ?? []) expect(l).toBe(l.toLowerCase());
});

test('no canned line borrows a sexual euphemism (house rules: nothing sexual)', () => {
  const crossing = /\b(little deaths?|petite mort)\b/i;
  for (const p of ALL)
    for (const bank of [p.lines, ...Object.values(p.byGame ?? {})])
      for (const list of Object.values(bank ?? {})) for (const l of list ?? []) expect(l).not.toMatch(crossing);
});

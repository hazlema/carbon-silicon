import { describe, expect, test } from 'bun:test';
import type { GameInfo } from '@cs/shared/protocol';
import { playable, randomGame, remembered } from './play';

const game = (id: string, humans = true): GameInfo => ({
  id, name: id, tagline: '', mode: 'turn', minPlayers: 2, maxPlayers: 4, seats: [], humans, thumbnail: null,
});
const cm = game('critical-mass');
const ll = game('lightline', false);
const go = game('go');

describe('the Play panel', () => {
  test('people play only the games humans may play', () => {
    expect(playable([cm, ll, go])).toEqual([cm, go]);
    expect(playable([ll])).toEqual([]);
  });
  test('a random match picks among the playable games, or none', () => {
    expect(randomGame([cm, ll, go], () => 0)).toBe(cm);
    expect(randomGame([cm, ll, go], () => 0.99)).toBe(go);
    expect(randomGame([ll], () => 0)).toBeNull();
  });
  test('the remembered pick comes back only while it is still playable', () => {
    expect(remembered([cm, ll, go], 'go')).toBe(go);
    expect(remembered([cm, ll, go], 'lightline')).toBeNull();
    expect(remembered([cm, ll, go], 'chess')).toBeNull();
    expect(remembered([cm, ll, go], null)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { TableGames } from './table-games';

describe('TableGames', () => {
  test('knows the game at a table while a match there is live', () => {
    const t = new TableGames();
    t.start('m1', 'table:t1', 'checkers');
    expect(t.gameOf('table:t1')).toBe('checkers');
    t.end('m1');
    expect(t.gameOf('table:t1')).toBeUndefined();
  });
  test('a rematch at the same table keeps its game when the first match finishes winding down after it started', () => {
    const t = new TableGames();
    t.start('m1', 'table:t1', 'checkers');
    t.start('m2', 'table:t1', 'checkers'); // the rematch starts while m1 is still saying goodbye
    t.end('m1');
    expect(t.gameOf('table:t1')).toBe('checkers');
  });
  test('a table that switches games mid-rematch reports the live one', () => {
    const t = new TableGames();
    t.start('m1', 'table:t1', 'checkers');
    t.start('m2', 'table:t1', 'critical-mass');
    t.end('m1');
    expect(t.gameOf('table:t1')).toBe('critical-mass');
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../db';
import { matches, matchPlayers } from '../db/schema';
import { FakeClock } from '../lib/clock';
import { newId } from '../lib/ids';
import { IdentityManager } from './identity';
import { LeaderboardManager } from './leaderboard';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

describe('tally', () => {
  test('counts finished human-vs-agent matches in the season only', async () => {
    const ids = new IdentityManager(database.db, new FakeClock(), { houseKey: null });
    const h = (await ids.createHuman('Carbonara')).identity;
    const a = (await ids.registerAgent({ name: 'Siliconda' }, null)).identity;
    const a2 = (await ids.registerAgent({ name: 'Siliconte' }, null)).identity;
    type R = 'win' | 'loss' | 'draw' | 'abandoned';
    async function match(season: string, status: 'over' | 'abandoned', players: [typeof h, R][]) {
      const id = newId('m');
      await database.db.insert(matches).values({ id, gameId: 'critical-mass', status, seed: 1, season });
      await database.db.insert(matchPlayers).values(
        players.map(([p, result], i) => ({ matchId: id, seat: `s${i}`, identityId: p.id, kind: p.kind, result })),
      );
    }
    await match('2030-01', 'over', [[h, 'win'], [a, 'loss']]); // carbon
    await match('2030-01', 'over', [[h, 'loss'], [a, 'win']]); // silicon
    await match('2030-01', 'over', [[h, 'draw'], [a, 'draw']]); // draw
    await match('2030-01', 'over', [[a, 'win'], [a2, 'loss']]); // machine vs machine: ignored
    await match('2030-01', 'abandoned', [[h, 'abandoned'], [a, 'abandoned']]); // ignored
    await match('2030-02', 'over', [[h, 'win'], [a, 'loss']]); // other season
    const board = new LeaderboardManager(database.db);
    expect(await board.tally('2030-01')).toEqual({ season: '2030-01', carbon: 1, silicon: 1, draws: 1 });
    expect(await board.tally('2029-12')).toEqual({ season: '2029-12', carbon: 0, silicon: 0, draws: 0 });
  });
});

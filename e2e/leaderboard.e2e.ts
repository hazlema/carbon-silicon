import { expect, test, type APIRequestContext } from '@playwright/test';
import { enter, randomTag } from './testing';

async function agent(request: APIRequestContext) {
  const r = await request.post('/api/agents', { data: { name: `lb${randomTag()}` } });
  expect(r.status()).toBe(201);
  const { token, identity } = await r.json();
  return { auth: { authorization: `Bearer ${token}` }, handle: identity.handle as string };
}

/** Both queue for Critical Mass; once seated, `loser` resigns. */
async function playOnce(request: APIRequestContext, winner: { auth: Record<string, string> }, loser: { auth: Record<string, string> }) {
  await request.post('/api/quickmatch', { headers: winner.auth, data: { gameId: 'critical-mass' } });
  await request.post('/api/quickmatch', { headers: loser.auth, data: { gameId: 'critical-mass' } });
  let matchId: string | null = null;
  for (let i = 0; i < 100 && !matchId; i++) {
    matchId = (await (await request.get('/api/me', { headers: loser.auth })).json()).activeMatch;
    if (!matchId) await new Promise((r) => setTimeout(r, 100));
  }
  expect(matchId).toBeTruthy();
  const r = await request.post(`/api/matches/${matchId}/resign`, { headers: loser.auth });
  expect(r.status()).toBe(200);
}

test('after three practice games, a win puts an agent at the top of the board', async ({ page, request }) => {
  const a = await agent(request);
  const b = await agent(request);
  for (let i = 0; i < 4; i++) await playOnce(request, a, b);
  const board = await (await request.get('/api/leaderboard?game=critical-mass')).json();
  const mine = board.rows.filter((r: { identity: { handle: string } }) => [a.handle, b.handle].includes(r.identity.handle));
  expect(mine.map((r: { identity: { handle: string }; points: number; games: number }) => [r.identity.handle, r.points, r.games])).toEqual([
    [a.handle, 3, 1],
    [b.handle, 0, 1],
  ]);

  await enter(page, `lbv${randomTag()}`);
  await page.goto('/leaderboard');
  await page.getByRole('tab', { name: 'Critical Mass' }).click();
  const row = page.getByRole('table', { name: 'Standings' }).getByRole('row', { name: new RegExp(a.handle) });
  await expect(row).toBeVisible();
  await expect(row.locator('.pts')).toHaveText('3');
});

test('the leaderboard fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto('/leaderboard');
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hall of fame' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

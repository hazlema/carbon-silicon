import { expect, test, type APIRequestContext } from '@playwright/test';
import { enter, lock, newPlayer, PASSWORD, randomTag } from './testing';

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
  expect(
    await page.evaluate(() => {
      const g = globalThis as any;
      return g.document.documentElement.scrollWidth <= g.window.innerWidth;
    }),
  ).toBe(true);
});

test('a new locked player sees their first week on the profile and can go ranked now', async ({ browser }) => {
  const p = await newPlayer(browser);
  const name = `rk${randomTag()}`;
  await enter(p, name);
  await lock(p, PASSWORD);
  await p.goto(`/u/${name}`);
  await expect(p.getByText('Standing: Unranked games · 7 days remaining')).toBeVisible();
  await p.getByRole('button', { name: 'Go ranked now' }).click();
  await expect(p.getByText("Go ranked now? Every game you play from now on counts. This can't be undone.")).toBeVisible();
  await p.getByRole('button', { name: 'Not yet' }).click();
  await expect(p.getByText('Standing: Unranked games · 7 days remaining')).toBeVisible();
  await p.getByRole('button', { name: 'Go ranked now' }).click();
  await p.getByRole('button', { name: 'Go ranked', exact: true }).click();
  await expect(p.getByText('Standing: All games are ranked')).toBeVisible();
  await p.reload();
  await expect(p.getByText('Standing: All games are ranked')).toBeVisible();
  await expect(p.getByRole('button', { name: 'Go ranked now' })).toHaveCount(0);
  await expect(p.getByText('0 matches played')).toBeVisible();
});

test('a guest’s profile says how to get ranked', async ({ browser }) => {
  const p = await newPlayer(browser);
  const name = `gs${randomTag()}`;
  await enter(p, name);
  await p.goto(`/u/${name}`);
  await expect(p.getByText('Standing: Unranked · lock your name to be ranked')).toBeVisible();
});

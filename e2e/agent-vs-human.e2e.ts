import { expect, test } from '@playwright/test';

test('an HTTP-only agent and a browser human play each other and talk', async ({ page, request }) => {
  const reg = await request.post('/api/agents', { data: { name: `curl${Math.random().toString(36).slice(2, 7)}` } });
  expect(reg.status()).toBe(201);
  const { token, identity } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };

  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${Math.random().toString(36).slice(2, 8)}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(page.getByRole('region', { name: /Here now/ })).toBeVisible();

  expect((await (await request.post('/api/quickmatch', { headers: auth, data: { gameId: 'critical-mass' } })).json()).status).toBe('queued');
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/play\/m_/, { timeout: 20_000 });
  const matchId = page.url().split('/').pop()!;
  await expect(page.getByText(identity.handle).first()).toBeVisible();

  await request.post(`/api/chat/match:${matchId}`, { headers: auth, data: { text: 'Your move, carbon.' } });
  await expect(page.getByRole('log').getByText('Your move, carbon.')).toBeVisible();

  // The agent plays in the background over plain HTTP while the human clicks.
  let done = false;
  const agentLoop = (async () => {
    while (!done) {
      const env = await (await request.get(`/api/matches/${matchId}`, { headers: auth })).json();
      if (env.match.status === 'over') break;
      if (env.match.status === 'live' && env.legal.length > 0) {
        await request.post(`/api/matches/${matchId}/move`, { headers: auth, data: { revision: env.match.revision, cell: env.legal[0].cell } });
      } else {
        await request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=2000`, { headers: auth });
      }
    }
  })();

  const verdict = page.getByRole('heading', { name: /^(You win\.|You lose\.|Draw\.)$/ });
  for (let i = 0; i < 400 && !(await verdict.isVisible()); i++) {
    try {
      await page.locator('button[data-legal="true"]').first().click({ timeout: 3000 });
    } catch {}
  }
  done = true;
  await agentLoop;
  await expect(verdict).toBeVisible();
});

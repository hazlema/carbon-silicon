import { expect, test } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

test('an exhibition of Lightline plays on the board for anyone to watch, fired rules and all', async ({ browser, request }) => {
  // The table pushes live only to a signed-in socket, so the watcher takes a guest name first.
  const page = await newPlayer(browser);
  await enter(page, `llw${randomTag()}`);
  // A second house resident for the exhibition, beside the server's Sprocket. It sends no doctrine,
  // so it rides the game's default.
  const reg = await request.post('/api/agents', { data: { name: `ll${randomTag()}` }, headers: { 'x-house-key': 'e2e-house' } });
  expect(reg.status()).toBe(201);
  const { token } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  await request.patch('/api/me', { data: { status: 'ready' }, headers: auth });
  let matchId: string | null = null;
  try {
    const ex = await request.post('/api/console/exhibition', { data: { handle: 'lightline' }, headers: { 'x-admin-key': 'e2e-admin' } });
    expect(ex.status()).toBe(200);
    const { match } = await ex.json();
    matchId = match.id;
    await page.goto(`/t/${match.tableId}`);
    await expect(page.getByRole('heading', { name: 'Lightline' })).toBeVisible();
    await expect(page.getByRole('img', { name: /Lightline arena, round 1/ })).toBeVisible();
    const clock = page.getByTestId('ll-clock');
    await expect(clock).toContainText('round 1');
    const first = await clock.textContent();
    await expect.poll(async () => clock.textContent(), { timeout: 5000 }).not.toBe(first);
    // The house bot without a doctrine rides the default; its rule shows under the board.
    await expect(page.getByText('cruise').first()).toBeVisible({ timeout: 5000 });
  } finally {
    // Free Sprocket for the tests after this one: the default rider resigns, which ends a 2-player match.
    if (matchId) await request.post(`/api/matches/${matchId}/resign`, { headers: auth });
    await request.patch('/api/me', { data: { status: 'afk' }, headers: auth });
  }
});

test('the lobby tells a human that Lightline is machines only', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`llh${randomTag()}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await page.getByLabel('Game').selectOption('lightline');
  await expect(page.getByText('Lightline is machines only for now.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find a match' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Vs house' })).toBeDisabled();
});

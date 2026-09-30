import { expect, test } from '@playwright/test';
import { enter, newPlayer, randomIp, randomTag } from './testing';

test('an exhibition of Lightline plays on the board for anyone to watch, fired rules and all', async ({ browser, request }) => {
  // A guest who never picks a name: no socket, so the board follows by long-poll.
  const page = await newPlayer(browser);
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
    await expect(page).toHaveTitle('Lightline');
    await expect(page.getByRole('img', { name: /Lightline arena, round 1/ })).toBeVisible();
    const clock = page.getByTestId('ll-clock');
    await expect(clock).toContainText('round 1');
    const first = await clock.textContent();
    await expect.poll(async () => clock.textContent(), { timeout: 5000 }).not.toBe(first);
    // The house bot without a doctrine rides the default; its rule shows under the board.
    await expect(page.getByText('cruise').first()).toBeVisible({ timeout: 5000 });
    // The default rider resigns, which ends a 2-player match by forfeit, and frees Sprocket for the tests after this one.
    expect((await request.post(`/api/matches/${matchId}/resign`, { headers: auth })).status()).toBe(200);
    matchId = null;
    await expect(page.getByRole('dialog').getByText('By forfeit: everyone else resigned.')).toBeVisible();
  } finally {
    // If the test failed before its resign, still free Sprocket.
    if (matchId) await request.post(`/api/matches/${matchId}/resign`, { headers: auth });
    await request.patch('/api/me', { data: { status: 'afk' }, headers: auth });
  }
});

test('a human can pick Lightline in the chooser', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`llh${randomTag()}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await page.getByRole('button', { name: 'Select game' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose a game' });
  await expect(chooser.getByText('Machines only for now', { exact: false })).toHaveCount(0);
  await expect(chooser.getByRole('button', { name: 'Select Lightline' })).toBeEnabled();
  await chooser.getByRole('button', { name: 'Select Lightline' }).click();
  await expect(page.getByRole('region', { name: 'Play' }).getByRole('heading', { name: 'Lightline' })).toBeVisible();
});

test('a human can sit at an open Lightline table', async ({ browser, request }) => {
  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `llt${randomTag()}` } });
  expect(reg.status()).toBe(201);
  const { token } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  await request.patch('/api/me', { data: { status: 'ready' }, headers: auth });
  const made = await request.post('/api/tables', { data: { gameId: 'lightline', open: true }, headers: auth });
  expect(made.status()).toBe(201);
  const { table } = await made.json();
  try {
    const page = await newPlayer(browser);
    await enter(page, `lls${randomTag()}`);
    const row = page.getByRole('region', { name: 'Tables' }).getByRole('listitem').filter({ hasText: table.host.handle });
    const sit = row.getByRole('button', { name: 'Sit' });
    await expect(sit).toBeEnabled();
    await sit.click();
    // Seated: the row leaves the open list and the Play panel shows the gathering, with Leave.
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible();
  } finally {
    await request.delete(`/api/tables/${table.id}`, { headers: auth });
  }
});

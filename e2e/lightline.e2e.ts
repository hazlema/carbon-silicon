import { expect, test } from '@playwright/test';
import { enter, newPlayer, pickGame, randomIp, randomTag } from './testing';

test('an exhibition of Lightline plays on the board for anyone to watch, fired rules and all', async ({ browser, request }) => {
  // A guest who never picks a name: no socket, so the board follows by short-poll.
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
    const row = page.getByRole('region', { name: 'Current games' }).getByRole('listitem').filter({ hasText: table.host.handle });
    const sit = row.getByRole('button', { name: /^Sit at Lightline/ });
    await expect(sit).toBeEnabled();
    await expect(sit).toContainText('house bots fill the rest at Start');
    await sit.click();
    // Seated: the row becomes your table (nothing to click) and the Play panel shows the gathering, with Leave.
    await expect(row).toContainText('your table');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible();
  } finally {
    await request.delete(`/api/tables/${table.id}`, { headers: auth });
  }
});

test('a human hosts Lightline against Sprocket, steers with the keys, and resigns', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `llk${randomTag()}`);
  const made = await page.request.post('/api/vs-house', { data: { gameId: 'lightline' } });
  expect(made.status()).toBe(201);
  const { table } = await made.json();
  await expect.poll(async () => (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.seated.length, { timeout: 10_000 }).toBe(2);
  // Open the table page first and start from the API, so the 1 s countdown (and its hint) happens on screen.
  await page.goto(`/t/${table.id}`);
  expect((await page.request.post(`/api/tables/${table.id}/start`)).status()).toBe(200);
  await expect(page.getByTestId('steer-hint')).toHaveText('Arrows or WASD to steer · Space to boost');
  const matchId = (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.matchId;
  const heading = async () => {
    const env = await (await page.request.get(`/api/matches/${matchId}`)).json();
    return env.view.cycles.find((c: { seat: string }) => c.seat === env.you).heading;
  };
  await expect(page.getByTestId('ll-clock')).toContainText('round 1', { timeout: 5000 });
  await expect.poll(async () => (await (await page.request.get(`/api/matches/${matchId}`)).json()).match.status).toBe('live');
  await page.keyboard.press('ArrowUp');
  await expect.poll(heading, { timeout: 2000 }).toBe('n');
  await expect(page.getByText('steering')).toBeVisible();
  // Typing in the table chat is not steering.
  await page.getByPlaceholder('Talk trash, play fair').fill('');
  await page.getByPlaceholder('Talk trash, play fair').press('KeyD');
  await expect(page.getByPlaceholder('Talk trash, play fair')).toHaveValue('d');
  await page.waitForTimeout(300);
  expect(await heading()).not.toBe('e');
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('dialog').getByText('By forfeit: everyone else resigned.')).toBeVisible();
});

test('a reply typed in the countdown does not keep the arrow keys from steering', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `llc${randomTag()}`);
  const { table } = await (await page.request.post('/api/vs-house', { data: { gameId: 'lightline' } })).json();
  await expect.poll(async () => (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.seated.length, { timeout: 10_000 }).toBe(2);
  await page.goto(`/t/${table.id}`);
  // The table chat appears with the match: reply during the countdown, so focus stays in the composer.
  expect((await page.request.post(`/api/tables/${table.id}/start`)).status()).toBe(200);
  const composer = page.getByPlaceholder('Talk trash, play fair');
  await composer.fill('Talk trash, play fair');
  await composer.press('Enter');
  const matchId = (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.matchId;
  await expect.poll(async () => (await (await page.request.get(`/api/matches/${matchId}`)).json()).match.status).toBe('live');
  // Mid-round, the chat still takes a whole line: typed across several frames, nothing is lost to a blur.
  await composer.click();
  await composer.pressSequentially('gg ez', { delay: 60 });
  await expect(composer).toHaveValue('gg ez');
  // Esc hands the keys back to the board.
  await composer.press('Escape');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => {
    const env = await (await page.request.get(`/api/matches/${matchId}`)).json();
    return env.view.cycles.find((c: { seat: string }) => c.seat === env.you).heading;
  }, { timeout: 2000 }).toBe('n');
  await page.request.post(`/api/matches/${matchId}/resign`);
});

test('at 400 px a swipe on the arena turns the cycle', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 400, height: 860 });
  await enter(page, `lls${randomTag()}`);
  const { table } = await (await page.request.post('/api/vs-house', { data: { gameId: 'lightline' } })).json();
  await expect.poll(async () => (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.seated.length, { timeout: 10_000 }).toBe(2);
  await page.request.post(`/api/tables/${table.id}/start`);
  await page.goto(`/t/${table.id}`);
  const matchId = (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.matchId;
  await expect.poll(async () => (await (await page.request.get(`/api/matches/${matchId}`)).json()).match.status).toBe('live');
  const box = (await page.locator('.arena canvas').boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const mine = async () => {
    const env = await (await page.request.get(`/api/matches/${matchId}`)).json();
    return env.view.cycles.find((c: { seat: string }) => c.seat === env.you);
  };
  const boosts0 = (await mine()).boosts;
  // Two thumbs: finger A swipes down while finger B taps for a boost, interleaved.
  const canvas = page.locator('.arena canvas');
  const touch = (type: string, id: number, x: number, y: number) => canvas.dispatchEvent(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, isPrimary: id === 1 });
  await touch('pointerdown', 1, at.x, at.y);
  await touch('pointerdown', 2, at.x + 40, at.y);
  await touch('pointerup', 2, at.x + 41, at.y);
  await touch('pointerup', 1, at.x, at.y + 60);
  await expect.poll(async () => (await mine()).boosts, { timeout: 2000 }).toBeLessThan(boosts0);
  await expect.poll(async () => {
    const env = await (await page.request.get(`/api/matches/${matchId}`)).json();
    return env.view.cycles.find((c: { seat: string }) => c.seat === env.you).heading;
  }, { timeout: 2000 }).toBe('s');
  expect(
    await page.evaluate(() => {
      const g = globalThis as any;
      return g.document.documentElement.scrollWidth <= g.window.innerWidth;
    }),
  ).toBe(true);
  await page.request.post(`/api/matches/${matchId}/resign`);
});

test('hosting Lightline alone: the card says the seats fill with house bots, and Start works with just you', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `fill${randomTag()}`);
  await pickGame(page, 'Lightline');
  await page.getByRole('button', { name: 'Host a table' }).click();
  await expect(page.getByText('Empty seats fill with house bots when you start.')).toBeVisible();
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled();
  await start.click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  const tableId = page.url().split('/t/')[1];
  const seated = (await (await page.request.get(`/api/tables/${tableId}`)).json()).table.lastPlayers ?? [];
  expect(seated.some((p: { handle: string }) => p.handle === 'Sprocket')).toBe(true);
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

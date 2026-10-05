import { expect, test } from '@playwright/test';
import { enter, newPlayer, pickGame, randomTag } from './testing';

type Envelope = {
  you: string | null;
  match: { status: string; seats: { seat: string; identity: { handle: string } }[] };
  view: { round: number; phase: string; lastVolley: { round: number; shells: { from: string; sea: string; cell: string; result: string }[] } | null };
};

test('Salvo: a human deploys at random, fires at a real cell, and the volley carries that shell', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await enter(page, `salvo${randomTag()}`);
  await pickGame(page, 'Salvo');
  await page.getByRole('button', { name: 'Host a table' }).click();
  // Salvo seats free house machines at Start: in the e2e house, that's Sprocket.
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled({ timeout: 10_000 });
  await start.click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });

  const tableId = page.url().split('/t/')[1];
  let matchId = '';
  await expect
    .poll(async () => (matchId = (await (await page.request.get(`/api/tables/${tableId}`)).json()).table.matchId ?? ''), { timeout: 10_000 })
    .not.toBe('');
  const envelope = async (): Promise<Envelope> => (await page.request.get(`/api/matches/${matchId}`)).json();
  const first = await envelope();
  const me = first.you!;
  const sprocket = first.match.seats.find((s) => s.identity.handle === 'Sprocket')?.seat;
  expect(sprocket, 'Sprocket takes the other seat').toBeTruthy();

  // Deployment: Random places the whole fleet. Sprocket may commit in the same instant; a stale revision
  // only means the page refetches, so press again until the fleet is down.
  await expect(page.getByText('Place your fleet')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sv-round')).toHaveText('deploying');
  const random = page.getByTestId('random');
  await expect(async () => {
    if ((await random.count()) > 0 && (await random.isEnabled())) await random.click();
    await expect(page.getByText('Round 1: pick a cell and fire')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId('sv-round')).toHaveText('round 1');
  // Your own fleet is on your sea: twelve ship cells.
  await expect(page.locator(`[data-sea="${me}"] [data-mark="ship"]`)).toHaveCount(12);

  // Sprocket commits within a blink; once its chip says ready, the human's shot resolves the round.
  await expect(page.locator(`.chip[data-seat="${sprocket}"]`)).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
  const sea = page.locator('[data-main]');
  await expect(sea).toHaveAttribute('data-sea', sprocket!);
  const cell = sea.locator('[data-cell="e5"]');
  await expect(cell).toHaveAttribute('aria-disabled', 'false');
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('fire')).toHaveText('Fire at e5');
  await page.getByTestId('fire').click();

  // The resolved volley, read back from the server, holds that shell from that seat.
  await expect
    .poll(async () => (await envelope()).view.lastVolley?.round ?? 0, { timeout: 10_000 })
    .toBe(1);
  const volley = (await envelope()).view.lastVolley!;
  expect(volley.shells).toContainEqual(expect.objectContaining({ from: me, sea: sprocket, cell: 'e5' }));
  expect(volley.shells).toContainEqual(expect.objectContaining({ from: sprocket, sea: me }));
  await expect(page.getByTestId('sv-round')).toHaveText('round 2');
  await expect(cell).toHaveAttribute('aria-label', /^e5, (miss|hit|sunk \w+)$/);
  await expect(cell).toHaveAttribute('aria-disabled', 'true');

  // A phone: the board fits, nothing scrolls sideways, and the target sea's cells are big enough to tap.
  await page.setViewportSize({ width: 400, height: 860 });
  await expect(page.locator('[data-main]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await page.locator('[data-main] [data-cell="a1"]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(42);
  const { scroll, inner } = await page.evaluate(() => {
    const g = globalThis as any;
    return { scroll: g.document.documentElement.scrollWidth as number, inner: g.innerWidth as number };
  });
  expect(scroll, 'nothing scrolls sideways').toBeLessThanOrEqual(inner);
  const box = (await page.locator('[data-main]').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(400);
  await expect(page.getByTestId('fire')).toBeInViewport();

  // Free the house: a live match would keep Sprocket booked for the rest of the suite.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('heading', { name: 'You lose.' })).toBeVisible({ timeout: 10_000 });
});

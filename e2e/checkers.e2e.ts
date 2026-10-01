import { expect, test, type Page } from '@playwright/test';
import { enter, newPlayer, pickGame, randomTag } from './testing';

/**
 * The battlefield is a WebGL canvas: squares have no DOM handles, so the test sweeps
 * real mouse clicks across the board and reads the turn banner (Playwright pierces the
 * board's shadow root) to know what it hit.
 */
async function sweep(page: Page, done: () => Promise<boolean>): Promise<boolean> {
  const canvas = page.locator('#battlefield canvas');
  const box = (await canvas.boundingBox())!;
  for (let gy = 2; gy < 22; gy += 1) {
    for (let gx = 2; gx < 30; gx += 1) {
      await page.mouse.click(box.x + (gx * box.width) / 32, box.y + (gy * box.height) / 24);
      if (await done()) return true;
    }
  }
  return false;
}

test('Crown & Steel: clicking a knight and then a gold square submits the march', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `crown${randomTag()}`);
  await pickGame(page, 'Crown & Steel');
  await page.getByRole('button', { name: 'Host a table' }).click();
  await expect(page.getByText('Click a name to invite them.')).toBeVisible();
  const here = page.getByRole('region', { name: /Here now/ });
  await here.getByRole('button', { name: /Sprocket/ }).click();
  await page.getByRole('menuitem', { name: 'Invite to Crown & Steel' }).click();
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled({ timeout: 10_000 });
  await start.click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });

  // The host is red and moves first, once the countdown ends.
  const help = page.locator('#turn-help');
  await expect(help).toHaveText(/Select a knight/, { timeout: 30_000 });

  // First sweep: select any knight that can march.
  const selected = await sweep(page, async () => /selected/i.test((await help.textContent()) ?? ''));
  expect(selected, 'a knight should be selectable by clicking it').toBe(true);

  // Second sweep: hit one of its gold destinations; the whole turn posts and the history grows.
  const history = page.locator('#history-count');
  const grew = async () => {
    const t = await history.textContent();
    return !!t && /move/.test(t) && !/^0 moves/.test(t);
  };
  const marched = await sweep(page, grew);
  expect(marched, 'clicking a gold square should submit the move').toBe(true);

  // Free the house: a live match would keep Sprocket booked for the rest of the suite.
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('button', { name: 'Rematch' })).toBeVisible({ timeout: 10_000 });
});

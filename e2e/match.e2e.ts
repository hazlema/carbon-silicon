import { expect, test } from '@playwright/test';
import { enter, newPlayer, pickGame, randomTag } from './testing';

test('quick match seats a human against Sprocket and the game plays to a verdict', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${randomTag()}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await pickGame(page);
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  await expect(page.getByText('Sprocket').first()).toBeVisible();

  const verdict = page.getByRole('heading', { name: /^(You win\.|You lose\.|Draw\.)$/ });
  for (let i = 0; i < 400; i++) {
    if (await verdict.isVisible()) break;
    const cell = page.locator('button[data-legal="true"]').first();
    try {
      await cell.click({ timeout: 3000 });
    } catch {
      // not our turn yet
    }
  }
  await expect(verdict).toBeVisible();
  await expect(page.getByRole('log').filter({ hasText: /wins|Draw/ }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Back to the lobby' }).click();
  await expect(page).toHaveURL('/');
});

test('changing your mind after "Play again" does not start another match behind your back', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${randomTag()}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await pickGame(page);
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  // Scoped to the table: the page's own live-region wrapper (UpdateBanner, always in the DOM) is a
  // second role="status" element now, so an unscoped getByRole('status') would be ambiguous.
  await expect(page.getByRole('region', { name: 'Critical Mass' }).getByRole('status')).not.toHaveText('Starting…');

  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('heading', { name: 'You lose.' })).toBeVisible();

  await page.getByRole('button', { name: 'Find a match' }).click();
  // The dialog says a search is on, and offers a way out.
  await expect(page.getByRole('dialog').getByText(/Looking for an opponent/)).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Stop looking' })).toBeVisible();

  // Leaving the table calls the search off; the e2e house fallback is 3 s.
  await page.getByRole('link', { name: 'Back to the lobby' }).click();
  await expect(page).toHaveURL('/');
  await page.waitForTimeout(4500);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: 'Find a match' })).toBeVisible();
});

test('keyboard players can reach every cell, and only legal cells act', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${randomTag()}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await pickGame(page);
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  const cells = page.locator('button[data-cell]');
  await expect(cells).toHaveCount(54);
  await expect(page.locator('button[data-cell][disabled]')).toHaveCount(0);
  await cells.first().focus();
  await expect(cells.first()).toHaveAttribute('data-cell', 'a9');
  // The e2e tsconfig has no DOM lib, so `document`/`HTMLElement` aren't ambient names here;
  // route through `globalThis` to keep the check without widening the project's lib globally.
  const focusedCell = () => page.evaluate(() => (globalThis as any).document.activeElement.dataset.cell);
  await page.keyboard.press('ArrowRight');
  expect(await focusedCell()).toBe('b9');
  await page.keyboard.press('ArrowDown');
  expect(await focusedCell()).toBe('b8');
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
});

test('a spectator lands on the rail, and the player sees it only by switching tabs', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${randomTag()}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await pickGame(page);
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  const tableUrl = page.url();

  const fan = await newPlayer(browser);
  await enter(fan, `fan${randomTag()}`);
  await fan.goto(tableUrl);
  await expect(fan.getByRole('tab', { name: /Rail/ })).toHaveAttribute('aria-selected', 'true');
  await fan.getByPlaceholder('Cheer, heckle, speculate').fill('go carbon');
  await fan.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText(/Watching: 1/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Rail (1)' })).toBeVisible();
  await expect(page.getByRole('log').getByText('go carbon')).toHaveCount(0);
  await page.getByRole('tab', { name: /Rail/ }).click();
  await expect(page.getByRole('log').getByText('go carbon')).toBeVisible();
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('button', { name: 'Rematch' })).toBeVisible();

  // Calling a rematch does not touch the finished match's id (the table only points at a new one
  // once the host starts it), so the old verdict must still be showing right after the click —
  // this is the flip side of the fix in +page.svelte's match effect: it must reset `env` only
  // when the table's matchId actually changes, never just because the table itself changed.
  await page.getByRole('button', { name: 'Rematch' }).click();
  await expect(page.getByRole('heading', { name: 'You lose.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rematch' })).toHaveCount(0);
  // Clear the gathering rematch: a house bot seated at a table declines every other invite, so
  // leaving Sprocket sat here would turn later tests' invites down.
  const tableId = new URL(tableUrl).pathname.split('/').pop();
  expect((await page.request.delete(`/api/tables/${tableId}`)).status()).toBe(204);
});

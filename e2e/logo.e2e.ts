import { expect, test, type Page } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

// The e2e config turns on reduced motion for every test; these opt back out where they need the intro.
async function inLobby(page: Page, motion: 'reduce' | 'no-preference'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: motion });
  await enter(page, `logo${randomTag()}`);
}

const corner = (page: Page) => page.getByRole('button', { name: 'Play the Carbon & Silicon intro' });
const intro = (page: Page) => page.getByRole('dialog', { name: 'Carbon & Silicon' });
const wordmark = (page: Page) => page.getByRole('banner').getByRole('link', { name: 'Carbon & Silicon' });

test('the corner tiles play the intro; Escape skips it and the page stays put', async ({ browser }) => {
  const page = await newPlayer(browser);
  await inLobby(page, 'no-preference');
  await corner(page).click();

  await expect(intro(page)).toBeVisible();
  await expect(intro(page)).toBeFocused();
  const sound = intro(page).getByRole('button', { name: 'Sound' });
  await expect(sound).toHaveAttribute('aria-pressed', 'true');

  // Muting is remembered for next time, and doesn't end the intro.
  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await expect(intro(page)).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).localStorage.getItem('cs:intro-sound'))).toBe('off');

  await page.keyboard.press('Escape');
  await expect(intro(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(corner(page)).toBeFocused();
});

test('the intro ends on its own without navigating; a click also skips it', async ({ browser }) => {
  const page = await newPlayer(browser);
  await inLobby(page, 'no-preference');
  await corner(page).click();
  await expect(intro(page)).toBeVisible();
  await expect(intro(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/$/);

  await corner(page).click();
  await expect(intro(page)).toBeVisible();
  await intro(page).click({ position: { x: 20, y: 200 } });
  await expect(intro(page)).toHaveCount(0);
});

test('with reduced motion the corner shows the finished frame, silent, until dismissed', async ({ browser }) => {
  const page = await newPlayer(browser);
  await inLobby(page, 'reduce');
  await corner(page).click();
  await expect(intro(page)).toBeVisible();
  await expect(intro(page).getByRole('button', { name: 'Sound' })).toHaveCount(0);
  // A still frame doesn't end on its own.
  await page.waitForTimeout(1500);
  await expect(intro(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(intro(page)).toHaveCount(0);
});

test('the wordmark is a plain link home again: no intro', async ({ browser }) => {
  const page = await newPlayer(browser);
  await inLobby(page, 'no-preference');
  await page.goto('/u/Sprocket');
  await wordmark(page).click();
  await expect(page).toHaveURL(/\/$/);
  await page.waitForTimeout(300);
  await expect(intro(page)).toHaveCount(0);
});

import { expect, test, type Page } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

// The e2e config turns on reduced motion for every test; these opt back out where they need the intro.
// Signed in, so the lobby it lands on has no handle gate (which would take focus off the wordmark).
async function onProfile(page: Page, motion: 'reduce' | 'no-preference'): Promise<void> {
  await enter(page, `logo${randomTag()}`);
  await page.emulateMedia({ reducedMotion: motion });
  await page.goto('/u/Sprocket');
  await expect(page.getByRole('heading', { name: 'Sprocket', level: 1 })).toBeVisible();
}

const wordmark = (page: Page) => page.getByRole('banner').getByRole('link', { name: 'Carbon & Silicon' });
const intro = (page: Page) => page.getByRole('dialog', { name: 'Carbon & Silicon' });

test('clicking the wordmark plays the intro; Escape skips it and lands on the lobby', async ({ browser }) => {
  const page = await newPlayer(browser);
  await onProfile(page, 'no-preference');
  await wordmark(page).click();

  await expect(intro(page)).toBeVisible();
  await expect(intro(page)).toBeFocused();
  await expect(page).toHaveURL(/\/u\/Sprocket$/);
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
  await expect(wordmark(page)).toBeFocused();
});

test('the intro ends on its own and goes home; a click also skips it', async ({ browser }) => {
  const page = await newPlayer(browser);
  await onProfile(page, 'no-preference');
  await wordmark(page).click();
  await expect(intro(page)).toBeVisible();
  await expect(intro(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/$/);

  // On a phone the stage scales to fit without pushing the page sideways.
  await page.setViewportSize({ width: 400, height: 860 });
  await wordmark(page).click();
  await expect(intro(page)).toBeVisible();
  const overflows = await page.evaluate(() => {
    const g = globalThis as any;
    return g.document.documentElement.scrollWidth > g.window.innerWidth;
  });
  expect(overflows).toBe(false);
  await intro(page).click({ position: { x: 20, y: 200 } });
  await expect(intro(page)).toHaveCount(0);
});

test('with reduced motion the wordmark just navigates', async ({ browser }) => {
  const page = await newPlayer(browser);
  await onProfile(page, 'reduce');
  await wordmark(page).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(intro(page)).toHaveCount(0);
});

test('a ctrl-click is left to the browser: no intro', async ({ browser }) => {
  const page = await newPlayer(browser);
  await onProfile(page, 'no-preference');
  await wordmark(page).click({ modifiers: ['ControlOrMeta'] });
  // Give a would-be overlay a moment to mount before checking it never did.
  await page.waitForTimeout(300);
  await expect(intro(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/u\/Sprocket$/);
});

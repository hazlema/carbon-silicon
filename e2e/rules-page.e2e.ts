import { expect, test } from '@playwright/test';

const guide = (page: import('@playwright/test').Page) => page.locator('article.prose');
const toc = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'On this page' });

test('the Game Rules page shows one guide at a time, picked from the game cards, with an index beside it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/games');
  const cards = page.getByRole('navigation', { name: 'Games' });
  // No hash: the first game's guide, and only that one.
  await expect(guide(page)).toHaveCount(1);
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('Critical Mass — How to Play');
  await expect(cards.getByRole('link', { name: /Critical Mass/ })).toHaveAttribute('aria-current', 'true');

  // The index lists the guide's sections and scrolls to one, staying in view itself.
  const surprises = toc(page).getByRole('button', { name: 'The six things that surprise everyone' });
  await expect(surprises).toBeVisible();
  await surprises.click();
  await expect(guide(page).locator('#the-six-things-that-surprise-everyone')).toBeInViewport();
  await expect(surprises).toBeInViewport();

  // A card switches the guide and names it in the address, so the link can be shared.
  await page.evaluate(() => (globalThis as any).scrollTo(0, 0));
  await cards.getByRole('link', { name: /Crown & Steel/ }).click();
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('Crown & Steel — How to Play');
  await expect(guide(page)).toHaveCount(1);
  await expect(page).toHaveURL(/\/games#checkers$/);
  await expect(toc(page).getByRole('button', { name: 'Worked examples' })).toBeVisible();
  // The guide's pictures are served from beside its rules file.
  const hero = guide(page).locator('img').first();
  await expect.poll(() => hero.evaluate((img) => (img as any).naturalWidth)).toBeGreaterThan(0);
});

test('a Rules link with a game in the hash opens that game\'s guide', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/games#lightline');
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('Lightline — How to Play');
  await expect(page.getByRole('navigation', { name: 'Games' }).getByRole('link', { name: /Lightline/ })).toHaveAttribute('aria-current', 'true');
});

test('at 400 px the index folds into a button and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await page.goto('/games#checkers');
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('Crown & Steel — How to Play');
  const { scroll, inner } = await page.evaluate(() => {
    const g = globalThis as any;
    return { scroll: g.document.documentElement.scrollWidth as number, inner: g.innerWidth as number };
  });
  expect(scroll).toBeLessThanOrEqual(inner);
  const section = toc(page).getByRole('button', { name: 'Winning, losing and drawing' });
  await expect(section).toBeHidden();
  await toc(page).getByRole('button', { name: 'On this page' }).click();
  await section.click();
  await expect(guide(page).locator('#winning-losing-and-drawing')).toBeInViewport();
  await expect(section).toBeHidden();
});

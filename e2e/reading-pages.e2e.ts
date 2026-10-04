import { expect, test, type Page } from '@playwright/test';

const sideways = (page: Page) =>
  page.evaluate(() => {
    const g = globalThis as any;
    return (g.document.documentElement.scrollWidth as number) - (g.innerWidth as number);
  });

test('the diary lists each day of the build with its entries, and an entry opens to read', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/diary');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build diary');
  await expect(page.getByText(/^\d+ entries across \d+ days of building/)).toBeVisible();
  // The first day of the build is day 1, and its entry shows how it opens.
  const first = page.locator('li.day').last();
  await expect(first.locator('.n')).toHaveText('Day 1');
  const doors = first.getByRole('link', { name: /Doors open/ });
  await expect(doors.locator('.excerpt')).not.toBeEmpty();
  await doors.click();
  await expect(page).toHaveURL(/\/diary\/2026-09-26-doors-open$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Doors open');
  await expect(page.locator('.when')).toContainText('Day 1');
  await expect(page.getByRole('navigation', { name: 'More entries' }).getByRole('link', { name: /Newer/ })).toBeVisible();
});

test('the API reference: an index you can search, endpoints as route lines, code you can copy', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/docs');
  const index = page.getByRole('navigation', { name: 'Contents' });
  await expect(index.getByRole('link', { name: 'Authentication' })).toBeVisible();
  await expect(page.locator('.base code').first()).toContainText('export BASE=http://127.0.0.1:3100');
  await expect(page.locator('h3.endpoint').first()).toHaveText(/POST\s*\/api\/agents/);
  await expect(page.locator('.code .copy').first()).toHaveText('Copy');

  // Searching lists matching endpoints under their sections; a hit jumps to it.
  await index.getByRole('searchbox').fill('rematch');
  const hit = index.getByRole('link', { name: /POST\s*\/tables\/:id\/rematch/ });
  await expect(hit).toBeVisible();
  await expect(index.getByRole('link', { name: 'Authentication' })).toHaveCount(0);
  await hit.click();
  await expect(page.locator('#post-apitablesidrematch')).toBeInViewport();
  await index.getByRole('searchbox').fill('no such thing anywhere');
  await expect(index.getByText('Nothing matches')).toBeVisible();
});

test('at 400 px the diary and the API reference never scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  for (const path of ['/diary', '/diary/2026-09-26-old-iron', '/docs']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    expect(await sideways(page), path).toBeLessThanOrEqual(0);
  }
});

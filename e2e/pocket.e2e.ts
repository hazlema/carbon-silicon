import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { pickGame, randomIp, randomTag } from './testing';

/** A phone: Pixel 7-sized, touch, its own client IP. */
export async function phone(browser: Browser, viewport = { width: 400, height: 800 }): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], viewport, extraHTTPHeaders: { 'x-forwarded-for': randomIp() } });
  return context.newPage();
}

export async function enterAndPlayAgent(p: Page, request: import('@playwright/test').APIRequestContext) {
  const reg = await request.post('/api/agents', { data: { name: `pk${randomTag()}` } });
  const { token, identity } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  await p.goto('/');
  await p.getByLabel('Your handle').fill(`ph${randomTag()}`);
  await p.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(p.getByLabel('Your handle')).toHaveCount(0);
  await request.post('/api/quickmatch', { headers: auth, data: { gameId: 'critical-mass' } });
  await pickGame(p);
  await p.getByRole('button', { name: 'Find a match' }).click();
  await p.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  const matchId = (await (await request.get('/api/me', { headers: auth })).json()).activeMatch as string;
  return { auth, handle: identity.handle as string, matchId };
}

test('on a phone the table fills the screen: no site header, Critical Mass in Top view, ✕ asks before leaving', async ({ browser, request }) => {
  const p = await phone(browser);
  await enterAndPlayAgent(p, request);
  await expect(p.locator('.table.pocket')).toBeVisible();
  await expect(p.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(p.getByRole('button', { name: 'Top view' })).toHaveAttribute('aria-pressed', 'true');
  await p.getByRole('button', { name: 'Leave the table' }).click();
  await expect(p.getByText('Leave the table? The match keeps going: the autopilot plays your turns, and 3 missed in a row forfeit.')).toBeVisible();
  await p.getByRole('button', { name: 'Stay' }).click();
  await expect(p.locator('.table.pocket')).toBeVisible();
  await p.getByRole('button', { name: 'Leave the table' }).click();
  await p.getByRole('button', { name: 'Leave', exact: true }).click();
  await p.waitForURL((u) => u.pathname === '/');
  await expect(p.getByRole('navigation', { name: 'Main' })).toBeVisible(); // chrome restored
});

test('held sideways, the Critical Mass Top view turns so the long sides agree', async ({ browser, request }) => {
  const p = await phone(browser, { width: 800, height: 400 });
  await enterAndPlayAgent(p, request);
  await expect(p.locator('.table.pocket')).toBeVisible();
  await expect(p.locator('.stage3d')).toHaveAttribute('data-spin', '90');
  await p.setViewportSize({ width: 400, height: 800 });
  await expect(p.locator('.stage3d')).toHaveAttribute('data-spin', '0');
});

test('the desktop table is unchanged at 1400 px', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await enterAndPlayAgent(page, request);
  await expect(page.locator('.table')).toBeVisible();
  await expect(page.locator('.table.pocket')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator('.talk')).toBeVisible();
});

import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/** A short random tag for building test handles, e.g. `e2e${randomTag()}`. Only the digits the profanity
 *  filter doesn't read as letters (it resolves leetspeak: 1→i, 3→e, 4→a, 5→s, 7→t), so a handle like
 *  `a55…` can never turn up and fail a test in setup. */
export function randomTag(): string {
  return Array.from({ length: 9 }, () => '02689'[Math.floor(Math.random() * 5)]).join('');
}

/** A password every e2e locked name uses. */
export const PASSWORD = 'correct horse battery staple';

const octet = () => 1 + Math.floor(Math.random() * 250);
export const randomIp = () => `10.${octet()}.${octet()}.${octet()}`;

/** A fresh browser context with its own client IP, so sign-up and sign-in limits never collide between tests. */
export async function newPlayer(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': randomIp() } });
  return context.newPage();
}

/** Pick a guest handle on the lobby's gate and wait until the gate is gone. */
export async function enter(page: Page, handle: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(handle);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(page.getByLabel('Your handle')).toHaveCount(0);
}

/** Lock the page's current name through the API; returns the recovery code. */
export async function lock(page: Page, password: string): Promise<string> {
  const r = await page.request.post('/api/me/lock', { data: { password } });
  expect(r.status()).toBe(200);
  return ((await r.json()) as { recoveryCode: string }).recoveryCode;
}

/** Make a locked name a mod through the admin console (loopback + the e2e admin key). */
export async function grantMod(request: APIRequestContext, handle: string): Promise<void> {
  const r = await request.post('/api/console/grant-mod', { headers: { 'x-admin-key': 'e2e-admin' }, data: { handle } });
  if (!r.ok()) throw new Error(`grant-mod ${handle} failed: ${r.status()} ${await r.text()}`);
}

/** Make a locked name an admin through the admin console (loopback + the e2e admin key). */
export async function grantAdmin(request: APIRequestContext, handle: string): Promise<void> {
  const r = await request.post('/api/console/grant', { headers: { 'x-admin-key': 'e2e-admin' }, data: { handle } });
  if (!r.ok()) throw new Error(`grant ${handle} failed: ${r.status()} ${await r.text()}`);
}

/** Choose a game in the lobby's Play panel; the browser remembers it, like a player's pick. */
export async function pickGame(page: Page, name = 'Critical Mass'): Promise<void> {
  await page.getByRole('button', { name: 'Select game' }).click();
  await page.getByRole('dialog', { name: 'Choose a game' }).getByRole('button', { name: `Select ${name}` }).click();
  await expect(page.getByRole('region', { name: 'Play' }).getByRole('heading', { name })).toBeVisible();
}

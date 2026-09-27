import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/** A short random tag for building test handles, e.g. `e2e${randomTag()}`. Digits only — unlike
 *  a base-36 tag, it can never accidentally spell something the profanity filter rejects. */
export function randomTag(): string {
  return String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
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

import { expect, test } from '@playwright/test';
import { enter, grantMod, lock, newPlayer, PASSWORD, randomTag } from './testing';

test('a locked name signs in from a second browser, and "sign out everywhere else" sends that browser back to the gate', async ({ browser }) => {
  const a = await newPlayer(browser);
  const name = `key${randomTag()}`;
  await enter(a, name);
  await lock(a, PASSWORD);

  const b = await newPlayer(browser);
  await b.goto('/');
  await b.getByRole('button', { name: 'I have a name' }).click();
  await b.getByLabel('Handle', { exact: true }).fill(`  ${name.toUpperCase()} `); // case and spaces don't matter
  await b.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await b.getByRole('button', { name: 'Sign in' }).click();
  await expect(b.getByRole('dialog')).toHaveCount(0);
  await expect(b.getByRole('banner').getByText(name)).toBeVisible();

  const out = await a.request.delete('/api/me/sessions');
  expect(out.ok()).toBe(true);
  await b.reload();
  await expect(b.getByLabel('Your handle')).toBeVisible();
  await a.reload();
  await expect(a.getByLabel('Your handle')).toHaveCount(0); // the browser that did it stays signed in
});

test('a wrong password is refused on the gate', async ({ browser }) => {
  const a = await newPlayer(browser);
  const name = `pw${randomTag()}`;
  await enter(a, name);
  await lock(a, PASSWORD);
  const b = await newPlayer(browser);
  await b.goto('/');
  await b.getByRole('button', { name: 'I have a name' }).click();
  await b.getByLabel('Handle', { exact: true }).fill(name);
  await b.getByLabel('Password', { exact: true }).fill('not the password at all');
  await b.getByRole('button', { name: 'Sign in' }).click();
  await expect(b.getByRole('alert')).toBeVisible();
  await expect(b.getByRole('dialog')).toBeVisible();
});

test('a recovery code sets a new password and shows the next code once', async ({ browser }) => {
  const a = await newPlayer(browser);
  const name = `rec${randomTag()}`;
  await enter(a, name);
  const code = await lock(a, PASSWORD);

  const b = await newPlayer(browser);
  await b.goto('/');
  await b.getByRole('button', { name: 'I have a name' }).click();
  await b.getByRole('button', { name: 'Lost your password?' }).click();
  await b.getByLabel('Handle', { exact: true }).fill(name);
  await b.getByLabel('Recovery code').fill(code);
  await b.getByLabel('New password', { exact: true }).fill('a brand new secret');
  await b.getByRole('button', { name: 'Set new password' }).click();
  const shown = b.getByTestId('recovery-code');
  await expect(shown).toContainText('csr_');
  expect(await shown.textContent()).not.toContain(code);
  await b.getByRole('button', { name: 'I saved it' }).click();
  await expect(b.getByRole('dialog')).toHaveCount(0);
  await expect(b.getByRole('banner').getByText(name)).toBeVisible();

  const again = await b.request.post('/api/session/recover', { data: { handle: name, code, password: 'another secret pw' } });
  expect(again.status()).toBe(401); // the old code is spent
});

test('a suspended player sees why, live', async ({ browser, request }) => {
  const mod = await newPlayer(browser);
  const modName = `mod${randomTag()}`;
  await enter(mod, modName);
  await lock(mod, PASSWORD);
  await grantMod(request, modName);

  const target = await newPlayer(browser);
  const name = `sus${randomTag()}`;
  await enter(target, name);
  const r = await mod.request.post(`/api/mod/people/${name}/suspend`, { data: { reason: 'e2e: testing the banner', minutes: 30 } });
  expect(r.status()).toBe(200);
  const banner = target.getByRole('status').filter({ hasText: 'Your account is suspended' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Reason: e2e: testing the banner');
  // read-only: the send box is gone, not just refused (S239-240)
  await expect(target.getByLabel('Message #lobby')).toHaveCount(0);
});

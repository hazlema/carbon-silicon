import { expect, test } from '@playwright/test';
import { enter, newPlayer, PASSWORD, randomTag } from './testing';

test('your profile edits your bio, locks your name, and lists your browsers', async ({ browser }) => {
  const p = await newPlayer(browser);
  const name = `prof${randomTag()}`;
  await enter(p, name);
  await p.getByRole('banner').getByRole('link', { name: new RegExp(name) }).click();
  await expect(p).toHaveURL(`/u/${name}`);

  await p.getByRole('textbox', { name: 'Bio' }).fill('Plays for the orbs.');
  await p.getByRole('button', { name: 'Save bio' }).click();
  await expect(p.getByText('Saved.')).toBeVisible();
  await p.reload();
  await expect(p.locator('.bio')).toHaveText('Plays for the orbs.');

  await p.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await p.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Lock my name' }).click();
  await expect(p.getByTestId('recovery-code')).toContainText('csr_');
  await p.getByRole('button', { name: 'I saved it' }).click();
  await expect(p.locator('.badge', { hasText: 'locked name' })).toBeVisible();
  await expect(p.getByRole('heading', { name: 'Change password' })).toBeVisible();

  const browsers = p.getByRole('region', { name: 'Signed in' });
  await expect(browsers.getByText('This browser')).toBeVisible();

  await p.goto('/u/Sprocket');
  await expect(p.getByRole('heading', { name: 'Sprocket', level: 1 })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Save bio' })).toHaveCount(0);
});

test('an unknown handle says so', async ({ browser }) => {
  const p = await newPlayer(browser);
  await p.goto(`/u/nobody${randomTag()}`);
  await expect(p.getByRole('heading', { name: /No one goes by/ })).toBeVisible();
});

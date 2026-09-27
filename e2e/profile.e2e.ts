import { expect, test } from '@playwright/test';
import { enter, newPlayer, PASSWORD, randomTag } from './testing';

test('your profile edits your bio, locks your name, and lists your browsers', async ({ browser }) => {
  const p = await newPlayer(browser);
  const name = `prof${randomTag()}`;
  await enter(p, name);
  await p.getByRole('banner').getByRole('link', { name: new RegExp(name) }).click();
  await expect(p).toHaveURL(`/u/${name}`);

  await p.getByRole('textbox', { name: 'Bio' }).fill('Plays for the orbs.');
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(p.getByText('Saved.')).toBeVisible();
  await p.reload();
  await expect(p.locator('.bio')).toHaveText('Plays for the orbs.');

  await p.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await p.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Lock my name' }).click();
  await expect(p.getByTestId('recovery-code')).toContainText('csr_');
  await p.getByRole('button', { name: 'I saved it' }).click();
  await expect(p.locator('.badge', { hasText: 'locked name' })).toBeVisible();
  await expect(p.getByRole('heading', { name: 'Password', exact: true })).toBeVisible();

  const browsers = p.getByRole('region', { name: 'Signed in' });
  await expect(browsers.getByText('This browser')).toBeVisible();

  await p.goto('/u/Sprocket');
  await expect(p.getByRole('heading', { name: 'Sprocket', level: 1 })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(p.getByText('only you see this')).toHaveCount(0);
});

test('an unknown handle says so', async ({ browser }) => {
  const p = await newPlayer(browser);
  await p.goto(`/u/nobody${randomTag()}`);
  await expect(p.getByRole('heading', { name: /No one goes by/ })).toBeVisible();
});

test('a guest sees "Lock your name" in their own settings; a visitor sees no settings at all', async ({ browser }) => {
  const guest = await newPlayer(browser);
  const guestName = `guest${randomTag()}`;
  await enter(guest, guestName);
  await guest.getByRole('banner').getByRole('link', { name: new RegExp(guestName) }).click();
  await expect(guest).toHaveURL(`/u/${guestName}`);
  await expect(guest.getByText('only you see this')).toBeVisible();
  await expect(guest.getByRole('heading', { name: 'Lock your name' })).toBeVisible();

  const visitor = await newPlayer(browser);
  await enter(visitor, `visitor${randomTag()}`);
  await visitor.goto(`/u/${guestName}`);
  await expect(visitor.getByRole('heading', { name: guestName, level: 1 })).toBeVisible();
  await expect(visitor.getByText('only you see this')).toHaveCount(0);
  await expect(visitor.getByRole('heading', { name: 'Lock your name' })).toHaveCount(0);
  await expect(visitor.getByRole('textbox', { name: 'Bio' })).toHaveCount(0);
});

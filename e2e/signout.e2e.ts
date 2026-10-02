import { expect, test, type Page } from '@playwright/test';
import { enter, lock, newPlayer, PASSWORD, randomTag } from './testing';

const gate = (page: Page) => page.getByLabel('Your handle');
const openMenu = async (page: Page) => {
  await page.getByRole('banner').getByRole('button', { name: 'Your account' }).click();
  return page.getByRole('menu', { name: 'Your account' });
};

test('the name chip opens a menu: View profile goes to your page, Sign out signs a locked name straight out', async ({ browser }) => {
  const page = await newPlayer(browser);
  const handle = `out${randomTag()}`;
  await enter(page, handle);
  await lock(page, PASSWORD);
  await page.reload();
  let menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'View profile' }).click();
  await expect(page).toHaveURL(new RegExp(`/u/${handle}$`));
  menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(gate(page)).toBeVisible();
});

test('a guest is warned before signing out gives the name up, and can cancel, go set a password, or sign out anyway', async ({ browser }) => {
  const page = await newPlayer(browser);
  const handle = `gst${randomTag()}`;
  await enter(page, handle);
  let menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  const warning = page.getByRole('dialog', { name: 'Sign out?' });
  await expect(warning).toContainText(`gives up @${handle} for good`);
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(warning).toBeHidden();
  await expect(gate(page)).toHaveCount(0);

  menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await warning.getByRole('link', { name: 'Set a password' }).click();
  await expect(page).toHaveURL(new RegExp(`/u/${handle}$`));
  await expect(gate(page)).toHaveCount(0);

  menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await warning.getByRole('button', { name: 'Sign out anyway' }).click();
  await expect(gate(page)).toBeVisible();
});

test('the profile has its own Sign out, beside Delete account', async ({ browser }) => {
  const page = await newPlayer(browser);
  const handle = `prf${randomTag()}`;
  await enter(page, handle);
  await lock(page, PASSWORD);
  await page.goto(`/u/${handle}`);
  const settings = page.getByRole('complementary', { name: /Settings/ });
  await expect(settings.getByRole('region', { name: 'Delete account' })).toBeVisible();
  await settings.getByRole('region', { name: 'Sign out' }).getByRole('button', { name: 'Sign out' }).click();
  await expect(gate(page)).toBeVisible();
});

import { expect, test } from '@playwright/test';
import { enter, grantAdmin, grantMod, lock, newPlayer, PASSWORD, randomTag } from './testing';

test("admins get a Usage tab with the bots' OpenRouter spend; mods don't", async ({ browser, request }) => {
  const admin = await newPlayer(browser);
  const adminName = `adm${randomTag()}`;
  await enter(admin, adminName);
  await lock(admin, PASSWORD);
  await grantAdmin(request, adminName);
  await admin.goto('/mod');
  await admin.getByRole('tab', { name: 'Usage' }).click();
  // The e2e server has no OpenRouter key: the tab says so instead of failing.
  await expect(admin.getByRole('tabpanel')).toContainText('Usage is not set up on this server.');

  const mod = await newPlayer(browser);
  const modName = `mdu${randomTag()}`;
  await enter(mod, modName);
  await lock(mod, PASSWORD);
  await grantMod(request, modName);
  await mod.goto('/mod');
  await expect(mod.getByRole('tab', { name: 'Reports' })).toBeVisible();
  await expect(mod.getByRole('tab', { name: 'Usage' })).toHaveCount(0);
});

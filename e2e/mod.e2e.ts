import { expect, test } from '@playwright/test';
import { enter, grantMod, lock, newPlayer, PASSWORD, randomTag } from './testing';

test('a mod deletes a reported line from /mod, and the lobby shows it was removed', async ({ browser, request }) => {
  const loud = await newPlayer(browser);
  const loudName = `loud${randomTag()}`;
  await enter(loud, loudName);
  const line = `spam spam spam ${randomTag()}`;
  await loud.getByLabel('Message #lobby').fill(line);
  await loud.getByRole('button', { name: 'Send' }).click();
  await expect(loud.getByRole('log').getByText(line)).toBeVisible();

  const reporter = await newPlayer(browser);
  await enter(reporter, `rep${randomTag()}`);
  const msg = reporter.getByRole('log').getByRole('article').filter({ hasText: line });
  await msg.hover();
  await msg.getByRole('button', { name: `Options for @${loudName}'s message` }).click();
  await reporter.getByRole('menuitem', { name: 'Report' }).click();
  await reporter.getByRole('button', { name: 'Send report' }).click();
  await expect(reporter.getByText('Reported. A mod will take a look.')).toBeVisible();

  const mod = await newPlayer(browser);
  const modName = `mod${randomTag()}`;
  await enter(mod, modName);
  await lock(mod, PASSWORD);
  await grantMod(request, modName);
  await mod.goto('/mod');
  await expect(mod.getByRole('banner').getByRole('link', { name: 'Mod', exact: true })).toBeVisible();

  const card = mod.getByRole('article').filter({ hasText: line });
  await card.getByRole('button', { name: 'Delete message' }).click();
  await card.getByLabel('Reason').fill('e2e: spam');
  await card.getByRole('button', { name: 'Delete it' }).click();
  await expect(mod.getByRole('article').filter({ hasText: line })).toHaveCount(0);

  await expect(loud.getByRole('log').getByText(`message removed by @${modName}`)).toBeVisible();

  await mod.getByRole('tab', { name: 'Log' }).click();
  await expect(mod.getByText(`@${modName} deleted a message from @${loudName}`)).toBeVisible();
});

test('a mod mutes someone from People', async ({ browser, request }) => {
  const target = await newPlayer(browser);
  const name = `ppl${randomTag()}`;
  await enter(target, name);

  const mod = await newPlayer(browser);
  const modName = `mod${randomTag()}`;
  await enter(mod, modName);
  await lock(mod, PASSWORD);
  await grantMod(request, modName);
  await mod.goto('/mod');
  await mod.getByRole('tab', { name: 'People' }).click();
  await mod.getByLabel('Search people').fill(name);
  await mod.getByRole('button', { name: new RegExp(name) }).click();
  const drawer = mod.getByRole('dialog', { name: name });
  await drawer.getByRole('button', { name: 'Mute' }).click();
  await drawer.getByLabel('1 hour').check();
  await drawer.getByLabel('Reason').fill('e2e: shouting');
  await drawer.getByRole('button', { name: 'Mute them' }).click();
  await expect(drawer.getByText(/Muted until/)).toBeVisible();
  await expect(target.getByRole('status').filter({ hasText: "You're muted" })).toBeVisible();
});

test('someone without the role gets a polite refusal', async ({ browser }) => {
  const p = await newPlayer(browser);
  await enter(p, `nosy${randomTag()}`);
  await p.goto('/mod');
  await expect(p.getByRole('heading', { name: 'Staff only.' })).toBeVisible();
  await expect(p.getByRole('banner').getByRole('link', { name: 'Mod', exact: true })).toHaveCount(0);
});

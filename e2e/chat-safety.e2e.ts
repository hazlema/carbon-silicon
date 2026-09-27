import { expect, test, type Page } from '@playwright/test';
import { enter, grantMod, lock, newPlayer, PASSWORD, randomTag } from './testing';

async function say(page: Page, text: string) {
  await page.getByLabel('Message #lobby').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('log').getByText(text)).toBeVisible();
}

test('a player reports a line, then ignores its author', async ({ browser }) => {
  const a = await newPlayer(browser);
  const aName = `loud${randomTag()}`;
  await enter(a, aName);
  const line = `buy my orbs ${randomTag()}`;
  await say(a, line);

  const b = await newPlayer(browser);
  await enter(b, `calm${randomTag()}`);
  const msg = b.getByRole('log').getByRole('article').filter({ hasText: line });
  const options = msg.getByRole('button', { name: `Options for @${aName}'s message` });
  await msg.hover();
  await options.click();
  await b.getByRole('menuitem', { name: 'Report' }).click();
  await b.getByLabel("What's wrong? (optional)").fill('spam');
  await b.getByRole('button', { name: 'Send report' }).click();
  await expect(b.getByText('Reported. A mod will take a look.')).toBeVisible();
  await b.keyboard.press('Escape');

  await msg.hover();
  await options.click();
  await b.getByRole('menuitem', { name: 'Report' }).click();
  await b.getByRole('button', { name: 'Send report' }).click();
  await expect(b.getByText('You already reported this.')).toBeVisible();
  await b.keyboard.press('Escape');

  await msg.hover();
  await options.click();
  await b.getByRole('menuitem', { name: `Ignore @${aName}` }).click();
  await expect(b.getByRole('log').getByText(line)).toHaveCount(0);
  await b.getByRole('button', { name: /1 hidden message/ }).click();
  await expect(b.getByRole('log').getByText(line)).toBeVisible();
});

test('your own lines have no menu', async ({ browser }) => {
  const a = await newPlayer(browser);
  const aName = `self${randomTag()}`;
  await enter(a, aName);
  const line = `just me ${randomTag()}`;
  await say(a, line);
  const msg = a.getByRole('log').getByRole('article').filter({ hasText: line });
  await expect(msg.getByRole('button', { name: /Options for/ })).toHaveCount(0);
});

test('a muted player sees why chat is off', async ({ browser, request }) => {
  const mod = await newPlayer(browser);
  const modName = `mod${randomTag()}`;
  await enter(mod, modName);
  await lock(mod, PASSWORD);
  await grantMod(request, modName);

  const target = await newPlayer(browser);
  const name = `hush${randomTag()}`;
  await enter(target, name);
  const r = await mod.request.post(`/api/mod/people/${name}/mute`, { data: { reason: 'e2e: cool off', minutes: 10 } });
  expect(r.status()).toBe(200);
  await expect(target.locator('.chat .note', { hasText: "You're muted" })).toBeVisible();
  await expect(target.getByLabel('Message #lobby')).toHaveCount(0);
});

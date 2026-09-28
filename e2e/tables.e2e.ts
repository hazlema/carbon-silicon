import { expect, test } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

test('host a table, invite the house from the name menu, start, play, rematch', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `host${randomTag()}`);
  await page.getByRole('button', { name: 'Host a table' }).click();
  await expect(page.getByText('Click a name to invite them.')).toBeVisible();
  const here = page.getByRole('region', { name: /Here now/ });
  await here.getByRole('button', { name: /Sprocket/ }).click();
  await page.getByRole('menuitem', { name: 'Invite to Critical Mass' }).click();
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled({ timeout: 10_000 });
  await start.click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Critical Mass' }).getByRole('status')).not.toHaveText('Starting…');
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await page.getByRole('button', { name: 'Rematch' }).click();
  const again = page.getByRole('button', { name: 'Start' });
  await expect(again).toBeEnabled({ timeout: 10_000 }); // Sprocket always says yes
  await again.click();
  // The rematch is a new match at the same table: the verdict goes and the board is live again.
  await expect(page.getByRole('button', { name: 'Resign' })).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/t\/t_/);
});

test('/invite from the lobby chat reaches someone on their profile page, and accepting seats them', async ({ browser }) => {
  const host = await newPlayer(browser);
  const guest = await newPlayer(browser);
  const guestHandle = `guest${randomTag()}`;
  await enter(host, `host${randomTag()}`);
  await enter(guest, guestHandle);
  await guest.goto(`/u/${guestHandle}`);
  await host.getByLabel('Message #lobby').fill(`/invite @${guestHandle}`);
  await host.getByRole('button', { name: 'Send' }).click();
  const card = guest.getByRole('group', { name: /Invite from/ });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(host.getByText('seated').nth(0)).toBeVisible();
  await expect(host.getByRole('button', { name: 'Start' })).toBeEnabled();
  await host.getByRole('button', { name: 'Start' }).click();
  await host.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  await guest.waitForURL(/\/t\/t_/, { timeout: 20_000 });
});

test('an open table shows in the lobby list, and a stranger can sit', async ({ browser }) => {
  const host = await newPlayer(browser);
  const other = await newPlayer(browser);
  await enter(host, `open${randomTag()}`);
  await enter(other, `sit${randomTag()}`);
  await host.getByRole('button', { name: 'Host a table' }).click();
  await host.getByLabel('Open to anyone').check();
  const list = other.getByRole('region', { name: 'Tables' });
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: 'Sit' }).first().click();
  await expect(host.getByRole('button', { name: 'Start' })).toBeEnabled();
});

test('a name menu near the right edge stays on screen at phone width', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 400, height: 800 });
  await enter(page, `edge${randomTag()}`);
  // A mention pushed well into the line (padded by filler text) sits close enough to the right
  // edge that the popover would overflow the 400px viewport if it stayed left-anchored.
  const filler = 'x'.repeat(15);
  await page.getByLabel('Message #lobby').fill(`${filler} @Sprocket`);
  await page.getByRole('button', { name: 'Send' }).click();
  const mention = page.getByRole('log').getByRole('button', { name: '@Sprocket', exact: true });
  await mention.click();
  const menu = page.getByRole('menu', { name: /Sprocket/ });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(400);
});

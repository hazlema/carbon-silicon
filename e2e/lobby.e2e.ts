import { expect, test } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

const handle = () => `e2e${randomTag()}`;

test('a human picks a handle, chats in the lobby, and sees Sprocket here', async ({ page }) => {
  const me = handle();
  await page.goto('/');
  await page.getByLabel('Your handle').fill(me);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Message #lobby').fill('hello, parlor');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('log').getByText('hello, parlor')).toBeVisible();
  const here = page.getByRole('region', { name: /Here now/ });
  await expect(here.getByText(me)).toBeVisible();
  await expect(here.getByText('Sprocket')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Your handle')).toHaveCount(0); // the name stuck to this browser
});

test('a taken handle explains itself', async ({ page, browser }) => {
  const me = handle();
  await page.goto('/');
  await page.getByLabel('Your handle').fill(me);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await other.getByLabel('Your handle').fill(me.toUpperCase());
  await other.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(other.getByRole('alert')).toContainText('taken');
});

test('the chat header is one line: #lobby and your conversations, no #critical-mass or #diary', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `one${randomTag()}`);
  const nav = page.getByRole('navigation', { name: 'Channels' });
  await expect(nav.getByRole('button', { name: /lobby/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /critical-mass/ })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /diary/ })).toHaveCount(0);
});

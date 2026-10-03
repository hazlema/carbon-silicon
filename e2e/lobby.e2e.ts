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

test('the composer is a one-line textarea (not a login-looking input): Enter sends, Shift+Enter adds nothing, pasted breaks flatten', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `ta${randomTag()}`);
  const box = page.getByLabel('Message #lobby');
  expect(await box.evaluate((e) => e.tagName)).toBe('TEXTAREA');
  await expect(box).toHaveAttribute('maxlength', '500');
  await expect(box).toHaveAttribute('enterkeyhint', 'send');
  await expect(box).toHaveAttribute('autocomplete', 'off');
  await expect(box).toHaveAttribute('autocorrect', 'on');
  await box.fill('one');
  await box.press('Shift+Enter');
  await box.pressSequentially('two');
  await expect(box).toHaveValue('onetwo');
  await box.fill('');
  await box.evaluate((e) => {
    (e as unknown as { value: string }).value = 'pasted\nacross\r\nlines';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(box).toHaveValue('pasted across lines');
  await box.press('Enter');
  await expect(page.getByRole('log').getByText('pasted across lines')).toBeVisible();
  await expect(box).toHaveValue('');
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

test('a diary entry reaches #lobby as a system line, since #diary is not a tab', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `dry${randomTag()}`);
  // The server announces every entry #diary hasn't seen when it boots; the e2e diary is the real one.
  await expect(page.getByRole('log').getByText(/New diary entry: ".+" \/diary\//).first()).toBeVisible();
});

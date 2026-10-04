import { devices, expect, test } from '@playwright/test';
import { enter, newPlayer, randomIp, randomTag } from './testing';

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
  // A soft keyboard whose Enter has no usable keydown: beforeinput insertLineBreak sends once and inserts nothing.
  await page.waitForTimeout(400); // past the double-send guard of the Enter above
  await box.fill('from gboard');
  const defaultPrevented = await box.evaluate((e) => {
    const ev = new (globalThis as any).InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true });
    e.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(defaultPrevented).toBe(true);
  await expect(page.getByRole('log').getByText('from gboard')).toHaveCount(1);
  await expect(box).toHaveValue('');
  // Caret: replacing pasted breaks keeps the caret where it was.
  await box.fill('');
  const caret = await box.evaluate((e) => {
    const t = e as unknown as { value: string; setSelectionRange(a: number, b: number): void; selectionStart: number; dispatchEvent(e: Event): boolean };
    t.value = 'ab\ncd';
    t.setSelectionRange(2, 2);
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return t.selectionStart;
  });
  expect(caret).toBe(2);
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

test('on a phone the lobby fits the screen, so the chat log is the only thing that scrolls; with the keyboard up only the conversation shows, pinned to the newest line', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 400, height: 800 }, extraHTTPHeaders: { 'x-forwarded-for': randomIp() } });
  const page = await context.newPage();
  await enter(page, `ph${randomTag()}`);
  // A log inside a scrolling page trapped the thumb: a swipe on the log never reached the page.
  const pageScrolls = () => page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1);
  expect(await pageScrolls()).toBe(false);
  await expect(page.getByRole('button', { name: 'Random match' })).toBeInViewport();
  const box = page.getByLabel('Message #lobby');
  await expect(box).toBeInViewport();

  // Here now swaps in below the tabs, which stay put.
  const tabs = page.getByRole('tablist', { name: 'Lobby' });
  const tabsTop = (await tabs.boundingBox())!.y;
  await page.getByRole('tab', { name: 'Here now' }).click();
  const here = page.getByRole('region', { name: /Here now/ });
  await expect(here).toBeVisible();
  expect((await tabs.boundingBox())!.y).toBe(tabsTop);
  expect((await here.boundingBox())!.y).toBeGreaterThan(tabsTop);
  expect(await pageScrolls()).toBe(false);
  await page.getByRole('tab', { name: 'Chat' }).click();

  for (let i = 1; i <= 5; i++) {
    await box.fill(`line ${i} of a phone conversation`);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('log').getByText(`line ${i} of a phone conversation`)).toBeVisible();
  }
  // The keyboard takes the bottom half: the page shrinks (interactive-widget=resizes-content) with the composer focused.
  await box.focus();
  await page.setViewportSize({ width: 400, height: 380 });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Random match' })).toBeHidden();
  await expect(box).toBeInViewport();
  expect(await pageScrolls()).toBe(false);
  const log = page.getByRole('log');
  expect((await log.boundingBox())!.height).toBeGreaterThan(150);
  await expect(log.getByText('line 5 of a phone conversation')).toBeInViewport();

  // Keyboard down: everything is back.
  await page.setViewportSize({ width: 400, height: 800 });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Random match' })).toBeInViewport();
  await context.close();
});

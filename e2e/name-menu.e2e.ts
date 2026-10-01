import { expect, test, type Page } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

/** Opens someone's name menu from the Here now list. */
async function menuFor(page: Page, handle: string) {
  const here = page.getByRole('region', { name: /Here now/ });
  await here.getByRole('button', { name: new RegExp(handle) }).click();
  return page.getByRole('menu', { name: `@${handle}` });
}

async function people(n: number, prefix: string, browser: import('@playwright/test').Browser) {
  const pages: Page[] = [];
  const handles: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = await newPlayer(browser);
    const h = `${prefix}${i}${randomTag()}`;
    await enter(p, h);
    pages.push(p);
    handles.push(h);
  }
  return { pages, handles };
}

test('the name menu: common actions first, then the power-user flyouts', async ({ browser }) => {
  const { pages: [a], handles: [, hb] } = await people(2, 'nm', browser);
  const menu = await menuFor(a, hb);
  await expect(menu.getByRole('menuitem')).toHaveText([
    `Chat with @${hb}`,
    `View @${hb}'s profile`,
    `Ignore @${hb}`,
    `Block @${hb}`,
    'Chat invite',
    'Game invite',
  ]);
  await expect(menu.getByRole('separator')).toHaveCount(2);
});

test('Chat with opens a private chat with them', async ({ browser }) => {
  const { pages: [a], handles: [, hb] } = await people(2, 'cw', browser);
  const menu = await menuFor(a, hb);
  await menu.getByRole('menuitem', { name: `Chat with @${hb}` }).click();
  await expect(a.getByRole('button', { name: new RegExp(`^@${hb}`) })).toBeVisible();
  await expect(a.getByPlaceholder(`Message @${hb}`)).toBeFocused();
});

test('Chat invite into a 1-on-1 opens a private group of three; into a group (the open one first) adds them', async ({ browser }) => {
  const { pages: [a], handles: [, hb, hc, hd] } = await people(4, 'ci', browser);
  // a and b have a private chat.
  expect((await a.request.post(`/api/dms/${hb}`, { data: { text: 'just us' } })).status()).toBe(201);
  await a.reload();
  let menu = await menuFor(a, hc);
  await menu.getByRole('menuitem', { name: 'Chat invite' }).click();
  await a.getByRole('menu', { name: 'Chat invite' }).getByRole('menuitem', { name: new RegExp(`@${hb}`) }).click();
  await expect(a.getByRole('region', { name: new RegExp(`you, ${hb}, ${hc}`, 'i') })).toBeVisible();
  // That group is open now: it leads the flyout, marked as this chat, and inviting d adds them to it.
  menu = await menuFor(a, hd);
  await menu.getByRole('menuitem', { name: 'Chat invite' }).click();
  const chats = a.getByRole('menu', { name: 'Chat invite' }).getByRole('menuitem');
  await expect(chats.first()).toContainText('this chat');
  await chats.first().click();
  await expect(a.getByText('4 people')).toBeVisible();
});

test('the flyout leaves out chats they are already in, and the 1-on-1 with them', async ({ browser }) => {
  const { pages: [a], handles: [, hb, hc] } = await people(3, 'cx', browser);
  expect((await a.request.post(`/api/dms/${hb}`, { data: { text: 'hey' } })).status()).toBe(201);
  expect((await a.request.post(`/api/dms/${hc}`, { data: { text: 'hey' } })).status()).toBe(201);
  await a.reload();
  const menu = await menuFor(a, hb);
  await menu.getByRole('menuitem', { name: 'Chat invite' }).click();
  const chats = a.getByRole('menu', { name: 'Chat invite' }).getByRole('menuitem');
  await expect(chats).toHaveCount(1);
  await expect(chats.first()).toContainText(`@${hc}`);
});

test('Block and Ignore are toggles: the menu offers Unblock and Stop ignoring', async ({ browser }) => {
  const { pages: [a], handles: [, hb] } = await people(2, 'bt', browser);
  let menu = await menuFor(a, hb);
  await menu.getByRole('menuitem', { name: `Block @${hb}` }).click();
  await expect(a.getByRole('status').filter({ hasText: `Blocked @${hb}.` })).toBeVisible();
  await a.keyboard.press('Escape');
  menu = await menuFor(a, hb);
  await menu.getByRole('menuitem', { name: `Unblock @${hb}` }).click();
  await a.keyboard.press('Escape');
  menu = await menuFor(a, hb);
  await expect(menu.getByRole('menuitem', { name: `Block @${hb}` })).toBeVisible();
  await menu.getByRole('menuitem', { name: `Ignore @${hb}` }).click();
  await a.keyboard.press('Escape');
  menu = await menuFor(a, hb);
  await expect(menu.getByRole('menuitem', { name: `Stop ignoring @${hb}` })).toBeVisible();
});

test('Game invite lists the games; picking one hosts it with them invited', async ({ browser }) => {
  const { pages: [a], handles: [, hb] } = await people(2, 'gi', browser);
  const menu = await menuFor(a, hb);
  await menu.getByRole('menuitem', { name: 'Game invite' }).click();
  const games = a.getByRole('menu', { name: 'Game invite' });
  await expect(games.getByRole('menuitem', { name: 'Host Crown & Steel' })).toBeVisible();
  await games.getByRole('menuitem', { name: 'Host Critical Mass' }).click();
  await expect(a.getByRole('button', { name: `Withdraw @${hb}'s invite` })).toBeVisible();
});

test('keyboard: → opens a flyout on its first item, ← comes back to it', async ({ browser }) => {
  const { pages: [a], handles: [, hb] } = await people(2, 'kb', browser);
  const menu = await menuFor(a, hb);
  const gameInvite = menu.getByRole('menuitem', { name: 'Game invite' });
  await gameInvite.focus();
  await a.keyboard.press('ArrowRight');
  const games = a.getByRole('menu', { name: 'Game invite' });
  await expect(games.getByRole('menuitem').first()).toBeFocused();
  await a.keyboard.press('ArrowDown');
  await expect(games.getByRole('menuitem').nth(1)).toBeFocused();
  await a.keyboard.press('ArrowLeft');
  await expect(games).toHaveCount(0);
  await expect(gameInvite).toBeFocused();
});

test('at phone width a flyout opens in place, with a way back', async ({ browser }) => {
  const { pages: [a], handles: [, hb] } = await people(2, 'ph', browser);
  await a.setViewportSize({ width: 400, height: 800 });
  // At phone width Here now is tucked away: open the menu from a mention in the lobby chat instead.
  await a.getByLabel('Message #lobby').fill(`hi @${hb}`);
  await a.getByRole('button', { name: 'Send' }).click();
  await a.getByRole('log').getByRole('button', { name: `@${hb}`, exact: true }).click();
  const menu = a.getByRole('menu', { name: `@${hb}` });
  await menu.getByRole('menuitem', { name: 'Game invite' }).click();
  const games = a.getByRole('menu', { name: 'Game invite' });
  await expect(games.getByRole('menuitem', { name: 'Host Critical Mass' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: `Chat with @${hb}` })).toHaveCount(0); // replaced, not beside
  const box = (await games.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(400);
  await games.getByRole('menuitem', { name: '‹ Back' }).click();
  await expect(menu.getByRole('menuitem', { name: `Chat with @${hb}` })).toBeVisible();
});

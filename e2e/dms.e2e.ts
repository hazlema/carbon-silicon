import { expect, test, type Page } from '@playwright/test';
import { enter, lock, newPlayer, PASSWORD, randomIp, randomTag } from './testing';

/** The tab for a conversation with @handle (its accessible name starts with the handle; an unread dot adds "N unread"). */
const dmTab = (page: Page, handle: string) => page.getByRole('button', { name: new RegExp(`^@${handle}`) });

async function messageFromHereNow(page: Page, handle: string) {
  const here = page.getByRole('region', { name: /Here now/ });
  await here.getByRole('button', { name: new RegExp(handle) }).click();
  await page.getByRole('menuitem', { name: `Message @${handle}` }).click();
}
async function say(page: Page, label: string, text: string) {
  await page.getByLabel(label).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('two people DM from the name menu: a dot, a Lobby count away from the lobby, read clears it', async ({ browser }) => {
  const ann = await newPlayer(browser);
  const bea = await newPlayer(browser);
  const annHandle = `ann${randomTag()}`;
  const beaHandle = `bea${randomTag()}`;
  await enter(ann, annHandle);
  await enter(bea, beaHandle);

  await messageFromHereNow(ann, beaHandle);
  await expect(ann.getByLabel(`Message @${beaHandle}`)).toBeFocused();
  await say(ann, `Message @${beaHandle}`, 'psst, over here');
  await expect(ann.getByRole('log').getByText('psst, over here')).toBeVisible();

  await expect(dmTab(bea, annHandle)).toBeVisible();
  await expect(dmTab(bea, annHandle).getByLabel('1 unread')).toBeVisible();

  await bea.goto('/games');
  await say(ann, `Message @${beaHandle}`, 'still there?');
  await expect(bea.getByRole('link', { name: /^Lobby/ })).toContainText('2');

  await bea.getByRole('link', { name: /^Lobby/ }).click();
  await dmTab(bea, annHandle).click();
  await expect(bea.getByRole('log').getByText('still there?')).toBeVisible();
  await expect(dmTab(bea, annHandle).getByLabel(/unread/)).toHaveCount(0);
});

test('closing a tab hides it until the next message; /msg opens a conversation from any composer', async ({ browser }) => {
  const ann = await newPlayer(browser);
  const bea = await newPlayer(browser);
  const annHandle = `ann${randomTag()}`;
  const beaHandle = `bea${randomTag()}`;
  await enter(ann, annHandle);
  await enter(bea, beaHandle);

  await say(ann, 'Message #lobby', `/msg @${beaHandle} hello from the lobby box`);
  await expect(ann.getByLabel(`Message @${beaHandle}`)).toBeVisible();
  await expect(dmTab(bea, annHandle)).toBeVisible();

  await expect(ann.getByRole('log').getByText('hello from the lobby box')).toBeVisible();
  await bea.getByRole('button', { name: `Close the conversation with @${annHandle}` }).click();
  await expect(dmTab(bea, annHandle)).toHaveCount(0);
  await say(ann, `Message @${beaHandle}`, 'one more thing');
  await expect(dmTab(bea, annHandle)).toBeVisible();
});

test('a house bot answers a DM; a block shows its reason in the composer', async ({ browser }) => {
  const page = await newPlayer(browser);
  const other = await newPlayer(browser);
  const otherHandle = `blk${randomTag()}`;
  await enter(page, `dmr${randomTag()}`);
  await enter(other, otherHandle);

  await messageFromHereNow(page, 'Sprocket');
  await say(page, 'Message @Sprocket', 'hi Sprocket');
  await expect(page.getByRole('log').locator('article.machine')).toBeVisible({ timeout: 15_000 });

  const handle = (await (await page.request.get('/api/me')).json()).identity.handle as string;
  expect((await other.request.put(`/api/me/blocks/${handle}`)).ok()).toBe(true);
  await messageFromHereNow(page, otherHandle);
  await say(page, `Message @${otherHandle}`, 'hello?');
  await expect(page.getByRole('alert').filter({ hasText: `@${otherHandle} isn't taking messages from you.` })).toBeVisible();
});

test('an agent DMs a human over HTTP and the human sees the tab', async ({ browser, request }) => {
  const page = await newPlayer(browser);
  const human = `hum${randomTag()}`;
  await enter(page, human);
  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `bot${randomTag()}` } });
  const { token, identity } = (await reg.json()) as { token: string; identity: { handle: string } };
  const sent = await request.post(`/api/dms/${human}`, { headers: { authorization: `Bearer ${token}` }, data: { text: 'beep boop' } });
  expect(sent.status()).toBe(201);
  await expect(dmTab(page, identity.handle)).toBeVisible();
});

test('the More menu works from the keyboard: Enter opens on the first item, arrows move, Escape returns to More', async ({ browser, request }) => {
  const page = await newPlayer(browser);
  const human = `kbd${randomTag()}`;
  await enter(page, human);
  for (let i = 0; i < 6; i++) {
    const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `kb${i}${randomTag()}` } });
    const { token } = (await reg.json()) as { token: string };
    const sent = await request.post(`/api/dms/${human}`, { headers: { authorization: `Bearer ${token}` }, data: { text: 'hi' } });
    expect(sent.status()).toBe(201);
  }
  const more = page.getByRole('button', { name: /^More/ });
  await expect(more).toBeVisible();
  await more.focus();
  await page.keyboard.press('Enter');
  const items = page.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'More conversations' })).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('signed out from elsewhere, a browser starts over at the gate with none of the old DMs', async ({ browser, request }) => {
  const here = await newPlayer(browser);
  const name = `out${randomTag()}`;
  await enter(here, name);
  await lock(here, PASSWORD);
  const there = await newPlayer(browser);
  expect((await there.request.post('/api/session/login', { data: { handle: name, password: PASSWORD } })).ok()).toBe(true);

  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `bot${randomTag()}` } });
  const { token, identity } = (await reg.json()) as { token: string; identity: { handle: string } };
  expect((await request.post(`/api/dms/${name}`, { headers: { authorization: `Bearer ${token}` }, data: { text: 'for your eyes' } })).status()).toBe(201);
  await expect(dmTab(here, identity.handle)).toBeVisible();

  expect((await there.request.delete('/api/me/sessions')).ok()).toBe(true);
  await expect(here.getByLabel('Your handle')).toBeVisible();
  await expect(dmTab(here, identity.handle)).toHaveCount(0);
});

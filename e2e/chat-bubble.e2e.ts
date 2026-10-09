import { devices, expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { enter, newPlayer, pickGame, randomIp, randomTag } from './testing';

/** Agents whose matches a test may have left running; afterEach resigns them so no seat stays busy for the next file. */
const agents: Record<string, string>[] = [];
test.afterEach(async ({ request }) => {
  for (const auth of agents.splice(0)) {
    const me = await request.get('/api/me', { headers: auth }).then((r) => r.json()).catch(() => null);
    if (me?.activeMatch) await request.post(`/api/matches/${me.activeMatch}/resign`, { headers: auth }).catch(() => {});
  }
});

const bubble = (page: Page) => page.getByTestId('chat-bubble');
/** A conversation's tab (its name starts with the handle; an unread dot adds "N unread"). */
const convTab = (page: Page, handle: string) => page.locator('.dmrow').getByRole('button', { name: new RegExp(`^@${handle}`) });

/** The balloon sits under `anchor` with its tail's tip over the anchor's middle (give or take the tail's width). */
async function pointsDownAt(b: Locator, anchor: Locator) {
  const bb = (await b.boundingBox())!;
  const ab = (await anchor.boundingBox())!;
  expect(bb.y).toBeGreaterThanOrEqual(ab.y + ab.height);
  expect(bb.y - (ab.y + ab.height)).toBeLessThan(24);
  const mid = ab.x + ab.width / 2;
  expect(mid).toBeGreaterThan(bb.x);
  expect(mid).toBeLessThan(bb.x + bb.width);
}

/** A human (this page) sits down to Critical Mass against a fresh agent. */
async function humanVsAgent(page: Page, request: APIRequestContext) {
  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `cb${randomTag()}` } });
  const { token, identity } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  agents.push(auth);
  const me = `cbh${randomTag()}`;
  await page.goto('/');
  await page.getByLabel('Your handle').fill(me);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(page.getByLabel('Your handle')).toHaveCount(0);
  await pickGame(page, 'Critical Mass');
  await page.getByRole('button', { name: 'Find a match' }).click();
  // The agent queues second, so it is paired at once (the house fallback waits 3 s).
  await request.post('/api/quickmatch', { headers: auth, data: { gameId: 'critical-mass' } });
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  return { auth, agent: identity.handle as string, me };
}

test('in the lobby a DM from someone else pops a balloon at its tab; clicking it opens the conversation; your own lines never do', async ({ browser }) => {
  const ann = await newPlayer(browser);
  const bea = await newPlayer(browser);
  await ann.setViewportSize({ width: 1400, height: 900 });
  await bea.setViewportSize({ width: 1400, height: 900 });
  const ha = `ann${randomTag()}`;
  const hb = `bea${randomTag()}`;
  await enter(ann, ha);
  await enter(bea, hb);
  await bea.waitForTimeout(1000); // the socket is up

  // Ann writes while Bea is in #lobby: a balloon, pointing at the new tab, announced politely.
  expect((await ann.request.post(`/api/dms/${hb}`, { data: { text: 'psst, bea' } })).status()).toBe(201);
  await expect(bubble(bea)).toHaveText(`💬 New message from @${ha}!`);
  await expect(bea.locator('[aria-live="polite"]').filter({ hasText: `New message from @${ha}` })).toHaveCount(1);
  await pointsDownAt(bubble(bea), convTab(bea, ha));
  // The orange dot is still there.
  await expect(convTab(bea, ha).getByLabel('1 unread')).toBeVisible();

  // Two more while it's up: one balloon, counting.
  await ann.request.post(`/api/dms/${hb}`, { data: { text: 'still there?' } });
  await ann.request.post(`/api/dms/${hb}`, { data: { text: 'hello??' } });
  await expect(bubble(bea)).toHaveText(`💬 3 new messages from @${ha}`);
  await expect(bubble(bea)).toHaveCount(1);

  // Clicking it is clicking the tab: the conversation opens, the balloon goes.
  await bubble(bea).click();
  await expect(bea.getByLabel(`Message @${ha}`)).toBeVisible();
  await expect(bea.getByRole('log').getByText('hello??')).toBeVisible();
  await expect(bubble(bea)).toHaveCount(0);

  // A line in the conversation you're reading: no balloon.
  await ann.request.post(`/api/dms/${hb}`, { data: { text: 'you see this one' } });
  await expect(bea.getByRole('log').getByText('you see this one')).toBeVisible();
  await expect(bubble(bea)).toHaveCount(0);

  // Back in #lobby: Bea's own line (from another device, say) never pops one; Ann's next does, and clicking the tab clears it.
  await bea.getByRole('button', { name: 'lobby' }).click();
  await bea.request.post(`/api/dms/${ha}`, { data: { text: 'mine' } });
  await expect(convTab(ann, hb)).toBeVisible();
  await bea.waitForTimeout(800);
  await expect(bubble(bea)).toHaveCount(0);
  await ann.request.post(`/api/dms/${hb}`, { data: { text: 'one more' } });
  await expect(bubble(bea)).toHaveText(`💬 New message from @${ha}!`);
  await convTab(bea, ha).click();
  await expect(bubble(bea)).toHaveCount(0);
});

test('at a table mid-match an agent’s DM pops a balloon at its tab; a resident’s (inline only) and your own never do', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const { auth, agent, me } = await humanVsAgent(page, request);
  await expect(page.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(1000); // the socket is up

  // Sprocket (a house bot) answers inline: no tab, so no balloon; neither does your own /w.
  await page.getByPlaceholder('Talk trash, play fair').fill('/w @Sprocket hello from the table');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('log').getByRole('button', { name: /^Private line, @Sprocket → you: / })).toBeVisible({ timeout: 20_000 });
  await expect(bubble(page)).toHaveCount(0);

  // The agent across the table writes: a balloon at its tab (the line is also inline, as before).
  expect((await request.post(`/api/dms/${me}`, { headers: auth, data: { text: 'psst, carbon' } })).status()).toBe(201);
  await expect(bubble(page)).toHaveText(`💬 New message from @${agent}!`);
  await pointsDownAt(bubble(page), convTab(page, agent));
  await bubble(page).click();
  await expect(convTab(page, agent)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('log').getByText('psst, carbon')).toBeVisible();
  await expect(bubble(page)).toHaveCount(0);
});

test('on a phone the balloon points at the chat button; a tap opens the sheet on that conversation', async ({ browser, request }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 400, height: 800 }, extraHTTPHeaders: { 'x-forwarded-for': randomIp() } });
  const p = await context.newPage();
  const { auth, agent, me } = await humanVsAgent(p, request);
  const fab = p.getByRole('button', { name: /^Open chat/ });
  await expect(fab).toBeVisible();
  await p.waitForTimeout(1000); // the socket is up

  expect((await request.post(`/api/dms/${me}`, { headers: auth, data: { text: 'psst, pocket' } })).status()).toBe(201);
  await expect(bubble(p)).toHaveText(`💬 New message from @${agent}!`);
  // To the button's left, level with it.
  const bb = (await bubble(p).boundingBox())!;
  const fb = (await fab.boundingBox())!;
  expect(bb.x + bb.width).toBeLessThanOrEqual(fb.x);
  expect(fb.x - (bb.x + bb.width)).toBeLessThan(24);
  const mid = fb.y + fb.height / 2;
  expect(mid).toBeGreaterThan(bb.y);
  expect(mid).toBeLessThan(bb.y + bb.height);

  await bubble(p).tap();
  const sheet = p.getByRole('dialog', { name: 'Chat' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('log').getByText('psst, pocket')).toBeVisible();
  await expect(convTab(p, agent)).toHaveAttribute('aria-current', 'true');
  await expect(bubble(p)).toHaveCount(0);
});

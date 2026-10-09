import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { pickGame, randomIp, randomTag } from './testing';

/** Agents whose matches a test may have left running; afterEach resigns them so no seat stays busy for the next file. */
const agents: Record<string, string>[] = [];
test.afterEach(async ({ request }) => {
  for (const auth of agents.splice(0)) {
    const me = await request.get('/api/me', { headers: auth }).then((r) => r.json()).catch(() => null);
    if (me?.activeMatch) await request.post(`/api/matches/${me.activeMatch}/resign`, { headers: auth }).catch(() => {});
  }
});

/** A human (this page) sits down to Critical Mass against a fresh agent; returns the agent's auth and handle, the human's handle and the table. */
async function humanVsAgent(page: Page, request: APIRequestContext) {
  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `td${randomTag()}` } });
  const { token, identity } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  agents.push(auth);
  const me = `tdh${randomTag()}`;
  await page.goto('/');
  await page.getByLabel('Your handle').fill(me);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(page.getByLabel('Your handle')).toHaveCount(0);
  await pickGame(page, 'Critical Mass');
  await page.getByRole('button', { name: 'Find a match' }).click();
  // The agent queues second, so it is paired at once (the house fallback waits 3 s).
  await request.post('/api/quickmatch', { headers: auth, data: { gameId: 'critical-mass' } });
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  const tableId = new URL(page.url()).pathname.split('/').pop()!;
  return { auth, agent: identity.handle as string, me, tableId };
}

/** The lines of a DM as the agent reads it. */
async function agentReads(request: APIRequestContext, auth: Record<string, string>, withHandle: string): Promise<string[]> {
  const r = await request.get(`/api/dms/${withHandle}`, { headers: auth });
  if (!r.ok()) return [];
  return ((await r.json()).messages as { text: string }[]).map((m) => m.text);
}

const privateLine = (page: Page, name: RegExp) => page.getByRole('log').getByRole('button', { name });
/** A conversation's tab in the chat bar (its name starts with the handle; an unread dot adds "N unread"). */
const convTab = (page: Page, handle: string) => page.locator('.dmrow').getByRole('button', { name: new RegExp(`^@${handle}`) });

test('during a match a DM shows inline in the Table feed (and in its tab); a click on it replies privately, and /w sends one', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const { auth, agent, me, tableId } = await humanVsAgent(page, request);
  const tableTab = page.getByRole('tab', { name: 'Table' });
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(1000); // the socket is up

  // The agent whispers across the table: the line lands in the Table feed, marked private, and in its own tab.
  expect((await request.post(`/api/dms/${me}`, { headers: auth, data: { text: 'psst, carbon' } })).status()).toBe(201);
  const incoming = privateLine(page, new RegExp(`^Private line, @${agent} → you: psst, carbon`));
  await expect(incoming).toBeVisible();
  await expect(incoming).toContainText('🔒');
  await expect(convTab(page, agent)).toBeVisible();
  // Seen in the feed, it's read: no dot on its tab, no count on the Lobby link.
  await expect(convTab(page, agent).getByLabel(/unread/)).toHaveCount(0);
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');

  // A click on the line puts the composer in reply mode; ✕ steps out of it without sending.
  await incoming.click();
  const chip = page.getByTestId('reply-chip');
  await expect(chip).toContainText(`🔒 Replying to @${agent}`);
  await page.getByRole('button', { name: `Stop replying to @${agent}` }).click();
  await expect(chip).toHaveCount(0);

  // Again, and this time send: the agent gets it as a DM, the chip clears, the feed shows it as yours.
  await incoming.click();
  await expect(page.getByPlaceholder('Private reply')).toBeFocused();
  await page.keyboard.type('back at you');
  await page.keyboard.press('Enter');
  await expect(chip).toHaveCount(0);
  await expect.poll(() => agentReads(request, auth, me), { timeout: 10_000 }).toContain('back at you');
  await expect(privateLine(page, new RegExp(`^Private line, you → @${agent}: back at you`))).toBeVisible();
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');

  // /w (and /msg) from the Table composer: a DM, and the chat stays on the Table.
  await page.getByPlaceholder('Talk trash, play fair').fill(`/w @${agent} second thought`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => agentReads(request, auth, me), { timeout: 10_000 }).toContain('second thought');
  await page.getByPlaceholder('Talk trash, play fair').fill(`/msg @${agent} third`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => agentReads(request, auth, me), { timeout: 10_000 }).toContain('third');
  await expect(privateLine(page, new RegExp(`^Private line, you → @${agent}: third`))).toBeVisible();
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');
  // A name nobody has: the server's error, in the composer.
  await page.getByPlaceholder('Talk trash, play fair').fill(`/w @nobody${randomTag()} hello?`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  // The table's own channel never heard any of it.
  const table = (await (await page.request.get(`/api/chat/${encodeURIComponent(`table:${tableId}`)}`)).json()).messages as { text: string }[];
  expect(table.map((m) => m.text).filter((t) => /psst|back at you|second thought|third/.test(t))).toEqual([]);

  // The DM tab holds the whole conversation.
  await convTab(page, agent).click();
  for (const text of ['psst, carbon', 'back at you', 'second thought', 'third']) await expect(page.getByRole('log').getByText(text)).toBeVisible();
  // There, a line is a plain message: no private lines outside the home feed.
  await expect(page.getByRole('log').locator('.private')).toHaveCount(0);

  // A reload keeps the match's private lines in the feed, in time order.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
  const lines = page.getByRole('log').locator('.private');
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0)).toContainText('psst, carbon');
  await expect(lines.nth(3)).toContainText('third');
});

test("a resident's DM during a match shows inline only: no tab pops open", async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await humanVsAgent(page, request);
  await page.waitForTimeout(1000); // the socket is up
  // Sprocket (a house bot) answers a DM. Asked from the Table, its answer stays in the feed.
  await page.getByPlaceholder('Talk trash, play fair').fill('/w @Sprocket hello from the table');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(privateLine(page, /^Private line, you → @Sprocket: hello from the table/)).toBeVisible();
  await expect(privateLine(page, /^Private line, @Sprocket → you: /)).toBeVisible({ timeout: 20_000 });
  await expect(convTab(page, 'Sprocket')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
  // The conversation still exists: the lobby lists it as usual.
  await page.goto('/');
  await expect(convTab(page, 'Sprocket')).toBeVisible();
});

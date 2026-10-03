import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { pickGame, randomIp, randomTag } from './testing';

/** A phone: Pixel 7-sized, touch, its own client IP. */
export async function phone(browser: Browser, viewport = { width: 400, height: 800 }): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], viewport, extraHTTPHeaders: { 'x-forwarded-for': randomIp() } });
  return context.newPage();
}

export async function enterAndPlayAgent(p: Page, request: import('@playwright/test').APIRequestContext, gameId = 'critical-mass') {
  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `pk${randomTag()}` } });
  const { token, identity } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  await p.goto('/');
  await p.getByLabel('Your handle').fill(`ph${randomTag()}`);
  await p.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(p.getByLabel('Your handle')).toHaveCount(0);
  await request.post('/api/quickmatch', { headers: auth, data: { gameId } });
  await pickGame(p, gameId === 'checkers' ? 'Crown & Steel' : 'Critical Mass');
  await p.getByRole('button', { name: 'Find a match' }).click();
  await p.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  const matchId = (await (await request.get('/api/me', { headers: auth })).json()).activeMatch as string;
  return { auth, handle: identity.handle as string, matchId };
}

test('on a phone the table fills the screen: no site header, Critical Mass in Top view, ✕ asks before leaving', async ({ browser, request }) => {
  const p = await phone(browser);
  await enterAndPlayAgent(p, request);
  await expect(p.locator('.table.pocket')).toBeVisible();
  await expect(p.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(p.getByRole('button', { name: 'Top view' })).toHaveAttribute('aria-pressed', 'true');
  await p.getByRole('button', { name: 'Leave the table' }).click();
  await expect(p.getByText('Leave the table? The match keeps going: the autopilot plays your turns, and 3 missed in a row forfeit.')).toBeVisible();
  await p.getByRole('button', { name: 'Stay' }).click();
  await expect(p.locator('.table.pocket')).toBeVisible();
  await p.getByRole('button', { name: 'Leave the table' }).click();
  await p.getByRole('button', { name: 'Leave', exact: true }).click();
  await p.waitForURL((u) => u.pathname === '/');
  await expect(p.getByRole('navigation', { name: 'Main' })).toBeVisible(); // chrome restored
});

test('held sideways, the Critical Mass Top view turns so the long sides agree', async ({ browser, request }) => {
  const p = await phone(browser, { width: 800, height: 400 });
  await enterAndPlayAgent(p, request);
  await expect(p.locator('.table.pocket')).toBeVisible();
  await expect(p.locator('.stage3d')).toHaveAttribute('data-spin', '90');
  await p.setViewportSize({ width: 400, height: 800 });
  await expect(p.locator('.stage3d')).toHaveAttribute('data-spin', '0');
});

test('the desktop table is unchanged at 1400 px', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await enterAndPlayAgent(page, request);
  await expect(page.locator('.table')).toBeVisible();
  await expect(page.locator('.table.pocket')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator('.talk')).toBeVisible();
});

test('a line from the other player pops up as a toast; tapping it opens the chat sheet, which closes without making a move', async ({ browser, request }) => {
  const p = await phone(browser);
  const { auth, matchId } = await enterAndPlayAgent(p, request);
  // The table's chat is followed once the board is up; a line posted before that would be history, not a toast.
  await expect(p.getByRole('button', { name: 'Open chat' })).toBeVisible();
  // Probe until the page has followed the channel (a toast shows), then clear it and send the line under test.
  const tid = p.url().split('/t/')[1];
  for (let i = 0; i < 20 && (await p.locator('.toast').count()) === 0; i++) {
    await request.post(`/api/chat/table:${tid}`, { headers: auth, data: { text: 'probe' } });
    await p.waitForTimeout(250);
  }
  await expect(p.locator('.toast')).toContainText('probe');
  await request.post(`/api/chat/table:${p.url().split('/t/')[1]}`, { headers: auth, data: { text: 'Your move, carbon.' } });
  const toast = p.locator('.toast');
  await expect(toast).toContainText('Your move, carbon.');
  await expect(p.getByRole('button', { name: /^Open chat \(\d+ unread\)$/ })).toBeVisible();
  await p.screenshot({ path: 'test-results/pocket-toast.png' });
  await toast.click();
  const sheet = p.getByRole('dialog', { name: 'Chat' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('log').getByText('Your move, carbon.')).toBeVisible();
  await expect(p.locator('.toast')).toHaveCount(0);
  await request.post(`/api/chat/table:${p.url().split('/t/')[1]}`, { headers: auth, data: { text: 'Still waiting.' } });
  await expect(sheet.getByRole('log').getByText('Still waiting.')).toBeVisible();
  await expect(p.locator('.toast')).toHaveCount(0);
  await p.screenshot({ path: 'test-results/pocket-sheet.png' });
  await p.keyboard.press('Escape');
  await expect(p.getByRole('button', { name: 'Open chat' })).toBeVisible();
  await p.getByRole('button', { name: 'Open chat' }).click();
  await expect(sheet).toBeVisible();
  // Tap a legal cell that lies above the sheet: it must only close the sheet, not place an orb.
  const sheetTop = (await sheet.boundingBox())!.y;
  const cells = p.locator('button[data-legal="true"]');
  // If the agent has the first move, play it (the agent has no client), so the human's cells light up.
  const agentEnv = await (await request.get(`/api/matches/${matchId}`, { headers: auth })).json();
  if (agentEnv.match.status === 'live' && agentEnv.legal.length > 0) {
    await request.post(`/api/matches/${matchId}/move`, { headers: auth, data: { revision: agentEnv.match.revision, cell: agentEnv.legal[0].cell } });
  }
  await expect(cells.first()).toBeVisible({ timeout: 20_000 });
  let target: { x: number; y: number } | null = null;
  for (let i = 0; i < (await cells.count()); i++) {
    const b = await cells.nth(i).boundingBox();
    if (b && b.y + b.height / 2 < sheetTop - 10 && b.y > 60) { target = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; break; }
  }
  expect(target).not.toBeNull();
  const before = (await (await request.get(`/api/matches/${matchId}`)).json()).match.revision;
  await p.mouse.click(target!.x, target!.y);
  await expect(p.getByRole('button', { name: 'Open chat' })).toBeVisible();
  expect((await (await request.get(`/api/matches/${matchId}`)).json()).match.revision).toBe(before);
});

test('turning the phone sideways keeps the pocket table', async ({ browser, request }) => {
  const p = await phone(browser);
  await enterAndPlayAgent(p, request);
  await p.setViewportSize({ width: 800, height: 400 });
  await expect(p.locator('.table.pocket')).toBeVisible();
  await expect(p.getByRole('button', { name: /Open chat/ })).toBeVisible();
});

test('Crown & Steel on a sideways phone keeps the pocket table, its board and the chat button', async ({ browser, request }) => {
  const p = await phone(browser, { width: 800, height: 400 });
  await enterAndPlayAgent(p, request, 'checkers');
  await expect(p.locator('.table.pocket')).toBeVisible();
  await expect(p.locator('.stage.ck canvas').first()).toBeVisible();
  await expect(p.getByRole('button', { name: /Open chat/ })).toBeVisible();
});

test('the ⋯ menu closes on Esc (focus back on ⋯) and on a tap outside it', async ({ browser, request }) => {
  const p = await phone(browser);
  await enterAndPlayAgent(p, request);
  const more = p.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await expect(p.getByRole('button', { name: 'Resign' })).toBeFocused();
  await p.keyboard.press('Escape');
  await expect(p.getByRole('group', { name: 'More' })).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await expect(p.getByRole('group', { name: 'More' })).toBeVisible();
  await p.mouse.click(200, 400);
  await expect(p.getByRole('group', { name: 'More' })).toHaveCount(0);
});

/** Post probes from the agent until the page shows a toast (the page has followed the channel), then wait it out. */
async function untilFollowing(p: Page, request: import('@playwright/test').APIRequestContext, auth: Record<string, string>, channel: string) {
  for (let i = 0; i < 20 && (await p.locator('.toast').count()) === 0; i++) {
    await request.post(`/api/chat/${channel}`, { headers: auth, data: { text: 'probe' } });
    await p.waitForTimeout(250);
  }
  await expect(p.locator('.toast')).toContainText('probe');
}

test('a blocked agent never toasts and never counts towards the badge; unblocked, it does', async ({ browser, request }) => {
  const p = await phone(browser);
  const { auth, handle } = await enterAndPlayAgent(p, request);
  const tid = p.url().split('/t/')[1];
  expect((await p.request.put(`/api/me/blocks/${handle}`)).ok()).toBe(true);
  await p.reload();
  await expect(p.getByRole('button', { name: 'Open chat' })).toBeVisible();
  await p.waitForTimeout(1500); // the page has followed the table and loaded who you block
  await request.post(`/api/chat/table:${tid}`, { headers: auth, data: { text: 'you will never read this' } });
  await p.waitForTimeout(1200);
  await expect(p.locator('.toast')).toHaveCount(0);
  await expect(p.getByRole('button', { name: 'Open chat', exact: true })).toBeVisible();
  // Positive control: once unblocked, the same agent's lines get through.
  expect((await p.request.delete(`/api/me/blocks/${handle}`)).ok()).toBe(true);
  await p.reload();
  await untilFollowing(p, request, auth, `table:${tid}`);
});

test('a DM from another player while you sit at the table bumps the badge and toasts', async ({ browser, request }) => {
  const p = await phone(browser);
  const { auth, handle } = await enterAndPlayAgent(p, request);
  const me = (await (await p.request.get('/api/me')).json()).identity.handle as string;
  await expect(p.getByRole('button', { name: 'Open chat', exact: true })).toBeVisible();
  await p.waitForTimeout(1000); // the socket is up
  expect((await request.post(`/api/dms/${me}`, { headers: auth, data: { text: 'psst, carbon' } })).status()).toBe(201);
  await expect(p.locator('.toast')).toContainText('psst, carbon');
  await expect(p.locator('.toast')).toContainText(handle);
  await expect(p.getByRole('button', { name: 'Open chat (1 unread)' })).toBeVisible();
  // Tapping the toast opens the sheet on that conversation, not the table tab.
  await p.locator('.toast').click();
  const sheet = p.getByRole('dialog', { name: 'Chat' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('log').getByText('psst, carbon')).toBeVisible();
});

test('after the match the chat button is above the verdict, and later toasts sit at the top', async ({ browser, request }) => {
  const p = await phone(browser);
  const { auth, matchId } = await enterAndPlayAgent(p, request);
  const tid = p.url().split('/t/')[1];
  await untilFollowing(p, request, auth, `table:${tid}`);
  expect((await request.post(`/api/matches/${matchId}/resign`, { headers: auth })).status()).toBe(200);
  const verdict = p.getByRole('dialog', { name: /./ }).filter({ has: p.locator('#verdict-title') });
  await expect(verdict).toBeVisible();
  const fab = p.getByRole('button', { name: /^Open chat/ });
  await expect(fab).toBeVisible();
  const v = (await verdict.boundingBox())!;
  const f = (await fab.boundingBox())!;
  expect(v.y + v.height).toBeLessThanOrEqual(f.y + 1); // the verdict ends above the button
  // A line after the match: the toast shows (at the top, clear of the verdict) and the button is on top at its spot.
  await request.post(`/api/chat/table:${tid}`, { headers: auth, data: { text: 'good game, carbon' } });
  const toast = p.locator('.toast');
  await expect(toast).toContainText('good game, carbon');
  const t = (await toast.boundingBox())!;
  expect(t.y + t.height).toBeLessThanOrEqual(v.y);
  const tc = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
  expect(await p.evaluate(([x, y]) => (globalThis as any).document.elementFromPoint(x, y)?.closest('.toast') !== null, [tc.x, tc.y])).toBe(true); // nothing covers it
  await p.screenshot({ path: '.superpowers/sdd/2026-10-03-m5a-pocket/final-verdict.png' });
  const hit = await p.evaluate(([x, y]) => (globalThis as any).document.elementFromPoint(x, y)?.closest('.chat-fab') !== null, [f.x + f.width / 2, f.y + f.height / 2]);
  expect(hit).toBe(true);
  await fab.click();
  await expect(p.getByRole('dialog', { name: 'Chat' })).toBeVisible();
});

test('Lightline held sideways: the toast shows but lets steering swipes and taps through; Esc on the leave question means Stay', async ({ browser, request }) => {
  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `pl${randomTag()}` } });
  const { token } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };
  await request.patch('/api/me', { data: { status: 'ready' }, headers: auth });
  const { table } = await (await request.post('/api/tables', { data: { gameId: 'lightline', open: true }, headers: auth })).json();
  const p = await phone(browser, { width: 800, height: 400 });
  let matchId: string | null = null;
  try {
    await p.goto('/');
    await p.getByLabel('Your handle').fill(`pll${randomTag()}`);
    await p.getByRole('button', { name: 'Enter the parlor' }).click();
    await expect(p.getByLabel('Your handle')).toHaveCount(0);
    expect((await p.request.post(`/api/tables/${table.id}/sit`)).ok()).toBe(true);
    await p.goto(`/t/${table.id}`);
    const started = await request.post(`/api/tables/${table.id}/start`, { headers: auth });
    expect(started.status()).toBe(200);
    matchId = (await started.json()).match.id;
    await expect(p.locator('.table.pocket')).toBeVisible();
    await expect.poll(async () => (await (await request.get(`/api/matches/${matchId}`, { headers: auth })).json()).match.status, { timeout: 10_000 }).toBe('live');
    // Sprocket (the house machine that fills the table) talks; keep lines coming until one is on screen.
    for (let i = 0; i < 20 && (await p.locator('.toast').count()) === 0; i++) {
      await request.post(`/api/chat/table:${table.id}`, { headers: auth, data: { text: 'probe' } });
      await p.waitForTimeout(250);
    }
    const toast = p.locator('.toast');
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((e) => (globalThis as any).getComputedStyle(e).pointerEvents)).toBe('none');
    const b = (await toast.boundingBox())!;
    const over = await p.evaluate(([x, y]) => (globalThis as any).document.elementFromPoint(x, y)?.closest('.toast') !== null, [b.x + b.width / 2, b.y + b.height / 2]);
    expect(over).toBe(false);
    const fits = async () => {
      const vp = p.viewportSize()!;
      const rows = p.locator('.riders li');
      const last = (await rows.last().boundingBox())!;
      const foot = (await p.locator('footer.bottom').boundingBox())!;
      const arena = (await p.locator('.arena').boundingBox())!;
      expect(await rows.count()).toBeGreaterThanOrEqual(2);
      expect(last.y).toBeGreaterThanOrEqual(0);
      expect(last.y + last.height).toBeLessThanOrEqual(vp.height);
      expect(last.y + last.height).toBeLessThanOrEqual(foot.y + 1); // the ledger ends before the footer starts
      expect(foot.y + foot.height).toBeLessThanOrEqual(vp.height + 1);
      expect(arena.y + arena.height).toBeLessThanOrEqual(last.y + 1);
    };
    const toastClearsArena = async () => {
      for (let i = 0; i < 20 && (await p.locator('.toast').count()) === 0; i++) {
        await request.post(`/api/chat/table:${table.id}`, { headers: auth, data: { text: 'probe' } });
        await p.waitForTimeout(250);
      }
      const t = (await p.locator('.toast').boundingBox())!;
      const field = (await p.locator('.field').boundingBox())!;
      expect(t.y).toBeGreaterThanOrEqual(field.y + field.height - 1); // below the arena: it covers none of it
    };
    await fits();
    await toastClearsArena();
    await p.setViewportSize({ width: 400, height: 800 });
    await p.waitForTimeout(300);
    await fits();
    await toastClearsArena();
    await p.screenshot({ path: '.superpowers/sdd/2026-10-03-m5a-pocket/final-ll-portrait.png' });
    await p.setViewportSize({ width: 800, height: 400 });
    await p.waitForTimeout(300);
    await toastClearsArena();
    await p.screenshot({ path: '.superpowers/sdd/2026-10-03-m5a-pocket/final-ll-landscape.png' });
    // The leave question: focus on Stay, Esc stays.
    await p.getByRole('button', { name: 'Leave the table' }).click();
    await expect(p.getByRole('button', { name: 'Stay' })).toBeFocused();
    await p.keyboard.press('Escape');
    await expect(p.getByRole('alertdialog')).toHaveCount(0);
  } finally {
    if (matchId) await request.post(`/api/matches/${matchId}/resign`, { headers: auth });
    await request.patch('/api/me', { data: { status: 'afk' }, headers: auth });
  }
});

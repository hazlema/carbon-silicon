import { expect, test } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

// A long chat must scroll inside its panel. Screen-reader-only labels in each message are
// absolutely positioned; without a positioned scroll container they escape it and stretch the page.
test('the desktop lobby fits one screen however long the chat gets', async ({ browser }) => {
  for (let n = 0; n < 4; n++) {
    const talker = await newPlayer(browser);
    await enter(talker, `e2e${randomTag()}`);
    for (let i = 0; i < 5; i++) {
      const r = await talker.request.post('/api/chat/lobby', { data: { text: `filler line ${n}.${i}` } });
      expect(r.ok()).toBe(true);
    }
    await talker.context().close();
  }
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enter(page, `e2e${randomTag()}`);
  await expect(page.getByRole('log').getByText('filler line 3.4')).toBeVisible();
  const { scroll, inner } = await page.evaluate(() => {
    const g = globalThis as any;
    return { scroll: g.document.documentElement.scrollHeight as number, inner: g.innerHeight as number };
  });
  expect(scroll).toBeLessThanOrEqual(inner);
});

test('at 400px the lobby chat header stays on one line however many conversations there are', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 400, height: 800 });
  await enter(page, `e2e${randomTag()}`);
  for (let i = 0; i < 3; i++) {
    const other = await newPlayer(browser);
    const handle = `e2e${randomTag()}`;
    await enter(other, handle);
    expect((await page.request.post(`/api/dms/${handle}`, { data: { text: 'hello' } })).ok()).toBe(true);
    await other.context().close();
  }
  await page.reload();
  const nav = page.getByRole('navigation', { name: 'Channels' });
  await expect(nav.getByRole('group', { name: 'Conversations' })).toBeVisible();
  const tops = await nav.evaluate((el) => {
    const visible = [...el.querySelectorAll('button')];
    return [visible[0], visible[visible.length - 1]].map((b) => (b as any).getBoundingClientRect().top as number);
  });
  expect(tops[0]).toBe(tops[1]);
});

test('an agent fetching / over plain HTTP is told where to start', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['link']).toContain('</llms.txt>');
  const html = await res.text();
  expect(html).toContain('href="/llms.txt"');
  // As a fetch tool sees it: tags stripped, CSS ignored.
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  expect(text).toContain('Are you an AI agent? Start with /llms.txt');
});

test('a signed-in page still tells a browser agent where to start, without showing humans', async ({ browser }) => {
  // A browser agent may arrive already signed in, never seeing the name gate's hint.
  const page = await newPlayer(browser);
  await enter(page, `door${randomTag()}`);
  const door = page.locator('#agent-door');
  await expect(door).toHaveCount(1);
  await expect(door.getByRole('link', { name: '/llms.txt' })).toHaveAttribute('href', '/llms.txt');
  // In the accessibility tree (what browser agents read), but 1px and clipped on screen.
  expect(await page.locator('body').ariaSnapshot()).toContain('Are you an AI agent?');
  expect((await door.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
});

test('on a phone the site header is one row: the links and your status sit behind ☰, which closes on a link, Esc or a tap outside; desktop has no ☰', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await enter(page, `hb${randomTag()}`);
  const header = page.locator('header.nav');
  expect((await header.boundingBox())!.height).toBeLessThan(70);
  const menu = page.getByRole('button', { name: 'Menu' });
  const links = page.getByRole('navigation', { name: 'Main' });
  await expect(links).toBeHidden();
  await expect(page.getByRole('group', { name: 'Your status' })).toBeHidden();

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(links).toBeVisible();
  await expect(page.getByRole('group', { name: 'Your status' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(links).toBeHidden();
  await expect(menu).toBeFocused();

  await menu.click();
  await page.locator('main').click({ position: { x: 5, y: 400 } });
  await expect(links).toBeHidden();

  await menu.click();
  await links.getByRole('link', { name: 'Diary' }).click();
  await page.waitForURL(/\/diary$/);
  await expect(links).toBeHidden();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await context.close();

  const desk = await newPlayer(browser);
  await enter(desk, `hd${randomTag()}`);
  await expect(desk.getByRole('button', { name: 'Menu' })).toBeHidden();
  await expect(desk.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(desk.getByRole('group', { name: 'Your status' })).toBeVisible();
});

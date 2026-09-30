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

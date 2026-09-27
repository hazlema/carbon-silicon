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

import { expect, test, type WebSocketRoute } from '@playwright/test';
import { enter, randomTag } from './testing';

test('a stale tab learns a new build shipped when its socket reconnects, and offers a reload', async ({ page }) => {
  let clientSocket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws', (ws) => {
    clientSocket = ws;
    ws.connectToServer(); // pass everything through untouched; we only want a handle to force-close it later
  });

  await enter(page, `e2e${randomTag()}`);
  await expect(page.getByTitle('Reconnecting')).toHaveCount(0);

  // The live-region wrapper is always in the DOM (never `{#if}`-inserted already full), so a screen
  // reader has it registered before there's anything to announce.
  const wrapper = page.getByRole('status');
  await expect(wrapper).toHaveCount(1);
  const banner = wrapper.filter({ hasText: 'Carbon & Silicon was updated.' });
  await expect(banner).toHaveCount(0);

  // It must overlay, not push: the lobby's "Random match" button should not move once the banner
  // appears (a push would shove fixed-height pages like the lobby/table below the fold).
  const findMatch = page.getByRole('button', { name: 'Random match' });
  const beforeBox = await findMatch.boundingBox();

  // The next version check must see a different build.
  await page.route('**/_app/version.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 'e2e-new-build' }) }),
  );

  // Force-close the socket as the page sees it; live.svelte.ts's onclose handler retries the connection,
  // and the reopen (a reconnect) should trigger an immediate version check.
  await clientSocket?.close();
  await expect(page.getByTitle('Reconnecting')).toBeVisible();
  await expect(page.getByTitle('Reconnecting')).toHaveCount(0);

  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible();

  const afterBox = await findMatch.boundingBox();
  expect(afterBox?.y).toBe(beforeBox?.y);

  // Fixed, and above HandleGate's scrim (z-index 20) — an update must stay visible/actionable even
  // while the gate is up.
  const styles = await page.evaluate(() => {
    const g = globalThis as any;
    const el = g.document.querySelector('[role="status"]');
    const cs = g.getComputedStyle(el);
    return { position: cs.position, zIndex: Number(cs.zIndex) };
  });
  expect(styles.position).toBe('fixed');
  expect(styles.zIndex).toBeGreaterThan(20);
});

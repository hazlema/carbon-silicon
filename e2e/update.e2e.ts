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

  const banner = page.getByRole('status').filter({ hasText: 'Carbon & Silicon was updated.' });
  await expect(banner).toHaveCount(0);

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
});

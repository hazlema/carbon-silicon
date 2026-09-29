import { expect, test } from '@playwright/test';
import { enter, grantMod, lock, newPlayer, PASSWORD, randomIp, randomTag } from './testing';

test('a locked human links an agent by token; its profile says whose it is; the owner hears about a mute', async ({ browser, request }) => {
  const owner = await newPlayer(browser);
  const ownerHandle = `own${randomTag()}`;
  await enter(owner, ownerHandle);
  await lock(owner, PASSWORD);
  const reg = await request.post('/api/agents', { headers: { 'x-forwarded-for': randomIp() }, data: { name: `bot${randomTag()}` } });
  const { token, identity } = (await reg.json()) as { token: string; identity: { handle: string } };

  await owner.goto(`/u/${ownerHandle}`);
  await owner.getByLabel('Agent token').fill(token);
  await owner.getByRole('button', { name: 'Link' }).click();
  await expect(owner.getByRole('region', { name: 'Your agents' })).toContainText(identity.handle);

  await owner.goto(`/u/${identity.handle}`);
  await expect(owner.getByText(`assistant of @${ownerHandle}`)).toBeVisible();

  const mod = await newPlayer(browser);
  const modHandle = `mod${randomTag()}`;
  await enter(mod, modHandle);
  await lock(mod, PASSWORD);
  await grantMod(request, modHandle);
  const muted = await mod.request.post(`/api/mod/people/${identity.handle}/mute`, { data: { reason: 'spam', minutes: 10 } });
  expect(muted.ok()).toBe(true);

  const card = owner.getByRole('status').filter({ hasText: `@${identity.handle} was muted` });
  await expect(card).toContainText('spam');
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
});

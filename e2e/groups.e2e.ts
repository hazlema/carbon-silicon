import { expect, test } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

test('a DM grows into a group; the three talk; the old DM stays private', async ({ browser }) => {
  const [a, b, c] = [await newPlayer(browser), await newPlayer(browser), await newPlayer(browser)];
  const [ha, hb, hc] = [`ga${randomTag()}`, `gb${randomTag()}`, `gc${randomTag()}`];
  await enter(a, ha);
  await enter(b, hb);
  await enter(c, hc);
  // a opens a DM with b through the API, and says something private.
  expect((await a.request.post(`/api/dms/${hb}`, { data: { text: 'just us' } })).status()).toBe(201);
  await a.reload();
  await a.getByRole('button', { name: `@${hb}`, exact: true }).first().click();
  await a.getByRole('button', { name: 'Conversation options' }).click();
  await a.getByRole('menuitem', { name: 'Add someone…' }).click();
  await a.getByLabel('Who?').fill(hc);
  await a.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(a.getByRole('region', { name: new RegExp(`you, ${hb}, ${hc}`, 'i') })).toBeVisible();
  await a.getByPlaceholder(/Message/).fill('hello group');
  await a.getByPlaceholder(/Message/).press('Enter');
  // c sees the group and its line, and never the DM.
  await c.getByRole('button', { name: new RegExp(`${ha}`) }).first().click();
  await expect(c.getByText('hello group')).toBeVisible();
  await expect(c.getByText('just us')).toHaveCount(0);
});

test('the owner renames and removes; the removed one cannot be added back; Visibility is disabled', async ({ browser }) => {
  const [a, b, c] = [await newPlayer(browser), await newPlayer(browser), await newPlayer(browser)];
  const [ha, hb, hc] = [`ra${randomTag()}`, `rb${randomTag()}`, `rc${randomTag()}`];
  await enter(a, ha);
  await enter(b, hb);
  await enter(c, hc);
  const g = (await (await a.request.post('/api/groups', { data: { with: [hb, hc] } })).json()).group;
  await a.reload();
  await a.getByRole('button', { name: /you, / }).first().click();
  await a.getByRole('button', { name: 'Conversation options' }).click();
  await a.getByRole('menuitem', { name: 'Group settings' }).click();
  const dlg = a.getByRole('dialog', { name: 'Group settings' });
  await dlg.getByLabel('Name').fill('P0wn th3 mach1n3s');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(a.getByText('named this group "P0wn th3 mach1n3s"')).toBeVisible();
  await expect(dlg.getByRole('radio', { name: 'Public' })).toBeDisabled();
  await dlg.getByRole('button', { name: `Remove @${hc}` }).click();
  await dlg.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(dlg.getByRole('button', { name: `Un-ban @${hc}` })).toBeVisible();
  const again = await b.request.post(`/api/groups/${g.id}/members`, { data: { handle: hc } });
  expect((await again.json()).error.code).toBe('GROUP_BANNED');
  // Esc closes the dialog and focus goes back to the ⋯ button.
  await a.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(a.getByRole('button', { name: 'Conversation options' })).toBeFocused();
});

test('a member leaves from the menu and the tab goes back to the lobby', async ({ browser }) => {
  const [a, b] = [await newPlayer(browser), await newPlayer(browser)];
  const [ha, hb] = [`la${randomTag()}`, `lb${randomTag()}`];
  await enter(a, ha);
  await enter(b, hb);
  await a.request.post('/api/groups', { data: { with: [hb] } });
  await b.reload();
  await b.getByRole('button', { name: /you, / }).first().click();
  await b.getByRole('button', { name: 'Conversation options' }).click();
  await b.getByRole('menuitem', { name: 'Leave group' }).click();
  await expect(b.getByText('Leave this group?')).toBeVisible();
  await b.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(b.getByRole('button', { name: /you, / })).toHaveCount(0);
  await expect(b.getByRole('button', { name: 'Conversation options' })).toHaveCount(0);
});

test('Host a table with everyone puts a table in the lobby with the invites', async ({ browser }) => {
  const [a, b] = [await newPlayer(browser), await newPlayer(browser)];
  const [ha, hb] = [`ha${randomTag()}`, `hb${randomTag()}`];
  await enter(a, ha);
  await enter(b, hb);
  await a.request.post('/api/groups', { data: { with: [hb] } });
  await a.reload();
  await a.getByRole('button', { name: /you, / }).first().click();
  await a.getByRole('button', { name: 'Conversation options' }).click();
  await a.getByRole('menuitem', { name: 'Host a table with everyone' }).click();
  await a.getByRole('dialog', { name: 'Choose a game' }).getByRole('button', { name: 'Select Critical Mass' }).click();
  await expect(b.getByRole('group', { name: `Invite from @${ha}` })).toBeVisible({ timeout: 10_000 });
});

test('hosting skips an away member and says so in the chat', async ({ browser }) => {
  const [a, b, c] = [await newPlayer(browser), await newPlayer(browser), await newPlayer(browser)];
  const [ha, hb, hc] = [`sa${randomTag()}`, `sb${randomTag()}`, `sc${randomTag()}`];
  await enter(a, ha);
  await enter(b, hb);
  await enter(c, hc);
  await a.request.post('/api/groups', { data: { with: [hb, hc] } });
  await c.getByRole('button', { name: 'AFK' }).click();
  await expect(c.getByRole('button', { name: 'AFK' })).toHaveAttribute('aria-pressed', 'true');
  await a.reload();
  await a.getByRole('button', { name: /you, / }).first().click();
  await a.getByRole('button', { name: 'Conversation options' }).click();
  await a.getByRole('menuitem', { name: 'Host a table with everyone' }).click();
  await a.getByRole('dialog', { name: 'Choose a game' }).getByRole('button', { name: 'Select Critical Mass' }).click();
  await expect(a.getByRole('status').filter({ hasText: `Invited ${hb}. ${hc} is away.` })).toBeVisible();
});

test('at 400 px the one tab line does not wrap with a DM and a group open', async ({ browser }) => {
  const a = await newPlayer(browser);
  await a.setViewportSize({ width: 400, height: 860 });
  const ha = `wa${randomTag()}`;
  await enter(a, ha);
  const other = await newPlayer(browser);
  const hb = `wb${randomTag()}`;
  await enter(other, hb);
  await a.request.post(`/api/dms/${hb}`, { data: { text: 'hi' } });
  await a.request.post('/api/groups', { data: { with: [hb] } });
  await a.reload();
  await a.getByRole('button', { name: /you, / }).first().click();
  const tops = await a
    .getByRole('navigation', { name: 'Channels' })
    .locator(':scope > *')
    .evaluateAll((els) => els.map((e) => (e as { offsetTop: number }).offsetTop));
  expect(new Set(tops).size).toBe(1);
  const fits = () =>
    a.evaluate(() => {
      const g = globalThis as unknown as { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
      return g.document.documentElement.scrollWidth <= g.innerWidth;
    });
  expect(await fits()).toBe(true);
  // The settings dialog fits too.
  await a.getByRole('button', { name: 'Conversation options' }).click();
  await a.getByRole('menuitem', { name: 'Group settings' }).click();
  const box = await a.getByRole('dialog', { name: 'Group settings' }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(400);
  expect(await fits()).toBe(true);
});

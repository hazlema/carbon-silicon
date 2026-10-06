import { expect, test } from '@playwright/test';
import { enter, newPlayer, pickGame, randomTag } from './testing';

type Envelope = {
  you: string | null;
  match: { status: string; seats: { seat: string; identity: { handle: string } }[] };
  view: {
    round: number;
    phase: string;
    guns: Record<string, number>;
    lastVolley: { round: number; shells: { from: string; sea: string; cell: string; result: string }[]; buoys: { from: string; sea: string; cell: string }[] } | null;
  };
};

test('Salvo: a human deploys at random, fires a whole salvo, and the volley carries every shell', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await enter(page, `salvo${randomTag()}`);
  await pickGame(page, 'Salvo');
  await page.getByRole('button', { name: 'Host a table' }).click();
  // Salvo seats free house machines at Start: in the e2e house, that's Sprocket.
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled({ timeout: 10_000 });
  await start.click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });

  const tableId = page.url().split('/t/')[1];
  let matchId = '';
  await expect
    .poll(async () => (matchId = (await (await page.request.get(`/api/tables/${tableId}`)).json()).table.matchId ?? ''), { timeout: 10_000 })
    .not.toBe('');
  const envelope = async (): Promise<Envelope> => (await page.request.get(`/api/matches/${matchId}`)).json();
  const first = await envelope();
  const me = first.you!;
  const sprocket = first.match.seats.find((s) => s.identity.handle === 'Sprocket')?.seat;
  expect(sprocket, 'Sprocket takes the other seat').toBeTruthy();

  // Deployment: Random places the whole fleet. Sprocket may commit in the same instant; a stale revision
  // only means the page refetches, so press again until the fleet is down.
  await expect(page.getByText('Place your fleet')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sv-round')).toHaveText('deploying');
  const random = page.getByTestId('random');
  await expect(async () => {
    if ((await random.count()) > 0 && (await random.isEnabled())) await random.click();
    await expect(page.getByText('Round 1 — your salvo: 4 shots.')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId('sv-round')).toHaveText('round 1');
  // Your own fleet is on your sea: twelve ship cells.
  await expect(page.locator(`[data-sea="${me}"] [data-mark="ship"]`)).toHaveCount(12);

  // Sprocket commits within a blink; once its chip says ready, the human's shot resolves the round.
  await expect(page.locator(`.chip[data-seat="${sprocket}"]`)).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
  // Its card is stamped "locked in", and the status line tells you you're the last one owing.
  await expect(page.locator(`.chip[data-seat="${sprocket}"] .state`)).toHaveText('locked in');
  await expect(page.getByText('Everyone else is locked in.')).toBeVisible();
  const sea = page.locator('[data-main]');
  await expect(sea).toHaveAttribute('data-sea', sprocket!);
  // One shot per ship afloat: four guns each, on every card and in the fire control.
  await expect(page.locator(`.chip[data-seat="${sprocket}"] [data-testid="guns"]`)).toHaveAttribute('data-guns', '4');
  await expect(page.getByTestId('shots')).toHaveAttribute('aria-label', '0 sent, 0 aimed, 4 to aim');
  const salvo = ['e5', 'c3', 'f6', 'b7'];
  const cell = sea.locator('[data-cell="e5"]');
  await expect(cell).toHaveAttribute('aria-disabled', 'false');
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  await sea.locator('[data-cell="c3"]').click();
  await expect(page.getByTestId('fire')).toHaveText('Fire 2 of 4');
  // A second click takes an aim back.
  await sea.locator('[data-cell="c3"]').click();
  await expect(sea.locator('[data-cell="c3"]')).toHaveAttribute('aria-pressed', 'false');
  for (const c of salvo.slice(1)) await sea.locator(`[data-cell="${c}"]`).click();
  await expect(page.getByTestId('fire')).toHaveText('Fire 4 shells');
  await expect(page.locator(`.chip[data-seat="${sprocket}"] [data-testid="aimed"]`)).toHaveText('4');
  // The salvo is full: the rest of the sea takes no more aims.
  await expect(sea.locator('[data-cell="a1"]')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('fire').click();
  // Before anything flies, you're warned what's coming at your sea, and from whom (Sprocket's salvo may hold a sonar buoy); then round 2 is called.
  await expect(page.getByTestId('banner')).toHaveText(/^⚠ \d shells? incoming on your sea — from Sprocket( · 1 sonar buoy)?$/, { timeout: 10_000 });
  await expect(page.getByTestId('banner')).toHaveText('Round 2 — fire!', { timeout: 10_000 });

  // The resolved volley, read back from the server, holds all four shells from you, and Sprocket's salvo at you.
  await expect
    .poll(async () => (await envelope()).view.lastVolley?.round ?? 0, { timeout: 10_000 })
    .toBe(1);
  const volley = (await envelope()).view.lastVolley!;
  const mine = volley.shells.filter((x) => x.from === me);
  expect(mine).toHaveLength(4);
  for (const c of salvo) expect(mine).toContainEqual(expect.objectContaining({ from: me, sea: sprocket, cell: c }));
  expect([...volley.shells, ...volley.buoys].filter((x) => x.from === sprocket && x.sea === me)).toHaveLength(4);
  await expect(page.getByTestId('sv-round')).toHaveText('round 2');
  await expect(cell).toHaveAttribute('aria-label', /^e5, (miss|hit|sunk \w+)$/);
  await expect(cell).toHaveAttribute('aria-disabled', 'true');

  // Round 2: part of the salvo first (the rest stays owed), then a sonar buoy and shells for the rest.
  await expect(page.locator(`.chip[data-seat="${sprocket}"]`)).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
  const guns = (await envelope()).view.guns[me];
  expect(guns).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(`Round 2 — your salvo: ${guns} shots.`)).toBeVisible();
  await sea.locator('[data-cell="a1"]').click();
  await expect(page.getByTestId('fire')).toHaveText(`Fire 1 of ${guns}`);
  await page.getByTestId('fire').click();
  await expect(page.getByText(`Round 2 — 1 of ${guns} shots sent.`)).toBeVisible({ timeout: 10_000 });
  await expect(sea.locator('[data-cell="a1"] [data-testid="sent"]')).toHaveCount(1);
  await expect(sea.locator('[data-cell="a1"]')).toHaveAttribute('aria-disabled', 'true');
  // A buoy's centres are b2..g7; one a round, so the toggle greys once it's aimed.
  await page.getByTestId('kind-buoy').click();
  await expect(page.getByTestId('kind-buoy')).toHaveAttribute('aria-pressed', 'true');
  await expect(sea.locator('[data-cell="a8"]')).toHaveAttribute('aria-disabled', 'true');
  const centreCell = sea.locator('[data-cell="d4"]');
  await expect(centreCell).toHaveAttribute('aria-disabled', 'false');
  await centreCell.click();
  await expect(page.getByTestId('kind-buoy')).toBeDisabled();
  const rest = ['h8', 'a8', 'h1'].slice(0, guns - 2);
  for (const c of rest) await sea.locator(`[data-cell="${c}"]`).click();
  await expect(page.getByTestId('fire')).toHaveText(rest.length ? `Fire ${rest.length} shell${rest.length === 1 ? '' : 's'} + buoy` : 'Drop buoy');
  await page.getByTestId('fire').click();
  await expect(page.getByTestId('banner')).toHaveText('Round 3 — fire!', { timeout: 10_000 });
  await expect.poll(async () => (await envelope()).view.lastVolley?.round ?? 0, { timeout: 10_000 }).toBe(2);
  const second = (await envelope()).view.lastVolley!;
  expect(second.buoys).toContainEqual({ from: me, sea: sprocket, cell: 'd4' });
  expect(second.shells.filter((x) => x.from === me).map((x) => x.cell).sort()).toEqual(['a1', ...rest].sort());
  // The reading: a count over the buoy's centre, on that sea alone.
  await expect(sea.locator('[data-testid="sonar"][data-at="d4"]')).toHaveText(/^[0-9]$/);
  await expect(centreCell).toHaveAttribute('aria-label', /sonar buoy: \d afloat around it$/);

  // A phone: the board fits, nothing scrolls sideways, and the target sea's cells are big enough to tap.
  await page.setViewportSize({ width: 400, height: 860 });
  await expect(page.locator('[data-main]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await page.locator('[data-main] [data-cell="a1"]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(42);
  const { scroll, inner } = await page.evaluate(() => {
    const g = globalThis as any;
    return { scroll: g.document.documentElement.scrollWidth as number, inner: g.innerWidth as number };
  });
  expect(scroll, 'nothing scrolls sideways').toBeLessThanOrEqual(inner);
  const box = (await page.locator('[data-main]').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(400);
  await expect(page.getByTestId('fire')).toBeInViewport();

  // Free the house: a live match would keep Sprocket booked for the rest of the suite.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('heading', { name: 'You lose.' })).toBeVisible({ timeout: 10_000 });
});

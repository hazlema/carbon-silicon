import { expect, test, type Page } from '@playwright/test';
import { enter, newPlayer, pickGame, randomTag } from './testing';

/**
 * The battlefield is a WebGL canvas: squares have no DOM handles, so the test clicks real
 * points on a grid over the board and reads the turn banner to know what it hit. Every
 * round trip costs ~0.1 s while the knights animate, so clicks are spent carefully.
 */
type Point = { x: number; y: number };
async function grid(page: Page, step: number): Promise<Point[]> {
  const box = (await page.locator('#battlefield canvas').boundingBox())!;
  const points: Point[] = [];
  for (let gy = 2; gy < 22; gy += step) {
    for (let gx = 2; gx < 30; gx += step) points.push({ x: box.x + (gx * box.width) / 32, y: box.y + (gy * box.height) / 24 });
  }
  return points;
}

/** The banner's help line and the chronicle's march count, in one round trip through the shadow root. */
async function read(page: Page): Promise<{ selected: boolean; marches: number }> {
  return page.locator('.ck-stack').evaluate((el) => ({
    selected: /selected/i.test(el.querySelector('#turn-help')?.textContent ?? ''),
    marches: Number.parseInt(el.querySelector('#history-count')?.textContent ?? '', 10),
  }));
}

test('Crown & Steel: clicking a knight and then a gold square submits the march', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  const handle = `crown${randomTag()}`;
  await enter(page, handle);
  await pickGame(page, 'Crown & Steel');
  await page.getByRole('button', { name: 'Host a table' }).click();
  await expect(page.getByText('Click a name to invite them.')).toBeVisible();
  const here = page.getByRole('region', { name: /Here now/ });
  await here.getByRole('button', { name: /Sprocket/ }).click();
  await page.getByRole('menuitem', { name: 'Invite to Crown & Steel' }).click();
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled({ timeout: 10_000 });
  await start.click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });

  // Whoever drew red moves first; wait until it's the host's turn.
  const help = page.locator('#turn-help');
  await expect(help).toHaveText(/Select a knight/, { timeout: 30_000 });

  // The armies carry their real commanders, not the house names. Seats are shuffled at the start.
  const mine = (await page.locator('#red-role').textContent())?.endsWith('· you') ? 'red' : 'blue';
  const theirs = mine === 'red' ? 'blue' : 'red';
  await expect(page.locator(`#${mine}-name`)).toHaveText(handle);
  await expect(page.locator(`#${mine}-role`)).toHaveText(/· you$/);
  await expect(page.locator(`#${theirs}-name`)).toHaveText('Sprocket');
  await expect(page.locator(`#${theirs}-role`)).toHaveText(/· house machine$/);

  // The stacked layout gives the field most of the screen: no side columns squeezing it.
  const field = (await page.locator('#battlefield canvas').boundingBox())!;
  expect(field.height, 'the battlefield should take most of the viewport height').toBeGreaterThan(900 * 0.6);
  const { scroll, inner } = await page.evaluate(() => {
    const g = globalThis as any;
    return { scroll: g.document.documentElement.scrollHeight as number, inner: g.innerHeight as number };
  });
  expect(scroll, 'no page scroll').toBeLessThanOrEqual(inner);

  // Growing then shrinking the window must shrink the field too: the canvas never props the stage open.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await page.locator('#battlefield canvas').boundingBox())!.height).toBeGreaterThan(field.height);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(async () => { const b = (await page.locator('#battlefield canvas').boundingBox())!; return b.y + b.height; }).toBeLessThan(768);
  await expect(page.locator('#blue-name')).toBeVisible();
  expect((await page.locator('#blue-name').boundingBox())!.width, 'names survive a narrower stage').toBeGreaterThan(40);
  await page.setViewportSize({ width: 1400, height: 900 });

  // First sweep: select any knight that can march. Knights stand tall; a coarse grid finds one.
  let knight: Point | null = null;
  for (const point of await grid(page, 2)) {
    await page.mouse.click(point.x, point.y);
    if ((await read(page)).selected) {
      knight = point;
      break;
    }
  }
  expect(knight, 'a knight should be selectable by clicking it').not.toBeNull();

  // Second sweep: hit one of its gold destinations, nearest squares first; the whole turn posts and
  // the chronicle grows. Blue's host finds Sprocket's opening already on the record: count from here.
  // A click on plain ground drops the selection, so pick the knight up again whenever it falls.
  const before = (await read(page)).marches;
  const near = (await grid(page, 1)).sort(
    (a, b) => Math.hypot(a.x - knight!.x, a.y - knight!.y) - Math.hypot(b.x - knight!.x, b.y - knight!.y),
  );
  let marched = false;
  for (const point of near.slice(1, 160)) {
    await page.mouse.click(point.x, point.y);
    const now = await read(page);
    if (now.marches > before) {
      marched = true;
      break;
    }
    if (!now.selected) await page.mouse.click(knight!.x, knight!.y);
  }
  expect(marched, 'clicking a gold square should submit the move').toBe(true);

  // Free the house: a live match would keep Sprocket booked for the rest of the suite.
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('button', { name: 'Rematch' })).toBeVisible({ timeout: 10_000 });
});

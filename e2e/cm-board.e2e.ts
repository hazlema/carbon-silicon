import { expect, test, type Page } from '@playwright/test';
import { enter, newPlayer, pickGame, randomTag } from './testing';

let open: Page | null = null;
// A test that fails before it resigns would keep Sprocket booked and sink every test after it.
test.afterEach(async () => {
  const page = open;
  open = null;
  if (!page) return;
  const resignBtn = page.getByRole('button', { name: 'Resign' });
  if (await resignBtn.isVisible().catch(() => false)) {
    await resignBtn.click().catch(() => {});
    await page.getByRole('button', { name: 'Yes, resign' }).click({ timeout: 3000 }).catch(() => {});
    await page.getByRole('button', { name: 'Rematch' }).waitFor({ timeout: 5000 }).catch(() => {});
  }
});

/** Each test is its own guest from its own address: the server caps new names per IP, and the
 *  `page` fixture shares 127.0.0.1 with every other suite. */
async function startMatch(page: Page) {
  open = page;
  await enter(page, `iso${randomTag()}`);
  await pickGame(page);
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
}
async function myTurn(page: Page) {
  await expect(page.locator('button[data-legal="true"]').first()).toBeVisible({ timeout: 20_000 });
}
/** End the match, unless Sprocket already has (an early chain can take your only orb). */
async function resign(page: Page) {
  const verdict = page.getByRole('heading', { name: /^(You win\.|You lose\.|Draw\.)$/ });
  try {
    await page.getByRole('button', { name: 'Resign' }).click({ timeout: 5000 });
    await page.getByRole('button', { name: 'Yes, resign' }).click({ timeout: 5000 });
  } catch {
    // Over already: the verdict below says so.
  }
  await expect(verdict).toBeVisible();
}
const stage = (page: Page) => page.locator('.stage3d');
const totalOrbs = (page: Page) =>
  page.locator('button[data-cell]').evaluateAll((els) => els.reduce((n, el) => n + Number((el as any).dataset.orbs), 0));

test('the view pill turns the board, and a click still lands on the cell under the pointer', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  await expect(stage(page)).toHaveAttribute('data-spin', '-35');
  await expect(stage(page)).toHaveAttribute('data-tilt', '55');
  const view = page.getByRole('toolbar', { name: 'Board view' });
  await view.getByRole('button', { name: 'Top view' }).click();
  await expect(stage(page)).toHaveAttribute('data-tilt', '0');
  await view.getByRole('button', { name: 'Rotate left 90°' }).click();
  await view.getByRole('button', { name: 'Rotate left 90°' }).click();
  await view.getByRole('button', { name: 'Rotate left 90°' }).click();
  await expect(stage(page)).toHaveAttribute('data-spin', '-270');
  await myTurn(page);
  // An empty legal cell: after our click it holds an orb of ours.
  const target = page.locator('button[data-legal="true"][data-orbs="0"]').first();
  const name = (await target.getAttribute('data-cell'))!;
  await target.click();
  await expect(page.locator(`button[data-cell="${name}"]`)).not.toHaveAttribute('data-orbs', '0');
  await view.getByRole('button', { name: 'Isometric view' }).click();
  await expect(stage(page)).toHaveAttribute('data-spin', '-35');
  await resign(page);
});

test('a swivel that ends over a cell places nothing, and tilt stays within 0–70°', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  await myTurn(page);
  const before = await totalOrbs(page);
  const cell = (await page.locator('button[data-legal="true"]').first().boundingBox())!;
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await page.mouse.down();
  await page.mouse.move(cell.x + cell.width / 2 + 200, cell.y + cell.height / 2 - 400, { steps: 8 });
  // Mid-swivel: the board has turned, and an upward drag can't tilt it past 70°.
  expect(Number(await stage(page).getAttribute('data-spin'))).toBeCloseTo(-35 + 200 * 0.4, 1);
  expect(Number(await stage(page).getAttribute('data-tilt'))).toBe(70);
  // Back to where it started, so the release lands on the very cell the press began on.
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect(await totalOrbs(page)).toBe(before);
  await resign(page);
});

test('a resized window refits the board: every cell stays inside the stage', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  for (const size of [{ width: 1920, height: 1080 }, { width: 1024, height: 700 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    const s = (await stage(page).boundingBox())!;
    for (const b of await page.locator('button[data-cell]').evaluateAll((els) => els.map((el) => (el as any).getBoundingClientRect().toJSON()))) {
      expect(b.left).toBeGreaterThanOrEqual(s.x - 1);
      expect(b.right).toBeLessThanOrEqual(s.x + s.width + 1);
      expect(b.top).toBeGreaterThanOrEqual(s.y - 1);
      expect(b.bottom).toBeLessThanOrEqual(s.y + s.height + 1);
    }
  }
  await resign(page);
});

test('every cell is hittable at its own centre, at Iso and from the top', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  const misses = () =>
    page.evaluate(() => {
      const d = (globalThis as any).document;
      return [...d.querySelectorAll('button[data-cell]')].flatMap((b: any) => {
        const r = b.getBoundingClientRect();
        const hit = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button');
        return hit === b ? [] : [b.dataset.cell];
      });
    });
  expect(await misses()).toEqual([]);
  await page.getByRole('toolbar', { name: 'Board view' }).getByRole('button', { name: 'Top view' }).click();
  expect(await misses()).toEqual([]);
  await resign(page);
});

test('the sound toggle starts off and is remembered', async ({ browser }) => {
  const page = await newPlayer(browser);
  await startMatch(page);
  const sound = page.getByRole('toolbar', { name: 'Board view' }).getByRole('button', { name: 'Sound' });
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('toolbar', { name: 'Board view' }).getByRole('button', { name: 'Sound' })).toHaveAttribute('aria-pressed', 'true');
  await resign(page);
});

test('players sit in corner cards; the seat to move shows the clock', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  await myTurn(page);
  const cards = page.locator('.seat[data-seat]');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('you');
  await expect(cards.first().locator('.clock')).toBeVisible();
  await expect(cards.nth(1)).toContainText('waiting');
  await resign(page);
});

test('at 400 px the board fits and the cards never cover a cell', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 400, height: 860 });
  await startMatch(page);
  const { scroll, inner } = await page.evaluate(() => {
    const g = globalThis as any;
    return { scroll: g.document.documentElement.scrollWidth as number, inner: g.innerWidth as number };
  });
  expect(scroll).toBeLessThanOrEqual(inner);
  const cards = await page.locator('.seat[data-seat]').evaluateAll((els) => els.map((el) => (el as any).getBoundingClientRect().toJSON()));
  const cells = await page.locator('button[data-cell]').evaluateAll((els) => els.map((el) => (el as any).getBoundingClientRect().toJSON()));
  for (const c of cards) for (const b of cells) {
    const overlap = c.left < b.right && b.left < c.right && c.top < b.bottom && b.top < c.bottom;
    expect(overlap, 'a card covers a cell').toBe(false);
  }
  await resign(page);
});

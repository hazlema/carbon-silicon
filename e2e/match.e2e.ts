import { expect, test } from '@playwright/test';

test('quick match seats a human against Sprocket and the game plays to a verdict', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${Math.random().toString(36).slice(2, 8)}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/play\/m_/, { timeout: 20_000 });
  await expect(page.getByText('Sprocket').first()).toBeVisible();

  const verdict = page.getByRole('heading', { name: /^(You win\.|You lose\.|Draw\.)$/ });
  for (let i = 0; i < 400; i++) {
    if (await verdict.isVisible()) break;
    const cell = page.locator('button[data-legal="true"]').first();
    try {
      await cell.click({ timeout: 3000 });
    } catch {
      // not our turn yet
    }
  }
  await expect(verdict).toBeVisible();
  await expect(page.getByRole('log').filter({ hasText: /wins|Draw/ }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Back to the lobby' }).click();
  await expect(page).toHaveURL('/');
});

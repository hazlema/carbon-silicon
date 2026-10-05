import { expect, test } from '@playwright/test';
import { enter, newPlayer, pickGame, randomTag } from './testing';

test('the Play panel: choose a game (it is remembered), cancel it, or take a random match', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `pp${randomTag()}`);
  const play = page.getByRole('region', { name: 'Play' });

  // The chooser shows every game with its picture, and closes with Esc.
  await play.getByRole('button', { name: 'Select game' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose a game' });
  await expect(chooser.getByRole('heading', { name: 'Critical Mass' })).toBeVisible();
  await expect(chooser.getByRole('heading', { name: 'Lightline' })).toBeVisible();
  await expect(chooser.getByRole('link', { name: 'Rules' }).first()).toHaveAttribute('href', '/games#critical-mass');
  await page.keyboard.press('Escape');
  await expect(chooser).toBeHidden();

  // A pick fills the panel with the ways to play it, and survives a reload.
  await pickGame(page);
  await expect(play.getByRole('button', { name: 'Host a table' })).toBeVisible();
  await expect(play.getByRole('button', { name: 'Find a match' })).toBeVisible();
  await page.reload();
  await expect(play.getByRole('heading', { name: 'Critical Mass' })).toBeVisible();

  // Cancel game puts the two starting buttons back.
  await play.getByRole('button', { name: 'Cancel game' }).click();
  await expect(play.getByRole('button', { name: 'Select game' })).toBeVisible();

  // Random match picks a game people can play and finds an opponent (a house machine, here).
  await play.getByRole('button', { name: 'Random match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  // Either game can come up now; the table shows its own name.
  await expect(page.getByRole('region', { name: /Critical Mass|Lightline|Crown & Steel|Salvo/ }).first()).toBeVisible();
  // Resign, so the house machine is free for the tests after this one.
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('heading', { name: 'You lose.' })).toBeVisible();
});

test('starting a match clears the pick: back in the lobby, the Play panel starts fresh', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `pc${randomTag()}`);
  const play = page.getByRole('region', { name: 'Play' });
  await pickGame(page);
  await play.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('heading', { name: 'You lose.' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the lobby' }).click();
  await expect(page).toHaveURL('/');
  await expect(play.getByRole('button', { name: 'Select game' })).toBeVisible();
  // And it stays cleared after a reload: the browser forgot it too.
  await page.reload();
  await expect(play.getByRole('button', { name: 'Select game' })).toBeVisible();
});

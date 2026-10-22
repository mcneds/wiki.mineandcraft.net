import { test, expect } from '@playwright/test';

test('home, player roster, and mobile navigation work', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('mineandcraft.net — The server wiki');
  await expect(page.locator('.profile-grid a')).toHaveCount(14);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `test-results/home-${testInfo.project.name}.png`, fullPage: true });
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect(page.locator('#site-sidebar')).toBeVisible();
    await page.locator('#site-sidebar').getByRole('link', { name: 'Players', exact: true }).click();
  } else await page.getByRole('link', { name: 'Meet everyone' }).click();
  await expect(page.locator('.player-card')).toHaveCount(14);
  await page.locator('.player-card').filter({ hasText: 'uaiden' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('uaiden');
  await expect(page.locator('.player-head')).toBeVisible();
  expect(await page.locator('.player-head').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});

test('production search finds recipes, commands, and players', async ({ page }) => {
  for (const [query, title] of [['leather', 'Crafting tweaks'], ['sethome', 'Homes & teleporting'], ['uaiden', 'uaiden']]) {
    await page.goto(`/search/?q=${query}`);
    await expect(page.locator('.search-results').getByRole('link', { name: title, exact: true })).toBeVisible();
  }
  await page.locator('#search-query').fill('zzzzunfindablewordzzzz');
  await page.locator('#wiki-search').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.search-status')).toContainText('No results');
  await expect(page.locator('.search-results li')).toHaveCount(0);
});

test('theme preference persists and server address can be copied', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch to dark appearance' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: /Copy server address/ }).click();
  await expect(page.locator('.copy-status')).toHaveText('Server address copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('mineandcraft.net');
});

test('article contents, readable source, and empty Lore are honest', async ({ page }) => {
  await page.goto('/wiki/travel/');
  await page.locator('.contents').getByRole('link', { name: 'Set a home', exact: true }).click();
  await expect(page).toHaveURL(/#set-a-home$/);
  const source = await page.request.get('/source/travel.txt');
  expect(source.ok()).toBeTruthy();
  expect(await source.text()).toContain('/trigger sethome');
  await page.goto('/lore/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lore');
  await expect(page.locator('.empty-chronicle')).toContainText('No events or stories');
  await page.goto('/this-page-does-not-exist/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText("There isn't a page here");
});

test('long recipe tables stay within the page and guide layout is readable', async ({ page }, testInfo) => {
  await page.goto('/wiki/recipe-reference/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recipe reference');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto('/wiki/travel/');
  await page.screenshot({ path: `test-results/article-${testInfo.project.name}.png`, fullPage: true });
  const commandColor = await page.locator('.article-body pre span').first().evaluate(element => getComputedStyle(element).color);
  expect(commandColor).toBe(await page.evaluate(() => getComputedStyle(document.body).color));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

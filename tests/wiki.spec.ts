import { test, expect } from '@playwright/test';

test('home, player roster, and mobile navigation work', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('mineandcraft.net — The server wiki');
  await expect(page.locator('.profile-grid a')).toHaveCount(14);
  const roster = await page.getByRole('region', { name: 'The people of mineandcraft.net' }).boundingBox();
  const main = await page.locator('#main-content').boundingBox();
  expect(roster).not.toBeNull();
  expect(main).not.toBeNull();
  expect(Math.abs(roster!.width - main!.width)).toBeLessThan(2);
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

test('theme preference persists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch to dark appearance' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
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

test('recipe reference stays within the page and guide layout is readable', async ({ page }, testInfo) => {
  await page.goto('/wiki/recipe-reference/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recipe reference');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto('/wiki/travel/');
  await page.screenshot({ path: `test-results/article-${testInfo.project.name}.png`, fullPage: true });
  const commandColor = await page.locator('.article-body pre span').first().evaluate(element => getComputedStyle(element).color);
  expect(commandColor).toBe(await page.evaluate(() => getComputedStyle(document.body).color));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('recipe grids show ingredient positions, outputs, and furnace processing', async ({ page }, testInfo) => {
  await page.goto('/wiki/crafting-tweaks/');
  const stairs = page.locator('[data-recipe-id="minecraft:oak_stairs"]');
  await expect(stairs.locator('.crafting-grid .recipe-slot:not(.empty)')).toHaveCount(6);
  const occupied = await stairs.locator('.crafting-grid .recipe-slot').evaluateAll(slots => slots.flatMap((slot, index) => slot.querySelector('img') ? [index] : []));
  expect(occupied).toEqual([0, 3, 4, 6, 7, 8]);
  await expect(stairs.locator('.recipe-output .recipe-count')).toHaveText('8');
  const apple = page.locator('[data-recipe-id="craftable_notch_apples:notch_apple"]');
  await expect(apple.locator('.crafting-grid').getByRole('img', { name: 'Gold Block', exact: true })).toHaveCount(8);
  await expect(apple.locator('.crafting-grid .recipe-slot').nth(4).getByRole('img')).toHaveAttribute('alt', 'Apple');
  const furnace = page.locator('[data-recipe-id="rotten_flesh_to_leather:leather"]');
  await expect(furnace.locator('.crafting-grid')).toHaveCount(0);
  await expect(furnace).toHaveAccessibleName(/^Furnace:/);
  await expect(furnace.locator('.recipe-output img')).toHaveAttribute('alt', 'Leather');
  await page.locator('.recipe-item').evaluateAll(images => images.forEach(image => (image as HTMLImageElement).loading = 'eager'));
  await expect.poll(() => page.locator('.recipe-item').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBeTruthy();
  await stairs.screenshot({ path: `test-results/stairs-${testInfo.project.name}.png` });
  await apple.screenshot({ path: `test-results/apple-${testInfo.project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto('/wiki/recipe-reference/');
  await expect(page.locator('.recipe-card')).toHaveCount(409);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto('/wiki/building/');
  await expect(page.locator('[data-recipe-id="conversion:cauldron-concrete"] .crafting-grid')).toHaveCount(0);
  await expect(page.locator('[data-recipe-id="conversion:cauldron-concrete"]')).toHaveAccessibleName(/^Drop into a water cauldron:/);
  await page.goto('/wiki/chunk-loaders/');
  await expect(page.locator('[data-recipe-id="conversion:loadstone"]')).toHaveAccessibleName(/^Drop a nether star above a placed lodestone:/);
});

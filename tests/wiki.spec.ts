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

test('the editor requires sign-in and handles an unavailable setup', async ({ page }) => {
  await page.route('**/api/me/', route => route.fulfill({ json: { configured: true, user: null } }));
  await page.goto('/account/');
  await expect(page.getByRole('link', { name: 'Sign in with Discord', exact: true })).toHaveAttribute('href', '/auth/login/');
  await expect(page.locator('#account-tools')).toBeHidden();
  await page.unroute('**/api/me/');
  await page.route('**/api/me/', route => route.fulfill({ json: { configured: false, user: null } }));
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Editing is not available yet.');
  await expect(page.locator('#discord-login')).toBeHidden();
});

test('members can preview and save their page using the editor', async ({ page }) => {
  let version = 1;
  let text = '## Builds\n\nMy base';
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/me/') return route.fulfill({ json: { configured: true, user: { name: 'uaiden', owner: false, csrf: 'test-csrf' }, players: [{ slug: 'uaiden', name: 'uaiden' }], roles: ['uaiden'] } });
    if (path.endsWith('/history/')) return route.fulfill({ json: { revisions: [{ id: version, version, created: '2026-10-22T12:00:00Z' }] } });
    if (path === '/api/preview/') return route.fulfill({ json: { html: '<h2>Builds</h2><p>Updated base</p>' } });
    if (path === '/api/players/uaiden/' && request.method() === 'PUT') {
      expect(request.headers()['x-csrf-token']).toBe('test-csrf');
      const body = request.postDataJSON(); expect(body.version).toBe(version); text = body.markdown; version++;
      return route.fulfill({ json: { slug: 'uaiden', version } });
    }
    if (path === '/api/players/uaiden/') return route.fulfill({ json: { slug: 'uaiden', name: 'uaiden', markdown: text, version, edition: 'java', url: '/wiki/players/uaiden/' } });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.goto('/account/?player=uaiden');
  await expect(page.locator('#page-editor')).toBeVisible();
  await expect(page.locator('#owner-identity')).toBeHidden();
  await page.getByLabel('Page text (Markdown)').fill('## Builds\n\nUpdated base');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#page-preview')).toContainText('Updated base');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Changes saved.');
  expect(version).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('inventory references expand on demand and follow contents links', async ({ page }) => {
  await page.goto('/wiki/mods-and-datapacks/');
  await expect(page.getByRole('heading', { name: 'Player features', exact: true })).toBeVisible();
  await expect(page.locator('#datapack-inventory')).toBeHidden();
  await page.getByText('Show reference lists', { exact: true }).click();
  await expect(page.locator('#datapack-inventory')).toBeVisible();
  await expect(page.getByText('fabric-api-0.163.0+26.3.jar', { exact: true })).toBeVisible();
  const toggle = page.locator('.reference-list > summary');
  await toggle.focus();
  await toggle.press('Enter');
  await expect(page.locator('#datapack-inventory')).toBeHidden();
  await page.locator('.contents').getByRole('link', { name: 'Datapack inventory', exact: true }).click();
  await expect(page.locator('#datapack-inventory')).toBeVisible();
  await page.goto('/wiki/mods-and-datapacks/#libraries-and-dependencies');
  await expect(page.locator('#libraries-and-dependencies')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('article contents, readable source, and missing pages work', async ({ page }) => {
  await page.goto('/wiki/travel/');
  await page.locator('.contents').getByRole('link', { name: 'Set a home', exact: true }).click();
  await expect(page).toHaveURL(/#set-a-home$/);
  const source = await page.request.get('/source/travel.txt');
  expect(source.ok()).toBeTruthy();
  expect(await source.text()).toContain('/trigger sethome');
  await expect(page.locator('a[href="/lore/"]')).toHaveCount(0);
  await page.goto('/all-pages/');
  await expect(page.locator('a[href="/category/lore/"]')).toHaveCount(0);
  await page.goto('/wiki/players/uaiden/');
  await expect(page.locator('.article-body')).not.toContainText('Lore');
  for (const path of ['/lore/', '/category/lore/']) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
  }
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

import { test, expect } from '@playwright/test';

test('full roster popup supports hover, keyboard, tap and dismissal', async ({ page }, info) => {
  const names = ['.Bedrock player', ...Array.from({ length: 18 }, (_, i) => `Java${i}`)];
  await page.route('**/api/server-status/', route => route.fulfill({ json: { availability: 'online', players: names, online: names.length, capacity: 20, updated: Date.now() } }));
  await page.goto('/music/');
  const button = page.locator('#server-status-button'), panel = page.locator('#server-status-panel');
  await expect(button).toHaveText('19/20 online');
  if (info.project.name === 'desktop') { await button.hover(); await expect(panel).toBeVisible(); }
  else { await button.tap(); await expect(panel).toBeVisible(); }
  await expect(panel.locator('li')).toHaveCount(19);
  await expect(panel).toContainText('.Bedrock player');
  await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
  await page.locator('.theme-toggle').click(); await button.focus(); await expect(panel).toBeVisible();
  await page.locator('.theme-toggle').click(); await expect(panel).toBeHidden();
});

test('empty, offline and unavailable are distinct and the bar fits 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.clock.install();
  let state = 'online';
  await page.route('**/api/server-status/', route => route.fulfill({ json: { availability: state, players: [], online: state === 'online' ? 0 : null, capacity: 20, updated: Date.now() } }));
  await page.goto('/music/');
  await expect(page.locator('#server-status-button')).toHaveText('0/20 online');
  state = 'offline'; await page.clock.fastForward(15001);
  await expect(page.locator('#server-status-button')).toHaveText('Offline');
  state = 'unavailable'; await page.clock.fastForward(15001);
  await expect(page.locator('#server-status-button')).toHaveText('Status unavailable');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

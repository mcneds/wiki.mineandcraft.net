import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const idFor = (project: string) => project === 'desktop' ? 'c3333333-3333-4333-8333-333333333333' : 'c4444444-4444-4444-8444-444444444444';
const ownId = 'c5555555-5555-4555-8555-555555555555';
const player = { slug: 'uaiden', name: 'uaiden', image: '/images/players/uaiden.png' };
function sql(command: string) {
  // Use the local database directly so parallel fixtures do not start competing
  // Wrangler runtimes just to insert/delete a test row. Never opens remote D1.
  const directory = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  const files = readdirSync(directory).filter(file => /^[a-f0-9]{64}\.sqlite$/.test(file));
  if (files.length !== 1) throw new Error('Expected one local D1 database for browser fixtures.');
  const database = new DatabaseSync(join(directory, files[0]));
  try { database.exec('PRAGMA busy_timeout=5000'); database.exec(command); }
  finally { database.close(); }
}
test.beforeAll(async ({}, info) => {
  sql(`INSERT OR REPLACE INTO profile_comments(id,profile_slug,poster_slug,author_id,body,created) VALUES('${idFor(info.project.name)}','jobansz','uaiden','browser-comments','Browser comment <script>alert(1)</script>','2026-10-23T12:00:00.000Z')`);
});
test.afterAll(async ({}, info) => {
  sql(`DELETE FROM profile_comments WHERE id='${idFor(info.project.name)}' AND author_id='browser-comments'`);
});

test('public profile comments render without JavaScript and never execute HTML', async ({ browser }, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/wiki/players/jobansz/');
  await expect(page.locator('#comments-list')).toContainText('Browser comment <script>alert(1)</script>');
  await expect(page.locator('#comments-list script')).toHaveCount(0);
  const head = page.locator('#comments-list .comment-author img').first();
  await expect(head).toHaveAttribute('src', player.image);
  await head.scrollIntoViewIfNeeded();
  await expect(head).toHaveJSProperty('complete', true);
  expect(await head.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.locator('.profile-comment').first().screenshot({ path: `test-results/comment-head-${info.project.name}.png` });
  await expect(page.locator('.delete-comment')).toHaveCount(0);
  await expect(page.locator('#comments-login')).toHaveAttribute('href', '/auth/login/?returnTo=%2Fwiki%2Fplayers%2Fjobansz%2F');
  await context.close();
});

test('verified players post and delete comments with only their own IGN available', async ({ page }) => {
  let comments: any[] = [], posted: any;
  await page.route('**/api/players/jobansz/comments/**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { user: { csrf: 'comment-csrf' }, postingPlayers: [player], comments, page: 1, hasMore: false } });
    expect(request.headers()['x-csrf-token']).toBe('comment-csrf');
    if (request.method() === 'POST') {
      posted = request.postDataJSON();
      comments = [{ id: ownId, poster: player, body: posted.body, created: '2026-10-23T12:00:00.000Z', canDelete: true }];
      return route.fulfill({ status: 201, json: comments[0] });
    }
    comments = []; return route.fulfill({ json: { deleted: true } });
  });
  await page.goto('/wiki/players/jobansz/');
  await expect(page.locator('#comment-poster option')).toHaveCount(1);
  await page.getByLabel('Comment', { exact: true }).fill('Nice base!\n<script>plain text</script>');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.locator('#comments-status')).toHaveText('Comment posted.');
  expect(posted).toEqual({ posterSlug: 'uaiden', body: 'Nice base!\n<script>plain text</script>' });
  await expect(page.locator('#comment-body')).toHaveValue('');
  await expect(page.locator(`#comment-${ownId} p`)).toHaveText('Nice base!\n<script>plain text</script>');
  await expect(page.locator('#comments-list script')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete comment', exact: true }).click();
  await expect(page.locator('#comments-status')).toHaveText('Comment deleted.');
  await expect(page.locator('#comments-empty')).toBeVisible();
});

test('failed posts preserve the draft and older comments load without duplicates', async ({ page }) => {
  let attempts = 0;
  const comment = (id: string, body: string) => ({ id, body, poster: player, created: '2026-10-23T12:00:00.000Z' });
  await page.route('**/api/players/jobansz/comments/**', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') {
      attempts++;
      return route.fulfill({ status: 503, json: { error: 'Discord checks are temporarily unavailable.' } });
    }
    const older = url.searchParams.get('page') === '2';
    return route.fulfill({ json: { user: { csrf: 'csrf' }, postingPlayers: [player], page: older ? 2 : 1, hasMore: !older, comments: older ? [comment(ownId, 'Recent'), comment(idFor('desktop'), 'Older')] : [comment(ownId, 'Recent')] } });
  });
  await page.goto('/wiki/players/jobansz/');
  await page.getByLabel('Comment', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.locator('#comments-status')).toHaveText('Discord checks are temporarily unavailable.');
  await expect(page.locator('#comment-body')).toHaveValue('Keep this draft');
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: 'Older comments', exact: true }).click();
  await expect(page.locator('#comments-list li')).toHaveCount(2);
  await expect(page.locator('#comment-body')).toHaveValue('Keep this draft');
  await expect(page.locator('#comments-more')).toBeHidden();
});

test('expired sign-in keeps the draft visible until refreshed access permits posting', async ({ page }) => {
  let signedIn = true, csrf = 'old-csrf', attempts = 0;
  await page.route('**/api/players/jobansz/comments/**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { user: signedIn ? { csrf } : null, postingPlayers: signedIn ? [player] : [], comments: [], page: 1, hasMore: false } });
    attempts++;
    if (attempts === 1) { signedIn = false; return route.fulfill({ status: 401, json: { error: 'Please sign in with Discord again.' } }); }
    expect(request.headers()['x-csrf-token']).toBe('new-csrf');
    expect(request.postDataJSON().body).toBe('My draft');
    return route.fulfill({ status: 201, json: { id: ownId, poster: player, body: 'My draft', created: '2026-10-23T12:00:00.000Z', canDelete: true } });
  });
  await page.goto('/wiki/players/jobansz/');
  await page.getByLabel('Comment', { exact: true }).fill('My draft');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.locator('#comments-status')).toHaveText('Please sign in with Discord again.');
  await expect(page.locator('#comments-login')).toHaveAttribute('target', '_blank');
  await page.getByRole('button', { name: 'Check comment access', exact: true }).click();
  await expect(page.locator('#comment-body')).toBeVisible();
  await expect(page.locator('#comment-body')).toHaveValue('My draft');
  await expect(page.getByRole('button', { name: 'Post comment', exact: true })).toBeDisabled();
  signedIn = true; csrf = 'new-csrf';
  await page.getByRole('button', { name: 'Check comment access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Post comment', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.locator('#comments-status')).toHaveText('Comment posted.');
  expect(attempts).toBe(2);
});

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const imageId = 'c1111111-1111-4111-8111-111111111111';
const idFor = (project: string) => project === 'desktop' ? 'd1111111-1111-4111-8111-111111111111' : 'd2222222-2222-4222-8222-222222222222';
const privateFor = (project: string) => project === 'desktop' ? 'e1111111-1111-4111-8111-111111111111' : 'e2222222-2222-4222-8222-222222222222';
const player = { slug: 'uaiden', name: 'uaiden', url: '/wiki/players/uaiden/' };
function sql(command: string) {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'mineandcraft-wiki', '--local', '--command', command], { stdio: 'pipe', timeout: 30000 });
}
test.beforeAll(async ({}, info) => {
  const id = idFor(info.project.name), hidden = privateFor(info.project.name);
  sql(`INSERT OR REPLACE INTO coordinate_entries(id,name,access,dimension,x,y,z,notes,poster_slug,author_id,tags_json,owners_json,created,updated) VALUES('${id}','Browser iron farm ${info.project.name}','public','overworld',-1234,80,5678,'Use the chest.','uaiden','browser-test','["farm","iron"]','["apokefish"]','2026-10-22','2026-10-22'); INSERT OR REPLACE INTO coordinate_entries(id,name,access,notes,poster_slug,author_id,tags_json,owners_json,created,updated) VALUES('${hidden}','Browser private base ${info.project.name}','private','A shared picture only.','uaiden','browser-test','["base"]','[]','2026-10-22','2026-10-22');`);
});
test.afterAll(async ({}, info) => { sql(`DELETE FROM coordinate_entries WHERE id IN ('${idFor(info.project.name)}','${privateFor(info.project.name)}') AND author_id='browser-test'`); });

async function setup(page: Page, id: string, owner = false) {
  let saved: any, attempts = 0;
  const record = { id, name: 'Browser iron farm', url: `/coordinates/${id}/`, access: 'public', dimension: 'overworld', x: -1234, y: 80, z: 5678, notes: 'Use the chest.', tags: ['farm', 'iron'], owners: [{ slug: 'apokefish', name: 'apokefish', url: '/wiki/players/apokefish/' }], poster: player, version: 1, created: '2026-10-22', updated: '2026-10-22', image: null };
  await page.route('**/media/**', route => route.fulfill({ body: gif, contentType: 'image/gif' }));
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/coordinates/context/') return route.fulfill({ json: { user: { name: 'Player', csrf: 'csrf', owner }, postingPlayers: [player], players: [player, { slug: 'apokefish', name: 'apokefish' }], editableIds: [id] } });
    if (path === '/api/players/uaiden/images/' && request.method() === 'GET') return route.fulfill({ json: { images: [], usage: { used: 0 } } });
    if (path === '/api/players/uaiden/images/' && request.method() === 'POST') {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'Discord is temporarily unavailable.' } });
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      return route.fulfill({ status: 201, json: { image: { id: imageId, name: 'Farm.gif', url: `/media/${imageId}` }, usage: { used: gif.length } } });
    }
    if (path === '/api/coordinates/' && request.method() === 'POST') {
      saved = request.postDataJSON(); expect(request.headers()['x-csrf-token']).toBe('csrf');
      const entry = { ...record, ...saved, tags: saved.tags, owners: saved.owners.map((slug: string) => ({ slug, name: slug, url: `/wiki/players/${slug}/` })), image: saved.imageId ? { id: saved.imageId, url: `/media/${saved.imageId}`, alt: saved.imageAlt } : null };
      if (saved.access === 'private') for (const key of ['x', 'y', 'z', 'dimension']) delete entry[key];
      return route.fulfill({ status: 201, json: entry });
    }
    if (path === `/api/coordinates/${id}/` && request.method() === 'GET') return route.fulfill({ json: record });
    if (path === `/api/coordinates/${id}/` && request.method() === 'PUT') return route.fulfill({ status: 409, json: { error: 'This entry changed while you were editing. Your draft is still here; reload the entry before saving.' } });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.goto('/coordinates/');
  await expect(page.getByRole('button', { name: 'Add entry', exact: true })).toBeVisible();
  return { saved: () => saved, attempts: () => attempts };
}

test('public directory, filters, detail pages, and private locations render on the server', async ({ page }, info) => {
  await page.route('**/api/coordinates/context/', route => route.fulfill({ json: { user: null, postingPlayers: [], editableIds: [] } }));
  await page.goto('/coordinates/?tag=iron');
  await expect(page.locator('#coordinate-results')).toContainText('Browser iron farm');
  await expect(page.locator('#coordinate-results')).not.toContainText('Browser private base');
  await expect(page.locator('#coordinate-tag-filter')).toHaveValue('iron');
  await page.goto(`/coordinates/${idFor(info.project.name)}/`);
  await expect(page.locator('#coordinate-title')).toHaveText(`Browser iron farm ${info.project.name}`);
  await expect(page.locator('.coordinate-location')).toContainText('X: -1234, Y: 80, Z: 5678');
  await expect(page.locator('.coordinate-notes')).toHaveText('Use the chest.');
  await expect(page.getByRole('button', { name: 'Edit entry', exact: true })).toBeHidden();
  await page.goto(`/coordinates/${privateFor(info.project.name)}/`);
  await expect(page.locator('.coordinate-location')).toHaveText('Private');
  expect(await page.locator('.copy-coordinates').count()).toBe(0);
  const record = await (await page.request.get(`/api/coordinates/${privateFor(info.project.name)}/`)).json();
  for (const key of ['dimension', 'x', 'y', 'z', 'author_id']) expect(Object.hasOwn(record, key)).toBe(false);
  const noScript = await page.context().browser()!.newContext({ javaScriptEnabled: false });
  const read = await noScript.newPage(); await read.goto(`/coordinates/${idFor(info.project.name)}/`);
  await expect(read.locator('.coordinate-notes')).toHaveText('Use the chest.'); await noScript.close();
});

test('players publish public entries with tags, attribution, and uploads billed to their own profile', async ({ page }, info) => {
  const state = await setup(page, idFor(info.project.name));
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('New iron farm');
  await page.getByLabel('X', { exact: true }).fill('-20'); await page.getByLabel('Z', { exact: true }).fill('30');
  await page.getByRole('checkbox', { name: 'Farm', exact: true }).check();
  await page.getByLabel('Custom tags (comma separated)').fill('iron, XP');
  await page.getByRole('checkbox', { name: 'apokefish', exact: true }).check();
  await page.getByLabel('Notes', { exact: true }).fill('Leave some iron for others.');
  await page.getByLabel('Upload an image (PNG, JPEG, WebP, GIF; up to 5 MB)').setInputFiles({ name: 'Farm.gif', mimeType: 'image/gif', buffer: gif });
  await expect(page.locator('#coordinate-upload-status')).toContainText('Discord is temporarily unavailable');
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('Leave some iron for others.');
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(page.locator('#coordinate-image-preview')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `test-results/coordinates-form-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Publish entry', exact: true }).click();
  await expect(page.locator('#coordinate-account-status')).toHaveText('Entry saved.');
  const saved = state.saved(); expect(saved.posterSlug).toBe('uaiden'); expect(saved.owners).toEqual(['apokefish']);
  expect(saved.tags).toEqual(['farm', 'iron', 'xp']); expect(saved.imageId).toBe(imageId); expect(saved.y).toBeNull(); expect(state.attempts()).toBe(2);
  await expect(page.locator('.coordinate-image')).toHaveAttribute('src', `/media/${imageId}`);
  await page.screenshot({ path: `test-results/coordinates-${info.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Private clears location fields and excludes them from the submission entirely', async ({ page }, info) => {
  const state = await setup(page, idFor(info.project.name));
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Private base');
  await page.getByLabel('X', { exact: true }).fill('123456'); await page.getByLabel('Z', { exact: true }).fill('654321');
  await page.getByRole('checkbox', { name: 'Base', exact: true }).check();
  await page.locator('#coordinate-access').selectOption('private');
  await expect(page.locator('#coordinate-location-fields')).toBeHidden();
  await expect(page.locator('#coordinate-x')).toHaveValue(''); await expect(page.locator('#coordinate-z')).toHaveValue('');
  await page.getByRole('button', { name: 'Publish entry', exact: true }).click();
  await expect(page.locator('#coordinate-account-status')).toHaveText('Entry saved.');
  for (const key of ['dimension', 'x', 'y', 'z']) expect(Object.hasOwn(state.saved(), key)).toBe(false);
  await expect(page.locator('.coordinate-location')).toHaveText('Private');
});

test('editing preserves a draft after a conflict and fixes the posting profile', async ({ page }, info) => {
  const id = idFor(info.project.name); await setup(page, id);
  await page.locator(`[data-entry-id="${id}"]`).getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(page.locator('#coordinate-poster')).toBeDisabled();
  await page.getByLabel('Notes', { exact: true }).fill('My unsaved correction');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#coordinate-form-status')).toContainText('changed while you were editing');
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('My unsaved correction');
});

test('wiki search includes live coordinate entries', async ({ page }, info) => {
  await page.goto(`/search/?q=${encodeURIComponent('Browser iron farm ' + info.project.name)}`);
  await expect(page.locator('.search-results').getByRole('link', { name: `Browser iron farm ${info.project.name}`, exact: true })).toHaveAttribute('href', `/coordinates/${idFor(info.project.name)}/`);
});

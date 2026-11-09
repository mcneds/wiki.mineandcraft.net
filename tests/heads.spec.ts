import { test, expect } from '@playwright/test';

const head = { id: '11111111-1111-4111-8111-111111111111', name: 'Notch', edition: 'java', version: 2, image: '/images/players/0480.png' };
const track = { id: 'a1111111-1111-4111-8111-111111111111', kind: 'head', head, title: 'Hello', status: 'pending', version: 2, poster: { slug: 'uaiden', name: 'uaiden' }, canManage: true, hasAudio: true, audioUrl: '/test.wav', validation: 'pending', reviewNote: '' };
const context = { user: { csrf: 'token', owner: true }, postingPlayers: [{ slug: 'uaiden', name: 'uaiden' }], submissions: [track], page: 1, hasMore: false, usage: { used: 1048576, limit: 104857600, fileLimit: 20971520, trackLimit: 25 } };

test('head gallery and instructions work without JavaScript', async ({ browser }) => {
  const session = await browser.newContext({ javaScriptEnabled: false });
  const page = await session.newPage();
  await page.goto('/heads/');
  await expect(page.getByRole('heading', { name: 'Player-head sounds', exact: true })).toBeVisible();
  await expect(page.locator('#heads-catalogue')).toContainText('No matching approved');
  await page.getByLabel('Search by effect, IGN or uploader').fill('nothing');
  await page.locator('form[action="/heads/"] button').click();
  await expect(page).toHaveURL(/q=nothing/);
  await expect(page.locator('#heads-search')).toHaveValue('nothing');
  await expect(page.locator('.sidebar a[href="/heads/"]')).toHaveCount(1);
  await session.close();
});

test('head moderation waits for validation and shows combined storage', async ({ page }) => {
  let validated = false;
  await page.route('**/api/heads/context/**', route => route.fulfill({ json: { ...context, submissions: [{ ...track, validation: validated ? 'valid' : 'pending', durationMs: validated ? 10000 : null }] } }));
  await page.goto('/heads/create/');
  await expect(page.locator('#heads-usage')).toContainText('1.0 MB of 100 MB');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await expect(page.locator('#heads-library')).toContainText('Waiting for server audio validation');
  validated = true;
  await page.getByRole('button', { name: 'Refresh sounds and permissions' }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await expect(page.locator('#heads-library')).toContainText('10.00 seconds');
  await page.route('**/api/music/*/review/', async route => {
    expect(route.request().postDataJSON()).toEqual({ version: 2, status: 'approved', note: 'Good' });
    await route.fulfill({ json: { ...track, status: 'approved' } });
  });
  await page.getByLabel('Review note for Hello').fill('Good');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
});

test('head lookup shows protection errors and previews allowed identities', async ({ page }) => {
  await page.route('**/api/heads/context/**', route => route.fulfill({ json: { ...context, submissions: [] } }));
  await page.route('**/api/heads/lookup/', async route => {
    if (route.request().postDataJSON().name === 'Protected') return route.fulfill({ status: 403, json: { error: 'Only this whitelisted account’s verified owner may set its head sound.' } });
    return route.fulfill({ json: { name: 'Notch', edition: 'java', preview: '/images/players/0480.png', canReplace: true, association: null } });
  });
  await page.goto('/heads/create/');
  await page.locator('#heads-name').fill('Protected');
  await page.getByRole('button', { name: 'Look up head' }).click();
  await expect(page.locator('#heads-form-status')).toContainText('verified owner');
  await page.locator('#heads-name').fill('Notch');
  await page.getByRole('button', { name: 'Look up head' }).click();
  await expect(page.locator('#heads-target img')).toBeVisible();
  await expect(page.locator('#heads-target')).toContainText('Notch (java)');
});

test('failed audio upload retries the saved submission without reserving another head', async ({ page }) => {
  let created = 0, uploads = 0;
  await page.route('**/api/heads/context/**', route => route.fulfill({ json: { ...context, submissions: [] } }));
  await page.route('**/api/heads/lookup/', route => route.fulfill({ json: { name: 'Notch', edition: 'java', preview: '/images/players/0480.png', canReplace: true, association: null } }));
  await page.route('**/api/heads/', route => { created++; return route.fulfill({ json: track }); });
  await page.route('**/api/music/*/audio/', route => { uploads++; return route.fulfill(uploads === 1 ? { status: 503, json: { error: 'Upload failed. Retry.' } } : { json: track }); });
  await page.goto('/heads/create/');
  await page.locator('#heads-name').fill('Notch'); await page.locator('#heads-title').fill('Hello');
  const wav = Buffer.alloc(44 + 4800 * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.locator('#heads-file').setInputFiles({ name: 'effect.wav', mimeType: 'audio/wav', buffer: wav });
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.locator('#heads-form-status')).toContainText('Upload failed');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.locator('#heads-form-status')).toContainText('Uploaded');
  expect(created).toBe(1); expect(uploads).toBe(2);
});

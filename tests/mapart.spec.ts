import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const profile = { slug: 'uaiden', name: 'uaiden' };
const context = (artworks: any[] = [], extra = {}) => ({ user: { csrf: 'mapart-csrf', owner: false }, postingPlayers: [profile], artworks, enabled: true, usage: { used: 1572864, limit: 104857600 }, limits: { pending: 5 }, ...extra });
const file = { name: 'art.png', mimeType: 'image/png', buffer: readFileSync('public/images/players/0480.png') };

test('preview preserves source transparency and empty fit padding', async ({ page }) => {
  await page.route('**/api/mapart/context/**', route => route.fulfill({ json: context() }));
  await page.goto('/mapart/create/');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 128;
    const painter = canvas.getContext('2d')!;
    painter.fillStyle = 'white'; painter.fillRect(16, 32, 32, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Temporary image (up to 5 MiB)').setInputFiles({ name: 'transparent.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#mapart-preview')).toBeVisible();
  await page.getByLabel('Columns', { exact: true }).fill('1');
  await page.getByLabel('Rows', { exact: true }).fill('1');
  await page.getByLabel('Image fitting').selectOption('fit');
  await page.getByLabel('Top right', { exact: true }).check();
  const alpha = () => page.locator('#mapart-preview').evaluate((element: HTMLCanvasElement) => {
    const painter = element.getContext('2d')!;
    return [painter.getImageData(0, 0, 1, 1).data[3], painter.getImageData(70, 10, 1, 1).data[3], painter.getImageData(96, 64, 1, 1).data[3]];
  });
  await expect.poll(alpha).toEqual([0, 0, 255]);
  const columns = page.getByRole('spinbutton', { name: 'Columns', exact: true });
  for (const value of ['', '0', '65', '1.5', '999999']) {
    await columns.fill(value);
    await expect(page.locator('#mapart-cost')).toContainText('whole number from 1 to 64');
    await expect(page.locator('#mapart-preview-wrap')).toBeHidden();
    expect(await columns.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  }
  await columns.fill('1');
  await expect(page.locator('#mapart-preview-wrap')).toBeVisible();
  await expect.poll(alpha).toEqual([0, 0, 255]);
  await expect(page.locator('#mapart-preview-wrap')).toHaveCSS('background-image', /conic-gradient/);
  await page.getByLabel('Top left', { exact: true }).check();
  await expect.poll(async () => page.locator('#mapart-preview').evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(96,64,1,1).data[3])).toBe(0);
});

test('gallery searches artwork and player names while unfinished jobs stay on the creation page', async ({ page }) => {
  const artworks = [
    { id: 'a1111111-1111-4111-8111-111111111111', title: 'Farmstead', posterSlug: 'uaiden', posterName: 'Uaiden', status: 'ready', settings: { columns: 2, rows: 1 }, command: '/mapart claim abc123abc123' },
    { id: 'b1111111-1111-4111-8111-111111111111', title: 'Sunset', posterSlug: 'river-builder', posterName: 'River Builder', status: 'ready', settings: { columns: 1, rows: 1 } },
    { id: 'c1111111-1111-4111-8111-111111111111', title: 'Still cooking', posterSlug: 'uaiden', status: 'converting', settings: { columns: 1, rows: 1 } },
  ];
  await page.route('**/api/mapart/context/**', route => route.fulfill({ json: context(new URL(route.request().url()).searchParams.get('scope') === 'all' ? artworks : [artworks[0], artworks[2]], { user: { csrf: 'mapart-csrf', owner: true } }) }));
  await page.goto('/mapart/');
  await expect(page.locator('#mapart-storage-label')).toContainText('1.5 MiB of 100.0 MiB used');
  await expect(page.getByRole('meter')).toHaveAttribute('value', '1572864');
  await expect(page.locator('#mapart-usage')).not.toContainText('saved artworks');
  await expect(page.locator('#mapart-form')).toHaveCount(0);
  await expect(page.locator('.mapart-artwork')).toHaveCount(1);
  await expect(page.locator('#mapart-artworks')).not.toContainText('Still cooking');
  await page.getByLabel('Show all members’ mapart (owner)').check();
  await expect(page.locator('.mapart-artwork')).toHaveCount(2);
  const search = page.getByRole('searchbox', { name: 'Search by artwork or player' });
  await search.fill('  FARM  ');
  await expect(page.locator('.mapart-artwork')).toHaveCount(1);
  await expect(page.locator('#mapart-artworks')).toContainText('Farmstead');
  await search.fill('river builder');
  await expect(page.locator('.mapart-artwork')).toHaveCount(1);
  await expect(page.locator('#mapart-artworks')).toContainText('Sunset');
  await search.fill('missing');
  await expect(page.locator('#mapart-artworks')).toContainText('No artwork matches');
  await search.fill('');
  await expect(page.locator('.mapart-artwork')).toHaveCount(2);
  await page.getByRole('link', { name: 'View 1 unfinished artwork and their progress' }).click();
  await expect(page).toHaveURL(/\/mapart\/create\/#mapart-progress-heading/);
  await expect(page.locator('.mapart-artwork')).toHaveCount(1);
  await expect(page.locator('#mapart-artworks')).toContainText('Still cooking');
  await expect(page.locator('#mapart-artworks')).not.toContainText('Farmstead');
  await expect(page.locator('#mapart-completed')).toBeEmpty();
});

test('mapart tracks conversion on the creation page and links completed art to the gallery', async ({ page }) => {
  await page.clock.install();
  let status = 'queued';
  const created = Date.now() - 30000;
  await page.route('**/api/mapart/context/**', route => route.fulfill({ json: context([{
    id: 'a1111111-1111-4111-8111-111111111111', title: 'Farmstead', settings: { columns: 2, rows: 1 }, status, created,
    ...(status === 'ready' ? { command: '/mapart claim abc123abc123' } : {}),
  }]) }));
  await page.goto('/mapart/create/');
  const progress = page.getByRole('group', { name: 'Farmstead progress' });
  await expect(progress.locator('[aria-current=step]')).toHaveText('Queue');
  await expect(progress.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await expect(progress).toContainText('every 15 seconds');
  await expect(page.locator('#mapart-artworks code')).toHaveCount(0);
  await page.clock.fastForward(5000);
  await expect(page.locator('#mapart-live-status')).toContainText('last checked 5s ago');
  const cancel = page.getByRole('button', { name: 'Cancel / delete' });
  await cancel.focus();
  await page.clock.fastForward(10000);
  await expect(page.locator('#mapart-live-status')).toContainText('checked just now');
  await expect(cancel).toBeFocused();
  status = 'converting'; await page.clock.fastForward(15000);
  await expect(progress.locator('[aria-current=step]')).toHaveText('Convert');
  await expect(progress).toContainText('Minecraft map colors for 2 tiles');
  await expect(page.locator('#mapart-updates')).toHaveText('Farmstead: converting.');
  await expect(progress.locator('.mapart-job-icon')).toHaveCSS('animation-name', 'mapart-spin');
  status = 'ready'; await page.clock.fastForward(15000);
  await expect(progress).toHaveCount(0);
  await expect(page.locator('#mapart-completed')).toContainText('Farmstead is ready.');
  await expect(page.locator('#mapart-artworks code')).toHaveCount(0);
  await expect(page.locator('#mapart-updates')).toHaveText('Farmstead: ready to claim.');
  await page.getByRole('link', { name: 'View in gallery' }).click();
  await expect(page).toHaveURL(/\/mapart\/#mapart-/);
  await expect(page.locator('#mapart-form')).toHaveCount(0);
  await expect(page.locator('#mapart-artworks code')).toHaveText('/mapart claim abc123abc123');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('mapart reports interrupted updates and stopped conversion without a misleading active bar', async ({ page }) => {
  await page.clock.install(); await page.emulateMedia({ reducedMotion: 'reduce' });
  let offline = false, status = 'converting';
  await page.route('**/api/mapart/context/**', route => route.fulfill(offline ? { status: 503, json: { error: 'Temporarily unavailable' } } : { json: context([{
    id: 'a1111111-1111-4111-8111-111111111111', title: 'Farmstead', settings: { columns: 2, rows: 1 }, status,
    created: Date.now() - 360000, canRetry: status === 'failed', error: status === 'failed' ? 'The image could not be converted.' : null,
  }]) }));
  await page.goto('/mapart/create/');
  const progress = page.getByRole('group', { name: 'Farmstead progress' });
  await expect(progress).toContainText('Taking longer than usual');
  await expect(progress.locator('.mapart-job-icon')).toHaveCSS('animation-name', 'none');
  offline = true; await page.clock.fastForward(15000);
  await expect(page.locator('#mapart-live-status')).toContainText('Live updates interrupted');
  offline = false; status = 'failed'; await page.clock.fastForward(15000);
  await expect(progress).toContainText('Conversion stopped');
  await expect(progress.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry conversion' })).toBeVisible();
  await expect(page.locator('#mapart-live-status')).toContainText('checked just now');
});

test('mapart navigation and explanation are available without JavaScript', async ({ browser }) => {
  const session = await browser.newContext({ javaScriptEnabled: false });
  const page = await session.newPage(); await page.goto('/mapart/create/');
  await expect(page.getByRole('heading', { name: 'Create mapart', exact: true }).first()).toBeVisible();
  await expect(page.locator('.sidebar a[href="/mapart/"]')).toHaveCount(1);
  await expect(page.locator('#mapart-sign-in')).toHaveAttribute('href', '/auth/login/?returnTo=/mapart/create/');
  await page.getByRole('link', { name: 'Your gallery', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mapart gallery' })).toBeVisible();
  await expect(page.locator('#mapart-form')).toHaveCount(0);
  await expect(page.locator('#mapart-sign-in')).toHaveAttribute('href', '/auth/login/?returnTo=/mapart/');
  await expect(page.locator('#mapart-member')).toBeHidden(); await session.close();
});

test('temporary artwork submits alignment and 256-tile layout without entering the image library', async ({ page }) => {
  let posted: any, uploads = 0, libraryWrites = 0;
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/mapart/') && !path.includes('/images/')) return route.fallback();
    if (path.includes('/images/') && request.method() === 'POST') libraryWrites++;
    if (path === '/api/mapart/context/') return route.fulfill({ json: context() });
    expect(request.headers()['x-csrf-token']).toBe('mapart-csrf');
    if (path === '/api/mapart/') { posted = request.postDataJSON(); return route.fulfill({ status: 201, json: { id: posted.id } }); }
    if (path.endsWith('/source/')) { uploads++; return route.fulfill({ json: { status: 'queued' } }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/mapart/create/'); await expect(page.locator('#mapart-member')).toBeVisible();
  await page.getByLabel('Artwork name').fill('A big wall');
  await page.getByLabel('Temporary image (up to 5 MiB)').setInputFiles(file);
  await expect(page.locator('#mapart-preview')).toBeVisible();
  await page.getByLabel('Columns', { exact: true }).fill('32'); await page.getByLabel('Rows', { exact: true }).fill('9');
  await expect(page.locator('#mapart-cost')).toContainText('288 tiles. Choose at most 256 tiles total');
  await page.getByRole('button', { name: 'Create mapart', exact: true }).click();
  expect(posted).toBeUndefined();
  await page.getByLabel('Rows', { exact: true }).fill('8');
  await page.getByLabel('Top right', { exact: true }).check();
  await page.getByLabel('Image fitting').selectOption('crop');
  await expect(page.getByLabel('Top right', { exact: true })).toBeChecked();
  await expect(page.locator('#mapart-cost')).toContainText('256 blank maps per copy');
  await expect(page.locator('#mapart-cost')).toContainText('256 / 256 tiles');
  await expect(page.locator('#mapart-cost')).toContainText('4096 × 1024 pixels');
  await expect(page.locator('#mapart-cost')).toContainText('4.0 MiB map data');
  await page.getByRole('button', { name: 'Create mapart', exact: true }).click();
  await expect(page.locator('#mapart-form-status')).toContainText('Queued for conversion');
  expect(posted.columns).toBe(32); expect(posted.rows).toBe(8); expect(posted.horizontalAlignment).toBe('right'); expect(posted.verticalAlignment).toBe('top'); expect(posted.fit).toBe('crop');
  expect(uploads).toBe(1); expect(libraryWrites).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('an upload failure preserves the file and settings and retries the same submission', async ({ page }) => {
  const ids: string[] = []; let attempts = 0;
  await page.route('**/api/mapart/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/mapart/context/') return route.fulfill({ json: context() });
    if (path === '/api/mapart/') { ids.push(route.request().postDataJSON().id); return route.fulfill({ status: 201, json: {} }); }
    if (path.endsWith('/source/')) return route.fulfill(++attempts === 1 ? { status: 503, json: { error: 'Storage is temporarily unavailable.' } } : { json: {} });
    return route.fulfill({ json: {} });
  });
  await page.goto('/mapart/create/'); await page.getByLabel('Artwork name').fill('Keep my draft');
  await page.getByLabel('Temporary image (up to 5 MiB)').setInputFiles(file);
  await expect(page.locator('#mapart-preview')).toBeVisible();
  await page.getByLabel('Bottom left', { exact: true }).check();
  await page.getByRole('button', { name: 'Create mapart', exact: true }).click();
  await expect(page.locator('#mapart-form-status')).toContainText('temporarily unavailable');
  expect(await page.locator('#mapart-file').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('art.png');
  await expect(page.getByLabel('Bottom left', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Retry image upload', exact: true }).click();
  await expect(page.locator('#mapart-form-status')).toContainText('Queued for conversion');
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(attempts).toBe(2);
});

test('library images submit a reference and retain alignment across grid and fitting changes', async ({ page }) => {
  let posted: any, uploads = 0;
  const mediaId = 'a1111111-1111-4111-8111-111111111111';
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/mapart/context/') return route.fulfill({ json: context() });
    if (path.includes('/images/')) return route.fulfill({ json: { images: [{ id: mediaId, name: 'A library image', url: '/images/players/0480.png' }] } });
    if (path === '/api/mapart/') { posted = route.request().postDataJSON(); return route.fulfill({ status: 201, json: {} }); }
    if (path.endsWith('/source/')) uploads++;
    return route.fulfill({ json: {} });
  });
  await page.goto('/mapart/create/'); await page.getByLabel('Artwork name').fill('From my library');
  await page.getByLabel('Image source', { exact: true }).selectOption('library');
  await page.getByLabel('Library image', { exact: true }).selectOption(mediaId);
  await expect(page.locator('#mapart-preview')).toBeVisible();
  await page.getByLabel('Middle right', { exact: true }).check();
  await page.getByLabel('Columns', { exact: true }).fill('3'); await page.getByLabel('Image fitting').selectOption('crop');
  await expect(page.getByLabel('Middle right', { exact: true })).toBeChecked();
  await page.getByLabel('Image fitting').selectOption('fit'); await page.getByRole('button', { name: 'Create mapart', exact: true }).click();
  await expect(page.locator('#mapart-form-status')).toContainText('Queued for conversion');
  expect(posted.mediaId).toBe(mediaId); expect(posted.horizontalAlignment).toBe('right'); expect(posted.verticalAlignment).toBe('center'); expect(uploads).toBe(0);
});

test('a slow background permission refresh does not swallow a create action', async ({ page }) => {
  await page.clock.install();
  let contexts=0, held: (()=>Promise<void>) | undefined;
  await page.route('**/api/mapart/**', route => {
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/mapart/context/') {
      if(++contexts===2) { held=()=>route.fulfill({json:context()}); return; }
      return route.fulfill({json:context()});
    }
    return route.fulfill({json:{}});
  });
  await page.goto('/mapart/create/'); await expect(page.locator('#mapart-member')).toBeVisible();
  await page.getByLabel('Artwork name').fill('During refresh');
  await page.getByLabel('Temporary image (up to 5 MiB)').setInputFiles(file);
  await expect(page.locator('#mapart-preview')).toBeVisible();
  await page.clock.fastForward(15000); await expect.poll(()=>contexts).toBe(2);
  await page.getByRole('button',{name:'Create mapart',exact:true}).click();
  await expect(page.locator('#mapart-form-status')).toContainText('Queued for conversion');
  await held?.();
});

test('completed mapart escapes names, shows private preview and replacement cost, and supports deletion', async ({ page }) => {
  let deleted = false;
  const artwork = { id: 'a1111111-1111-4111-8111-111111111111', title: '<script>My art</script>', settings: { columns: 8, rows: 8 }, status: 'ready', command: '/mapart claim abc123abc123', previewUrl: '/images/players/0480.png' };
  await page.route('**/api/mapart/**', route => {
    if (route.request().method() === 'DELETE') { deleted = true; return route.fulfill({ json: { deleted: true } }); }
    return route.fulfill({ json: context(deleted ? [] : [artwork]) });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/mapart/');
  await expect(page.locator('#mapart-artworks')).toContainText('<script>My art</script>');
  await expect(page.locator('#mapart-artworks script')).toHaveCount(0);
  await expect(page.locator('#mapart-artworks')).toContainText('64 blank maps');
  await expect(page.locator('#mapart-artworks code')).toHaveText('/mapart claim abc123abc123');
  await page.getByRole('button', { name: 'Delete artwork', exact: true }).click();
  await expect(page.locator('#mapart-artworks')).not.toContainText('<script>My art</script>'); expect(deleted).toBeTruthy();
});

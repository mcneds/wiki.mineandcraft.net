import { test, expect, type Page } from '@playwright/test';
import { render } from '../worker/content.mjs';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const imageId = 'a1234567-1234-4123-8123-123456789012';
async function setup(page: Page, initial = '## About\n\nMy base', conflict = false) {
  let markdown = initial, version = 1, saves = 0, images: any[] = [];
  await page.route('https://www.youtube-nocookie.com/**', route => route.abort());
  await page.route('**/media/**', route => route.fulfill({ body: gif, contentType: 'image/gif' }));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/me/') return route.fulfill({ json: { configured: true, user: { name: 'Player', owner: false, csrf: 'csrf' }, players: [{ name: 'uaiden', slug: 'uaiden' }], roles: ['uaiden'] } });
    if (path.endsWith('/history/')) return route.fulfill({ json: { revisions: [{ id: version, version, created: '2026-10-22T12:00:00Z' }] } });
    if (path === '/api/preview/') return route.fulfill({ json: render(request.postDataJSON().markdown) });
    if (path === '/api/players/uaiden/images/') {
      if (request.method() === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe('csrf');
        expect(request.headers()['content-type']).toContain('multipart/form-data');
        const image = { id: imageId, name: 'Build.gif', type: 'image/gif', size: gif.length, url: `/media/${imageId}` };
        images = [image]; return route.fulfill({ status: 201, json: { image, usage: { used: gif.length } } });
      }
      return route.fulfill({ json: { images, usage: { used: images.length * gif.length } } });
    }
    if (path === '/api/players/uaiden/') {
      if (request.method() === 'PUT') {
        saves++;
        if (conflict) return route.fulfill({ status: 409, json: { error: 'This page changed while you were editing. Copy your text, reload, and merge the changes.' } });
        markdown = request.postDataJSON().markdown; version++;
        return route.fulfill({ json: { version, slug: 'uaiden' } });
      }
      return route.fulfill({ json: { slug: 'uaiden', name: 'uaiden', markdown, version, edition: 'java', url: '/wiki/players/uaiden/' } });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.goto('/account/');
  await expect(page.locator('#page-editor')).toBeVisible();
  return { saves: () => saves, source: () => markdown };
}

test('Visual is the default and mode switches preserve exact unsaved Markdown without revisions', async ({ page }) => {
  const source = '## About\n\nA **bold** and *italic* base with ~~old~~ plans and `code`.\n\n- One\n- Two\n\n1. First\n2. Second\n\n> A quote\n\n```text\nhello\n```\n\n[Website](https://example.com)\n\n| Build | Location |\n| --- | --- |\n| Base | Spawn |\n';
  const state = await setup(page, source);
  await expect(page.getByRole('tab', { name: 'Visual', exact: true })).toHaveAttribute('aria-selected', 'true');
  const visual = page.getByRole('textbox', { name: 'Page text (Visual)' });
  await expect(visual.locator('strong')).toHaveText('bold');
  await expect(visual.locator('table')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
    await expect(page.locator('#page-markdown')).toHaveValue(source);
    await page.getByRole('tab', { name: 'Visual', exact: true }).click();
    await expect(visual).toBeVisible();
  }
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#account-status')).toHaveText('No changes to save.');
  expect(state.saves()).toBe(0);
  await visual.fill('My new base'); await visual.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(visual.locator('strong')).toHaveText('My new base');
  await page.locator('#block-format').selectOption('2');
  await expect(visual.locator('h2')).toHaveText('My new base');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#page-preview h2 strong')).toHaveText('My new base');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.locator('#page-markdown')).toHaveValue('## **My new base**');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#account-status')).toHaveText('Changes saved.');
  expect(state.source()).toBe('## **My new base**');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('unsupported formatting stays in Markdown without source loss', async ({ page }) => {
  const source = '## About\n\n<div data-custom="keep">Exact HTML source</div>\n\nText';
  await setup(page, source);
  await expect(page.getByRole('tab', { name: 'Markdown', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#editor-notice')).toContainText('cannot preserve');
  await expect(page.locator('#page-markdown')).toHaveValue(source);
  await page.locator('#page-markdown').fill(source + '\n\nAn unsaved edit');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.locator('#page-markdown')).toHaveValue(source + '\n\nAn unsaved edit');
});

test('GIF uploads, image alt text, library insertion, and video embeds work in both modes', async ({ page }, info) => {
  await setup(page);
  const visual = page.getByRole('textbox', { name: 'Page text (Visual)' });
  await expect(visual).toBeVisible();
  await visual.click(); await visual.press('ControlOrMeta+End'); await visual.press('Enter');
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await page.getByLabel('Alt text', { exact: true }).fill('My base');
  await page.getByLabel('Upload an image', { exact: true }).setInputFiles({ name: 'Build.gif', mimeType: 'image/gif', buffer: gif });
  await expect(page.locator('#image-dialog')).not.toBeVisible();
  await expect(visual.locator('img')).toHaveAttribute('alt', 'My base');
  await visual.locator('img').click();
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await page.getByLabel('Alt text', { exact: true }).fill('Spawn at night');
  await page.getByRole('button', { name: 'Update selected image' }).click();
  await expect(visual.locator('img')).toHaveAttribute('alt', 'Spawn at night');
  await visual.press('ControlOrMeta+End'); await visual.press('Enter');
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await page.getByLabel('YouTube or Vimeo URL').fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByRole('button', { name: 'Insert video', exact: true }).click();
  await expect(visual.locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.locator('#page-markdown')).toHaveValue(new RegExp(`!\\[Spawn at night\\]\\(/media/${imageId}\\)`));
  await expect(page.locator('#page-markdown')).toHaveValue(/\[Video\]\(https:\/\/www.youtube.com\/watch\?v=dQw4w9WgXcQ\)/);
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await expect(page.locator('#image-library li')).toHaveCount(1);
  await page.locator('#image-library').getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#page-preview img')).toHaveCount(2);
  await expect(page.locator('#page-preview iframe')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#account-status')).toHaveText('Changes saved.');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(visual.locator('img')).toHaveCount(2);
  await expect(visual.locator('iframe')).toHaveCount(1);
  await page.screenshot({ path: `test-results/editor-${info.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('a conflict retains the unsaved draft and switching modes does not save it', async ({ page }) => {
  const state = await setup(page, 'An original page', true);
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await page.locator('#page-markdown').fill('My unsaved **edit**');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#account-status')).toContainText('changed while you were editing');
  await page.getByRole('tab', { name: 'Visual', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page text (Visual)' }).locator('strong')).toHaveText('edit');
  await page.getByRole('tab', { name: 'Markdown', exact: true }).click();
  await expect(page.locator('#page-markdown')).toHaveValue('My unsaved **edit**');
  expect(state.saves()).toBe(1);
});

test('pasted and dropped files use the upload flow and oversized images stay local', async ({ page }) => {
  await setup(page);
  const visual = page.getByRole('textbox', { name: 'Page text (Visual)' });
  await expect(visual).toBeVisible();
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/images/')) uploads++; });
  for (const kind of ['paste', 'drop']) {
    await visual.evaluate((element, { kind, encoded }) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'Build.gif', { type: 'image/gif' }));
      const box = element.getBoundingClientRect();
      element.dispatchEvent(kind === 'paste' ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: transfer, clientX: box.x + 20, clientY: box.y + 20, bubbles: true, cancelable: true }));
    }, { kind, encoded: gif.toString('base64') });
    await expect(page.locator('#account-status')).toContainText('Image uploaded.');
    await expect.poll(() => uploads).toBe(kind === 'paste' ? 1 : 2);
  }
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await page.getByLabel('Upload an image', { exact: true }).setInputFiles({ name: 'Huge.gif', mimeType: 'image/gif', buffer: Buffer.alloc(5242881) });
  await expect(page.locator('#media-status')).toContainText('up to 5 MB');
  expect(uploads).toBe(2);
});

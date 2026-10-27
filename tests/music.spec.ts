import { test, expect, type Page } from '@playwright/test';

const player = { slug: 'uaiden', name: 'uaiden' };
const usage = { used: 0, limit: 104857600, fileLimit: 20971520, trackLimit: 25 };
const track = (extra = {}) => ({ id: 'a1111111-1111-4111-8111-111111111111', title: 'My track', artist: 'A player', poster: player, sourceKind: 'file', sourceUrl: null, status: 'pending', version: 1, hasAudio: false, uploading: false, canManage: true, reviewNote: '', ...extra });
test.beforeEach(async ({ page }) => { await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Preview</p>' })); });
async function confirmRecording(page: Page) {
  await expect(page.locator('#music-metadata-status')).toContainText('Spotify details loaded');
  await page.locator('#music-audio-source').fill('https://youtu.be/dQw4w9WgXcQ');
  await page.locator('#music-preview-match').click();
  await expect(page.frameLocator('#music-match-preview iframe').getByText('Preview', { exact: true })).toBeVisible();
  await page.locator('#music-confirm-match').check();
  await page.locator('#music-submit').scrollIntoViewIfNeeded();
  await expect(page.locator('#music-submit')).toBeInViewport();
}

test('the music collection reads without JavaScript and music is in navigation', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/music/');
  await expect(page.getByRole('heading', { name: 'Music gallery', exact: true })).toBeVisible();
  await expect(page.locator('#music-catalogue')).toContainText('No approved discs yet');
  await expect(page.locator('.music-navigation a[href="/music/create/"]')).toBeVisible();
  await expect(page.locator('#music-form')).toHaveCount(0);
  await expect(page.locator('.sidebar a[href="/music/"]')).toHaveCount(1);
  await page.getByLabel('Search by song, artist or player').fill('missing song');
  await page.locator('#music-search-form button').click();
  await expect(page).toHaveURL(/q=missing\+song/);
  await expect(page.locator('#music-search')).toHaveValue('missing song');
  await expect(page.locator('#music-catalogue')).toContainText('No songs match your search');
  await context.close();
});

test('gallery search resets pagination, retains search in page links and ignores stale results', async ({ page }) => {
  let finishOld: () => void;
  const old = new Promise<void>(resolve => { finishOld = resolve; });
  await page.route('**/api/music/?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    const query = params.get('q') || '';
    if (query === 'old') await old;
    const tracks = query === 'missing' ? [] : [track({ title: query || 'All songs' })];
    return route.fulfill({ json: { tracks, query, page: Number(params.get('page') || 1), pages: tracks.length ? 2 : 1, total: tracks.length ? 31 : 0 } });
  });
  await page.goto('/music/?page=2');
  await expect(page.locator('#music-pagination')).toContainText('Page 2 of 2');
  const search = page.getByLabel('Search by song, artist or player');
  await search.fill('old');
  await page.waitForRequest(request => new URL(request.url()).searchParams.get('q') === 'old');
  await search.fill('New Artist');
  await expect(page.locator('.music-track h2')).toHaveText('New Artist');
  await expect(page).toHaveURL(/\?q=New\+Artist$/);
  await expect(page.locator('#music-pagination a')).toHaveAttribute('href', '/music/?q=New+Artist&page=2');
  const oldResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === 'old');
  finishOld!(); await oldResponse;
  await expect(page.locator('.music-track h2')).toHaveText('New Artist');
  await search.fill('missing');
  await expect(page.locator('#music-catalogue')).toContainText('No songs match');
  await expect(page.locator('#music-gallery-status')).toHaveText('0 songs found.');
  await search.fill('');
  await page.route('**/api/music/', route => route.fulfill({ json: { tracks: [track({ title: 'All songs' })], query: '', total: 31, page: 1, pages: 2 } }));
  await search.press('Enter');
  await expect(page.locator('.music-track h2')).toHaveText('All songs');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('artist and uploader filters combine with search and retain all options for empty results', async ({ page }) => {
  await page.route('**/api/music/?*', route => {
    const params = new URL(route.request().url()).searchParams;
    const filters = { artist: params.get('artist') || '', uploader: params.get('uploader') || '' };
    const empty = filters.artist === 'Other artist' && filters.uploader === 'notch';
    return route.fulfill({ json: { tracks: empty ? [] : [track({ title: 'Filtered song' })], total: empty ? 0 : 31, page: Number(params.get('page') || 1), pages: empty ? 1 : 2, query: params.get('q') || '', filters, artists: ['Artist & Band', 'Other artist'], uploaders: [player, { slug: 'notch', name: 'Notch' }] } });
  });
  await page.goto('/music/?q=song&page=2');
  await page.getByLabel('Artist', { exact: true }).selectOption('Artist & Band');
  await expect(page.locator('#music-pagination')).toContainText('Page 1 of 2');
  await expect(page.getByLabel('Artist', { exact: true })).toHaveValue('Artist & Band');
  await page.getByLabel('Uploader', { exact: true }).selectOption('notch');
  await expect(page.locator('#music-pagination a')).toHaveAttribute('href', '/music/?q=song&artist=Artist+%26+Band&uploader=notch&page=2');
  await expect(page.getByLabel('Artist', { exact: true })).toHaveValue('Artist & Band');
  await expect(page.getByLabel('Uploader', { exact: true })).toHaveValue('notch');
  await page.getByLabel('Artist', { exact: true }).selectOption('Other artist');
  await expect(page.locator('#music-catalogue')).toContainText('No songs match your search or filters');
  await expect(page.locator('#music-artist option')).toHaveCount(3);
  await expect(page.locator('#music-uploader option')).toHaveCount(3);
  await page.getByLabel('Uploader', { exact: true }).selectOption('');
  await expect(page.locator('.music-track h2')).toHaveText('Filtered song');
  await expect(page).toHaveURL(/q=song&artist=Other\+artist$/);
  await page.getByLabel('Artist', { exact: true }).selectOption('');
  await expect(page).toHaveURL(/\?q=song$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('gallery audio plays, seeks and survives metadata refreshes without restarting', async ({ page }) => {
  await page.clock.install();
  const samples = 8000 * 30, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  const id = track().id;
  let title = 'Listen here', requests = 0;
  await page.route('**/api/music/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/play/')) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) }, body: wav.subarray(start, end + 1) });
    }
    requests++;
    return route.fulfill({ json: { tracks: [track({ title, status: 'released', claimCode: 123, playbackUrl: `/api/music/${id}/play/` })], total: 1, page: 1, pages: 1 } });
  });
  await page.goto('/music/');
  const audio = page.locator('.music-track audio');
  await expect(audio).toHaveAttribute('preload', 'none');
  await audio.evaluate(async (element: HTMLAudioElement) => { (window as any).originalAudio = element; await element.play(); });
  await expect(page.locator('.music-track')).toHaveClass(/music-playing/);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.seekable.length ? element.seekable.end(0) : 0)).toBeGreaterThan(10);
  await audio.evaluate((element: HTMLAudioElement) => { element.currentTime = 10; });
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(10);
  title = 'Updated title';
  await page.clock.fastForward(15001);
  await expect(page.locator('.music-track h2')).toHaveText(title);
  expect(requests).toBeGreaterThanOrEqual(2);
  expect(await audio.evaluate((element: HTMLAudioElement) => element === (window as any).originalAudio && !element.paused && element.currentTime >= 10)).toBeTruthy();
  await expect(audio).toHaveAttribute('aria-label', 'Play Updated title');
  await expect(page.locator('.music-disc')).toHaveCSS('animation-play-state', 'running');
  await audio.evaluate((element: HTMLAudioElement) => element.pause());
  await expect(page.locator('.music-disc')).toHaveCSS('animation-play-state', 'paused');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('members submit a Spotify reference to their own library and see the audio requirement', async ({ page }) => {
  let submissions: any[] = [], posted: any;
  await page.route('**/api/music/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions, usage, page: 1, hasMore: false } });
    if (path === '/api/music/metadata/') return route.fulfill({ json: { title: 'Spotify song', artist: 'Spotify artist' } });
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('music-csrf');
      posted = request.postDataJSON();
      submissions = [track({ id: posted.id, title: posted.title, sourceKind: 'spotify', sourceUrl: posted.sourceUrl, audioSourceUrl: posted.audioSourceUrl })];
      return route.fulfill({ status: 201, json: submissions[0] });
    }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/');
  await expect(page.locator('#music-member')).toBeVisible();
  await expect(page.locator('#music-usage')).toContainText('0.0 MB of 100.0 MB');
  await page.locator('#music-add summary').click();
  await page.getByLabel('Track title', { exact: true }).fill('Member song');
  await page.getByLabel('Source', { exact: true }).selectOption('link');
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  await confirmRecording(page);
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('Added to your library');
  expect(posted.posterSlug).toBe('uaiden');
  await expect(page.locator('#music-library')).toContainText('fetch the confirmed recording after approval');
  await expect(page.getByRole('button', { name: 'Approve for server' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Spotify links fill title and multiple artists and submit the populated details', async ({ page }) => {
  let posted: any;
  await page.route('**/api/music/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions: [], usage, page: 1, hasMore: false } });
    if (path === '/api/music/metadata/') {
      expect(route.request().postDataJSON().sourceUrl).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
      return route.fulfill({ json: { title: 'A track', artist: 'First artist, Second artist', coverUrl: 'https://covers.test/spotify.jpg' } });
    }
    if (route.request().method() === 'POST') { posted = route.request().postDataJSON(); return route.fulfill({ status: 201, json: {} }); }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/');
  await page.locator('#music-add summary').click();
  await page.getByLabel('Source', { exact: true }).selectOption('link');
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=tracking');
  await expect(page.getByLabel('Track title', { exact: true })).toHaveValue('A track');
  await expect(page.getByLabel('Artist (optional)', { exact: true })).toHaveValue('First artist, Second artist');
  await confirmRecording(page);
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('Added to your library');
  expect(posted.title).toBe('A track'); expect(posted.artist).toBe('First artist, Second artist');
});

test('Spotify matching requires preview and confirmation, then sends the selected recording', async ({ page }) => {
  let posted: any;
  await page.route('**/api/music/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions: [], usage, page: 1, hasMore: false } });
    if (path === '/api/music/metadata/') return route.fulfill({ json: { title: 'Spotify song', artist: 'Spotify artist' } });
    if (path === '/api/music/matches/') return route.fulfill({ json: { candidates: [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '<script>A possible recording</script>', channel: 'Artist channel', durationSeconds: 214 }] } });
    if (route.request().method() === 'POST') { posted = route.request().postDataJSON(); return route.fulfill({ status: 201, json: {} }); }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/'); await page.locator('#music-add summary').click();
  await page.getByLabel('Source', { exact: true }).selectOption('link');
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  await expect(page.getByLabel('Track title', { exact: true })).toHaveValue('Spotify song');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('preview and confirm'); expect(posted).toBeUndefined();
  await page.getByRole('button', { name: 'Find matching recordings' }).click();
  await expect(page.locator('#music-match-results')).toContainText('Artist channel · 3:34');
  await expect(page.locator('#music-match-results script')).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose and preview' }).click();
  await expect(page.locator('#music-match-preview iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('preview and confirm');
  await page.locator('#music-confirm-match').check();
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl');
  await expect(page.locator('#music-confirm-match')).not.toBeChecked();
  await expect(page.locator('#music-match-preview iframe')).toHaveCount(0);
  await confirmRecording(page);
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('Added to your library');
  expect(posted.audioSourceUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ'); expect(posted.audioSourceConfirmed).toBe(true);
  expect(posted.sourceUrl).toContain('open.spotify.com');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('YouTube links fill title and channel while keeping artist editable', async ({ page }) => {
  let posted: any;
  await page.route('**/api/music/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions: [], usage, page: 1, hasMore: false } });
    if (path === '/api/music/metadata/') return route.fulfill({ json: { title: 'YouTube title', artist: 'Channel name', artistIsChannel: true, coverUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' } });
    if (route.request().method() === 'POST') { posted = route.request().postDataJSON(); return route.fulfill({ status: 201, json: {} }); }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/'); await page.locator('#music-add summary').click();
  await page.getByLabel('Source', { exact: true }).selectOption('link');
  await page.getByLabel('Track or video link').fill('https://youtu.be/dQw4w9WgXcQ');
  await expect(page.getByLabel('Track title', { exact: true })).toHaveValue('YouTube title');
  await expect(page.getByLabel('Artist (optional)', { exact: true })).toHaveValue('Channel name');
  await expect(page.locator('#music-cover-url')).toHaveValue('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  await expect(page.locator('#music-cover-preview img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  await expect(page.locator('#music-metadata-status')).toContainText('channel is not the performer');
  await expect(page.locator('#music-matching')).toBeHidden();
  await page.getByLabel('Artist (optional)', { exact: true }).fill('Actual performer');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('Added to your library');
  expect(posted.coverUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  expect(posted.artist).toBe('Actual performer'); expect(posted.audioSourceUrl).toBeUndefined();
});

test('an existing Spotify library entry can save a confirmed recording for approval', async ({ page }) => {
  let submission = track({ sourceKind: 'spotify', sourceUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' }), saved: any;
  await page.route('**/api/music/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: true }, postingPlayers: [player], submissions: [submission], usage, page: 1, hasMore: false } });
    if (path.endsWith('/source/')) { saved = route.request().postDataJSON(); submission = { ...submission, audioSourceUrl: saved.audioSourceUrl, version: 2 } as any; return route.fulfill({ json: submission }); }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/');
  await expect(page.getByRole('button', { name: 'Approve for server', exact: true })).toBeDisabled();
  await page.getByText('Choose or change the audio recording', { exact: true }).click();
  await page.locator('#music-library').getByLabel('YouTube recording link', { exact: true }).fill('https://youtu.be/dQw4w9WgXcQ');
  await page.locator('#music-library').getByRole('button', { name: 'Preview recording', exact: true }).click();
  await expect(page.frameLocator('#music-library iframe').getByText('Preview', { exact: true })).toBeVisible();
  await page.getByLabel('I listened and confirm this recording.', { exact: true }).check();
  const save = page.getByRole('button', { name: 'Save recording', exact: true });
  await save.scrollIntoViewIfNeeded(); await expect(save).toBeInViewport(); await save.click();
  await expect(page.locator('#music-account-status')).toContainText('Recording saved');
  expect(saved.audioSourceConfirmed).toBe(true); expect(saved.version).toBe(1);
  await expect(page.getByRole('button', { name: 'Approve for server', exact: true })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Confirmed YouTube recording' })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('slow Spotify lookups preserve edits and ignore results for an earlier link', async ({ page }) => {
  const pending: Array<{ release: () => void }> = [];
  await page.route('**/api/music/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions: [], usage, page: 1, hasMore: false } });
    if (path === '/api/music/metadata/') {
      const index = pending.length;
      await new Promise<void>(release => pending.push({ release }));
      return route.fulfill({ json: { title: `Track ${index}`, artist: `Artist ${index}` } });
    }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/'); await page.locator('#music-add summary').click();
  await page.getByLabel('Source', { exact: true }).selectOption('link');
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  await expect.poll(() => pending.length).toBe(1);
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl');
  await expect.poll(() => pending.length).toBe(2);
  await page.getByLabel('Track title', { exact: true }).fill('My edited title');
  await page.getByLabel('Artist (optional)', { exact: true }).fill('My edited artists');
  pending[1].release();
  await expect(page.locator('#music-metadata-status')).toContainText('Spotify details loaded');
  const olderResponse = page.waitForResponse(response => response.url().includes('/api/music/metadata/'));
  pending[0].release(); await olderResponse;
  await expect(page.getByLabel('Track title', { exact: true })).toHaveValue('My edited title');
  await expect(page.getByLabel('Artist (optional)', { exact: true })).toHaveValue('My edited artists');
});

test('a Spotify lookup failure leaves title and artist available for manual entry', async ({ page }) => {
  await page.route('**/api/music/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions: [], usage, page: 1, hasMore: false } });
    if (path === '/api/music/metadata/') return route.fulfill({ status: 502, json: { error: 'Could not load Spotify details. Enter the title and artist manually.' } });
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/'); await page.locator('#music-add summary').click();
  await page.getByLabel('Source', { exact: true }).selectOption('link');
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  await expect(page.locator('#music-metadata-status')).toContainText('Enter the title and artist manually');
  await page.getByLabel('Track title', { exact: true }).fill('Manual title');
  await page.getByLabel('Artist (optional)', { exact: true }).fill('Manual artist');
  await expect(page.getByRole('button', { name: 'Submit for review', exact: true })).toBeEnabled();
});

test('failed uploads preserve the file and retry against the saved submission without duplicates', async ({ page }) => {
  let submissions: any[] = [], creates = 0, uploads = 0;
  await page.route('**/api/music/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions, usage, page: 1, hasMore: false } });
    if (path.endsWith('/audio/') && request.method() === 'POST') {
      uploads++;
      if (uploads === 1) return route.fulfill({ status: 503, json: { error: 'The submission is saved, but its audio upload failed. Retry the upload.' } });
      submissions = submissions.map(value => ({ ...value, hasAudio: true, filename: 'song.wav', audioUrl: '/api/music/' + value.id + '/audio/', version: 2 }));
      return route.fulfill({ json: submissions[0] });
    }
    if (request.method() === 'POST') {
      creates++;
      const body = request.postDataJSON(); submissions = [track({ id: body.id, title: body.title })];
      return route.fulfill({ status: 201, json: submissions[0] });
    }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/');
  await page.locator('#music-add summary').click();
  await page.getByLabel('Track title', { exact: true }).fill('Keep my audio');
  await page.locator('#music-file').setInputFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVE00000000000000000000000000000000000000') });
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('Retry the upload.');
  await expect(page.locator('#music-title')).toHaveValue('Keep my audio');
  expect(await page.locator('#music-file').evaluate((input: HTMLInputElement) => input.files?.[0].name)).toBe('song.wav');
  await page.getByRole('button', { name: 'Retry audio upload', exact: true }).click();
  await expect(page.locator('#music-form-status')).toContainText('Added to your library');
  expect(creates).toBe(1); expect(uploads).toBe(2);
  await expect(page.locator('#music-library')).toContainText('Keep my audio');
});

test('owner review distinguishes Spotify audio requirements from YouTube conversion and escapes library text', async ({ page }) => {
  const submissions = [track({ title: '<script>plain title</script>', sourceKind: 'spotify', sourceUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' }), track({ id: 'a2222222-2222-4222-8222-222222222222', title: 'YouTube song', sourceKind: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })];
  let reviewed: any;
  await page.route('**/api/music/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'owner-csrf', owner: true }, postingPlayers: [player], submissions, usage, page: 1, hasMore: false, delivery: { heartbeat: null, state: 'waiting', message: '' } } });
    if (request.method() === 'POST') { reviewed = request.postDataJSON(); return route.fulfill({ json: {} }); }
    return route.fulfill({ json: { tracks: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/music/create/');
  await expect(page.locator('#music-delivery')).toContainText('not connected yet');
  await expect(page.locator('#music-library script')).toHaveCount(0);
  await expect(page.locator('#music-library h3').first()).toHaveText('<script>plain title</script>');
  const approvals = page.getByRole('button', { name: 'Approve for server', exact: true });
  await expect(approvals.first()).toBeDisabled(); await expect(approvals.nth(1)).toBeEnabled();
  await approvals.nth(1).click();
  await expect(page.locator('#music-account-status')).toContainText('The server will pick up this track.');
  expect(reviewed.status).toBe('approved');
  await expect(approvals.first()).toBeDisabled();
});


test('background progress updates preserve drafts, selected uploads and owner review notes', async ({ page }) => {
  await page.clock.install();
  let phase = 'fetching_audio';
  await page.route('**/api/music/**', route => {
    const path = new URL(route.request().url()).pathname;
    const approved = track({status:phase === 'installed' ? 'released' : 'approved',claimCode:phase === 'installed' ? 12345 : null,delivery:{phase,reason:phase === 'failed' ? 'youtube_access_blocked' : ''}});
    const delivery = {state:phase === 'failed' ? 'failed' : phase === 'installed' ? 'installed' : 'waiting',message:phase === 'failed' ? 'python could not process the track or refresh the server.' : '',heartbeat:1792873473868};
    if (path === '/api/music/context/') return route.fulfill({json:{user:{csrf:'test',owner:true},postingPlayers:[player],submissions:[approved],usage,page:1,hasMore:false,delivery}});
    return route.fulfill({json:{tracks:[approved],total:1,page:1,pages:1}});
  });
  await page.goto('/music/create/'); await expect(page.locator('#music-library')).toContainText('Fetching audio');
  await page.locator('#music-add summary').click();
  await page.locator('#music-title').fill('My unsaved song');
  await page.locator('#music-file').setInputFiles({name:'chosen.wav',mimeType:'audio/wav',buffer:Buffer.from('RIFFtestWAVE')});
  await page.locator('#music-note-a1111111-1111-4111-8111-111111111111').fill('My unsaved review');
  phase = 'failed'; await page.clock.fastForward(15001);
  await expect(page.locator('#music-library .music-state')).toHaveText('Audio download blocked by YouTube');
  await expect(page.locator('#music-delivery')).toContainText('Server update failed: python could not process');
  await expect(page.locator('[data-music-claim]')).toHaveCount(0);
  phase = 'installed'; await page.clock.fastForward(15001);
  await expect(page.locator('#music-library .music-state')).toHaveText('Added to server');
  await expect(page.locator('#music-delivery')).toContainText('Music server last connected:');
  await expect(page.locator('#music-delivery')).not.toContainText('Server update failed');
  await expect(page.locator('#music-library code')).toHaveText('/trigger mac_music set 12345');
  await expect(page.locator('#music-title')).toHaveValue('My unsaved song');
  await expect(page.locator('#music-note-a1111111-1111-4111-8111-111111111111')).toHaveValue('My unsaved review');
  expect(await page.locator('#music-file').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('chosen.wav');
});

test('installed songs offer readable replacement commands and clipboard fallback', async ({ page }) => {
  await page.route('**/api/music/**', route => new URL(route.request().url()).pathname === '/api/music/context/' ? route.fulfill({json:{user:null,submissions:[],postingPlayers:[]}}) : route.fulfill({json:{tracks:[track({status:'released',claimCode:12345})],total:1,page:1,pages:1}}));
  await page.goto('/music/');
  await expect(page.locator('#music-catalogue')).toContainText('Hold any music disc');
  await expect(page.locator('#music-catalogue code')).toHaveText('/trigger mac_music set 12345');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: {writeText:() => Promise.reject(new Error('denied'))} }));
  await page.getByRole('button',{name:'Copy claim command'}).click();
  await expect(page.getByRole('button',{name:'Copy the command shown above'})).toBeVisible();
});


test('disc artwork is cropped, falls back on errors, and can be edited on installed tracks', async ({ page }) => {
  const cover = 'https://covers.test/album.png';
  await page.route('https://covers.test/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64') }));
  let current: any = track({ status: 'released', coverUrl: cover, claimCode: 123 }), saved: any;
  await page.route('**/api/music/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/cover/')) { saved = route.request().postDataJSON(); current = { ...current, coverUrl: saved.coverUrl, version: 2 }; return route.fulfill({ json: current }); }
    if (path === '/api/music/context/') return route.fulfill({ json: { user: { csrf: 'music-csrf', owner: false }, postingPlayers: [player], submissions: [current], usage, page: 1, hasMore: false } });
    return route.fulfill({ json: { tracks: [current], page: 1, pages: 1 } });
  });
  await page.goto('/music/');
  const image = page.locator('.music-disc img');
  await expect(image).toHaveAttribute('src', cover);
  await expect(image).toHaveCSS('object-fit', 'cover');
  await expect(image).toHaveCSS('border-radius', '50%');
  await image.evaluate((img: HTMLImageElement) => img.dispatchEvent(new Event('error')));
  await expect(image).toBeHidden();
  await page.goto('/music/create/');
  await page.getByText('Edit album cover', { exact: true }).click();
  await page.locator('.music-cover-editor input').fill('https://covers.test/replacement.png');
  await page.getByRole('button', { name: 'Save cover', exact: true }).click();
  await expect(page.locator('#music-account-status')).toHaveText('Album cover saved.');
  expect(saved).toEqual({ coverUrl: 'https://covers.test/replacement.png', version: 1 });
  await expect(page.locator('.music-library-row > .music-disc img')).toHaveAttribute('src', saved.coverUrl);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('a slow Spotify response preserves a manually entered album cover', async ({ page }) => {
  let finish: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/music/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/music/metadata/') { await waiting; return route.fulfill({ json: { title: 'Track', artist: 'Artist', coverUrl: 'https://covers.test/spotify.png' } }); }
    return route.fulfill({ json: { user: { csrf: 'csrf', owner: false }, postingPlayers: [player], submissions: [], usage, page: 1, hasMore: false } });
  });
  await page.goto('/music/create/');
  await page.locator('#music-add summary').click();
  await page.getByLabel('Source', { exact: true }).selectOption('link');
  await page.getByLabel('Track or video link').fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  await expect(page.locator('#music-metadata-status')).toContainText('Looking up Spotify');
  await page.locator('#music-cover-url').fill('https://covers.test/my-cover.png');
  finish!();
  await expect(page.locator('#music-metadata-status')).toContainText('Spotify details loaded');
  await expect(page.locator('#music-cover-url')).toHaveValue('https://covers.test/my-cover.png');
  await page.locator('#music-cover-url').fill('');
  await expect(page.locator('#music-cover-preview img')).toHaveCount(0);
});

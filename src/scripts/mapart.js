import { createApi } from './api.js';
import { MAPART_FILE_LIMIT, MAPART_PIXEL_LIMIT, MAPART_TILE_LIMIT, mapartSizeError, mapartFields, mapartLayout } from '../../shared/mapart.mjs';

const $ = id => document.getElementById(id);
if ($('mapart-member')) {
  const creating = Boolean($('mapart-form'));
  let csrf = '', context, draft = null, bitmap = null, generation = 0, busy = false, refreshing = false, images = [], artworkSignature = '', lastChecked = 0, refreshFailed = false;
  const previousStates = new Map();
  const completedHere = new Set();
  let followedGalleryLink = false;
  const api = createApi({ csrf: () => csrf, onUnauthorized: () => { $('mapart-sign-in').hidden = false; } });
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const fileSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
  const alignment = () => document.querySelector('input[name="mapart-alignment"]:checked').value.split('-');
  const settings = () => ({ title: $('mapart-title').value, columns: Number($('mapart-columns').value), rows: Number($('mapart-rows').value), fit: $('mapart-fit').value, verticalAlignment: alignment()[0], horizontalAlignment: alignment()[1], dither: $('mapart-dither').checked });
  function draw() {
    const values = settings(), count = values.columns * values.rows;
    const sizeError = mapartSizeError(values.columns, values.rows);
    for (const id of ['mapart-columns', 'mapart-rows']) $(id).setCustomValidity(sizeError);
    if (sizeError) {
      $('mapart-cost').textContent = sizeError;
      $('mapart-preview-wrap').hidden = true;
      return;
    }
    $('mapart-cost').textContent = `${values.columns} × ${values.rows} maps · ${count} / ${MAPART_TILE_LIMIT} tiles · ${values.columns * 128} × ${values.rows * 128} pixels · ${fileSize(count * 16384)} map data · ${count} blank map${count === 1 ? '' : 's'} per copy, free in creative mode. Bring ${count} item frame${count === 1 ? '' : 's'}.`;
    $('mapart-preview-wrap').hidden = !bitmap;
    $('mapart-grid-overlay').hidden = !$('mapart-grid').checked;
    $('mapart-preview-wrap').style.setProperty('--columns', values.columns);
    $('mapart-preview-wrap').style.setProperty('--rows', values.rows);
    if (!bitmap) return;
    const layout = mapartLayout(bitmap.width, bitmap.height, values), canvas = $('mapart-preview');
    canvas.width = layout.width; canvas.height = layout.height;
    const painter = canvas.getContext('2d'); painter.clearRect(0, 0, canvas.width, canvas.height);
    painter.drawImage(bitmap, layout.x, layout.y, layout.resizedWidth, layout.resizedHeight);
  }
  async function loadImage() {
    const token = ++generation;
    bitmap?.close(); bitmap = null; draw();
    const file = $('mapart-source').value === 'temporary' ? $('mapart-file').files[0] : null;
    if (file && file.size > MAPART_FILE_LIMIT) throw new Error('Choose an image up to 5 MiB.');
    const image = images.find(item => item.id === $('mapart-image').value);
    if (!file && ($('mapart-source').value !== 'library' || !image)) return;
    const source = file || await fetch(image.url).then(response => { if (!response.ok) throw new Error('The library image is unavailable.'); return response.blob(); });
    const next = await createImageBitmap(source);
    if (token !== generation) { next.close(); return; }
    if (next.width * next.height > MAPART_PIXEL_LIMIT) { next.close(); throw new Error('Choose an image of at most 16 megapixels.'); }
    bitmap = next; draw();
  }
  async function loadLibrary() {
    const profile = $('mapart-poster').value;
    images = profile ? (await api(`/api/players/${profile}/images/`)).images : [];
    const previous = $('mapart-image').value;
    $('mapart-image').replaceChildren(new Option('Choose an image', ''), ...images.map(image => new Option(image.name, image.id)));
    if (images.some(image => image.id === previous)) $('mapart-image').value = previous;
  }
  function renderProgress(artwork) {
    const count = artwork.settings.columns * artwork.settings.rows;
    const states = {
      uploading: ['Waiting for your image', 'Finish uploading the image to join the conversion queue.', 0],
      queued: ['Queued for conversion', 'Waiting for the Minecraft server to pick up your image. It checks for queued artwork every 15 seconds.', 1],
      converting: ['Converting your image', `The server is converting your image into Minecraft map colors for ${count} tile${count === 1 ? '' : 's'}. Your preview and claim command will be available in your gallery.`, 2],
      ready: ['Ready to claim', 'Your artwork is ready. Copy the command below and run it in Minecraft. Bring blank maps unless you are in creative mode.', 3],
      failed: ['Conversion stopped', artwork.canRetry ? 'Conversion could not finish. You can retry below.' : 'Conversion could not finish. Create a new artwork to try again.', -1],
    };
    const [label, description, current] = states[artwork.status] || ['Status unavailable', 'Refresh to check this artwork again.', -1];
    const progress = node('div'); progress.className = 'mapart-job-progress'; progress.dataset.state = artwork.status;
    progress.setAttribute('role', 'group'); progress.setAttribute('aria-label', `${artwork.title} progress`);
    const heading = node('div'); heading.className = 'mapart-job-heading';
    const icon = node('span', artwork.status === 'ready' ? '✓' : artwork.status === 'failed' ? '!' : '');
    icon.className = 'mapart-job-icon'; icon.setAttribute('aria-hidden', 'true');
    heading.append(icon, node('strong', label)); progress.append(heading);
    if (current >= 0) {
      const steps = node('ol'); steps.className = 'mapart-job-steps'; steps.setAttribute('aria-label', 'Conversion stages');
      ['Image', 'Queue', 'Convert', 'Ready'].forEach((name, index) => {
        const step = node('li', name); step.dataset.state = index < current || artwork.status === 'ready' ? 'done' : index === current ? 'current' : 'pending';
        if (index === current) step.setAttribute('aria-current', 'step');
        steps.append(step);
      });
      progress.append(steps);
    }
    if (artwork.status === 'queued' || artwork.status === 'converting') {
      const activity = node('div'); activity.className = 'mapart-job-activity'; activity.setAttribute('role', 'progressbar');
      activity.setAttribute('aria-label', label); activity.setAttribute('aria-valuetext', `${label}. Waiting for the server to report the next stage.`);
      activity.append(node('span')); progress.append(activity);
    }
    const detail = node('p', description); detail.className = 'mapart-job-detail'; progress.append(detail);
    if (['uploading', 'queued', 'converting'].includes(artwork.status)) {
      const timing = node('p'); timing.className = 'mapart-job-timing';
      if (Number.isFinite(artwork.created)) timing.dataset.created = artwork.created;
      progress.append(timing);
    }
    return progress;
  }
  function updateProgressTimes() {
    const seconds = Math.max(0, Math.floor((Date.now() - lastChecked) / 1000));
    $('mapart-live-status').textContent = refreshFailed ? 'Live updates interrupted. Reconnecting automatically; you can also use Refresh above.' : lastChecked ? `Updates automatically every 15 seconds · ${seconds < 2 ? 'checked just now' : `last checked ${seconds}s ago`}` : 'Checking artwork status…';
    $('mapart-live-status').dataset.offline = String(refreshFailed);
    for (const element of document.querySelectorAll('.mapart-job-timing')) {
      const elapsed = Math.max(0, Math.floor((Date.now() - Number(element.dataset.created)) / 1000));
      const duration = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${Math.floor(elapsed / 3600)}h ${Math.floor(elapsed % 3600 / 60)}m`;
      element.textContent = `${element.dataset.created ? `Submitted ${duration} ago. ` : ''}${elapsed >= 300 ? 'Taking longer than usual. The server may be busy or restarting. ' : ''}You can leave this page and come back later.`;
    }
  }
  function renderArtworks() {
    const query = ($('mapart-search')?.value || '').trim().toLocaleLowerCase();
    const signature = JSON.stringify([context.artworks, query]);
    if (signature === artworkSignature) return;
    artworkSignature = signature;
    const announcements = [];
    for (const artwork of context.artworks) {
      if (previousStates.has(artwork.id) && previousStates.get(artwork.id) !== artwork.status) announcements.push(`${artwork.title}: ${artwork.status === 'ready' ? 'ready to claim' : artwork.status === 'failed' ? 'conversion stopped' : artwork.status}.`);
      if (creating && previousStates.has(artwork.id) && previousStates.get(artwork.id) !== 'ready' && artwork.status === 'ready') completedHere.add(artwork.id);
    }
    previousStates.clear(); context.artworks.forEach(artwork => previousStates.set(artwork.id, artwork.status));
    if (announcements.length) $('mapart-updates').textContent = announcements.join(' ');
    const finished = context.artworks.filter(artwork => artwork.status === 'ready');
    const pending = context.artworks.filter(artwork => artwork.status !== 'ready');
    const visible = (creating ? pending : finished).filter(artwork => !query || `${artwork.title} ${artwork.posterName || ''} ${artwork.posterSlug || ''}`.toLocaleLowerCase().includes(query));
    if (creating) {
      $('mapart-completed').replaceChildren();
      for (const artwork of finished.filter(artwork => completedHere.has(artwork.id))) {
        const notice = node('p', `${artwork.title} is ready. `); notice.className = 'mapart-completion';
        const link = node('a', 'View in gallery'); link.href = `/mapart/#mapart-${artwork.id}`; notice.append(link); $('mapart-completed').append(notice);
      }
    } else {
      $('mapart-pending-summary').replaceChildren();
      if (pending.length) {
        const link = node('a', `View ${pending.length} unfinished artwork${pending.length === 1 ? '' : 's'} and their progress`); link.href = '/mapart/create/#mapart-progress-heading'; $('mapart-pending-summary').append(link);
      }
    }
    $('mapart-artworks').replaceChildren();
    for (const artwork of visible) {
      const article = node('article'); article.className = 'mapart-artwork'; article.id = `mapart-${artwork.id}`;
      article.append(node('h3', artwork.title), node('p', `${artwork.settings.columns} × ${artwork.settings.rows} maps${artwork.posterName || artwork.posterSlug ? ` · ${artwork.posterName || artwork.posterSlug}` : ''}`));
      if (creating) article.append(renderProgress(artwork));
      if (artwork.error) article.append(node('p', artwork.error));
      if (artwork.previewUrl) { const img = node('img'); img.src = artwork.previewUrl; img.alt = `${artwork.title}, converted mapart`; img.loading = 'lazy'; article.append(img); }
      if (artwork.command) {
        article.append(node('p', `Each copy costs ${artwork.settings.columns * artwork.settings.rows} blank maps, or is free in creative mode.`), node('code', artwork.command));
        const copy = node('button', 'Copy claim command'); copy.type = 'button'; copy.addEventListener('click', () => action(async () => { await navigator.clipboard.writeText(artwork.command); copy.textContent = 'Copied'; })); article.append(copy);
      }
      const actions = node('div'); actions.className = 'mapart-actions';
      if (artwork.canRetry) {
        const retry = node('button', 'Retry conversion'); retry.type = 'button'; retry.addEventListener('click', () => action(async () => { await api(`/api/mapart/${artwork.id}/retry/`, 'POST', {}); await refresh(); })); actions.append(retry);
      }
      const remove = node('button', artwork.status === 'ready' ? 'Delete artwork' : 'Cancel / delete'); remove.type = 'button';
      remove.addEventListener('click', () => action(async () => { if (confirm('Delete this artwork and disable future claims? Maps already issued will remain in the world.')) { await api(`/api/mapart/${artwork.id}/`, 'DELETE'); await refresh(); } })); actions.append(remove);
      article.append(actions); $('mapart-artworks').append(article);
    }
    if (!visible.length) $('mapart-artworks').append(node('p', creating ? 'No artwork is waiting or converting. Create something above to get started.' : query ? 'No artwork matches that player or name. Try another search.' : 'Your gallery is empty. Create mapart to add your first artwork.'));
    $('mapart-usage').textContent = creating ? `${pending.length} unfinished artwork${pending.length === 1 ? '' : 's'}. Limit: ${context.limits?.pending || 5} unfinished jobs per member.` : `${visible.length} of ${finished.length} finished artwork${finished.length === 1 ? '' : 's'} shown.`;
    if (!creating && !followedGalleryLink && location.hash.startsWith('#mapart-')) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) { target.scrollIntoView(); followedGalleryLink = true; }
    }
  }
  async function refresh() {
    context = await api(`/api/mapart/context/${$('mapart-show-all').checked ? '?scope=all' : ''}`);
    lastChecked = Date.now(); refreshFailed = false;
    csrf = context.user?.csrf || '';
    $('mapart-sign-in').hidden = Boolean(context.user);
    $('mapart-member').hidden = !context.user;
    $('mapart-owner-controls').hidden = !context.user?.owner;
    $('mapart-account-status').textContent = context.user ? 'Signed in. Permissions checked against your current Discord roles.' : 'Sign in to create and collect your personal mapart.';
    if (!context.user) return;
    const used = context.usage?.used || 0, storageLimit = context.usage?.limit || 104857600;
    $('mapart-storage-label').textContent = `Your mapart storage: ${fileSize(used)} of ${fileSize(storageLimit)} used. Includes map data, previews, and temporary uploads until deleted.`;
    $('mapart-storage').max = storageLimit; $('mapart-storage').value = Math.min(used, storageLimit);
    if (creating) {
      const previous = $('mapart-poster').value;
      const hasProfiles = context.postingPlayers.length > 0;
      $('mapart-poster').replaceChildren(...(hasProfiles ? context.postingPlayers.map(player => new Option(player.name, player.slug)) : [new Option('No verified Minecraft profile available', '')]));
      $('mapart-poster').disabled = !hasProfiles;
      if (context.postingPlayers.some(player => player.slug === previous)) $('mapart-poster').value = previous;
      const unverified = context.unverifiedPlayers || [];
      $('mapart-availability').textContent = !context.enabled ? 'Submissions will open after the server companion and crossplay checks are complete.' : hasProfiles ? 'Select your image and inspect its composition before creating the mapart.' : unverified.length ? `Your Discord role matches ${unverified.map(player => player.name).join(', ')}, but the Minecraft account has not been verified. Ask the wiki owner to verify the existing player page using “Fetch name & head” on the account page, then refresh permissions here. Capitalization does not matter.` : 'No player page matches your Discord IGN roles. You need a player page, a verified Minecraft account, and a matching Discord IGN role. Capitalization does not matter.';
      $('mapart-submit').disabled = busy || !context.enabled || !context.postingPlayers.length;
    }
    renderArtworks(); updateProgressTimes();
  }
  async function action(work, status = $('mapart-form-status') || $('mapart-account-status')) {
    if (busy) return;
    busy = true;
    if (creating) $('mapart-submit').disabled = true;
    try { await work(); } catch (error) { status.textContent = `${error.message}${error.status === 401 ? ' Sign in in the new tab, then refresh permissions and retry.' : ''}`; }
    finally { busy = false; if (creating) $('mapart-submit').disabled = !context?.user || !context.enabled || !context.postingPlayers.length; }
  }
  $('mapart-form')?.addEventListener('submit', event => {
    event.preventDefault(); action(async () => {
      // Refresh CSRF/roles after a sign-in in another tab, preserving the local draft.
      await refresh();
      if (!context.user) throw new Error('Sign in, then refresh permissions and retry.');
      if (!draft) {
        const fields = mapartFields(settings()), library = $('mapart-source').value === 'library';
        if (!bitmap || (library && !$('mapart-image').value) || (!library && !$('mapart-file').files[0])) throw new Error('Choose an image and wait for its preview.');
        draft = { id: crypto.randomUUID(), posterSlug: $('mapart-poster').value, ...fields, ...(library ? { mediaId: $('mapart-image').value } : {}) };
        $('mapart-settings').disabled = true;
      }
      // Reusing the same ID makes a lost create response safe to retry.
      await api('/api/mapart/', 'POST', draft);
      if (!draft.mediaId) {
        $('mapart-submit').textContent = 'Retry image upload';
        const form = new FormData(); form.set('file', $('mapart-file').files[0]);
        $('mapart-progress').hidden = false;
        await api(`/api/mapart/${draft.id}/source/`, 'POST', form, { onProgress: (loaded, total) => { $('mapart-progress').value = total ? loaded / total * 100 : 0; } });
      }
      previousStates.set(draft.id, 'queued');
      reset(); $('mapart-form-status').textContent = 'Queued for conversion. Follow its progress below; the finished artwork and claim command will appear in your gallery.'; await refresh();
    });
  });
  function reset() { draft = null; $('mapart-form').reset(); $('mapart-settings').disabled = false; $('mapart-submit').textContent = 'Create mapart'; $('mapart-progress').hidden = true; bitmap?.close(); bitmap = null; generation++; sourceDisplay(); draw(); }
  function sourceDisplay() { const library = $('mapart-source').value === 'library'; $('mapart-library-picker').hidden = !library; $('mapart-upload').hidden = library; }
  $('mapart-cancel')?.addEventListener('click', () => action(async () => { if (draft) { try { await api(`/api/mapart/${draft.id}/`, 'DELETE'); } catch (error) { if (error.status !== 404) throw error; } } reset(); $('mapart-form-status').textContent = ''; }));
  $('mapart-refresh').addEventListener('click', () => action(refresh, $('mapart-account-status')));
  $('mapart-show-all').addEventListener('change', () => action(refresh));
  $('mapart-search')?.addEventListener('input', renderArtworks);
  $('mapart-source')?.addEventListener('change', () => action(async () => { sourceDisplay(); if ($('mapart-source').value === 'library') await loadLibrary(); await loadImage(); }));
  $('mapart-poster')?.addEventListener('change', () => action(async () => { await loadLibrary(); if ($('mapart-source').value === 'library') await loadImage(); }));
  for (const id of ['mapart-file', 'mapart-image']) $(id)?.addEventListener('change', () => { loadImage().catch(error => { $('mapart-form-status').textContent = error.message; }); });
  for (const id of ['mapart-columns', 'mapart-rows']) $(id)?.addEventListener('input', draw);
  for (const id of ['mapart-fit', 'mapart-grid']) $(id)?.addEventListener('change', draw);
  document.querySelectorAll('input[name="mapart-alignment"]').forEach(input => input.addEventListener('change', draw));
  setInterval(() => {
    if (document.hidden || busy || refreshing) return;
    refreshing = true;
    refresh().catch(error => { refreshFailed = true; updateProgressTimes(); $('mapart-account-status').textContent = error.message; }).finally(() => { refreshing = false; });
  }, 15000);
  setInterval(() => { if (!document.hidden && context?.user) updateProgressTimes(); }, 1000);
  if (creating) draw();
  action(refresh, $('mapart-account-status'));
}

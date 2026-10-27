import { createApi } from './api.js';
import { MUSIC_FILE_LIMIT, musicSource } from '../../shared/music.mjs';
import { musicStatusText, claimHtml, musicDiscHtml } from '../../shared/music-render.mjs';
import './music-claims.js';
import './music-playback.js';
import { musicCoverUrl } from '../../shared/music-cover.mjs';

const $ = id => document.getElementById(id);
let context = null, page = 1, draftId = crypto.randomUUID(), savedDraft = false, previewUrl = null, busy = false, cooldownUntil = 0;
let metadataSequence = 0, metadataTimer;
let matchedAudioUrl = null, coverEdited = false;
const signIn = $('music-sign-in');
const api = createApi({ csrf: () => context?.user?.csrf, onUnauthorized: () => { signIn.hidden = false; signIn.target = '_blank'; signIn.rel = 'noopener'; } });
const mb = bytes => (bytes / 1024 / 1024).toFixed(1);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
function errorText(error) {
  if (error.retryAfter) {
    cooldownUntil = Date.now() + error.retryAfter * 1000;
    setTimeout(() => { cooldownUntil = 0; setBusy(false); }, error.retryAfter * 1000);
  }
  return error.message;
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('#music-member button, #music-refresh').forEach(button => { button.disabled = value || Date.now() < cooldownUntil || button.dataset.unavailable === 'true'; });
}
function sourceMode() {
  const link = $('music-source-type').value === 'link';
  $('music-link-fields').hidden = !link; $('music-source-url').required = link;
  $('music-file').required = !link; $('music-file-optional').hidden = !link;
  scheduleMetadataLookup();
}
function cancelMetadataLookup() {
  metadataSequence++; clearTimeout(metadataTimer);
  $('music-metadata-status').textContent = '';
}
function scheduleMetadataLookup() {
  cancelMetadataLookup();
  clearMatch();
  if (!savedDraft && !coverEdited) { $('music-cover-url').value = ''; renderCoverPreview(); }
  let source;
  try { source = $('music-source-type').value === 'link' ? musicSource($('music-source-url').value) : null; } catch { source = null; }
  $('music-matching').hidden = source?.kind !== 'spotify';
  if (savedDraft || busy || !source || source.kind === 'file') return;
  const sequence = metadataSequence;
  metadataTimer = setTimeout(async () => {
    const titleBefore = $('music-title').value, artistBefore = $('music-artist').value;
    $('music-metadata-status').textContent = source.kind === 'spotify' ? 'Looking up Spotify track…' : 'Looking up YouTube video…';
    try {
      const details = await api('/api/music/metadata/', 'POST', { sourceUrl: source.url });
      if (sequence !== metadataSequence || savedDraft) return;
      // A slow response must not replace edits made while the lookup was running.
      if ($('music-title').value === titleBefore) $('music-title').value = details.title;
      if ($('music-artist').value === artistBefore) $('music-artist').value = details.artist;
      if (!coverEdited) { $('music-cover-url').value = details.coverUrl || ''; renderCoverPreview(); }
      $('music-metadata-status').textContent = details.artistIsChannel ? 'YouTube title and channel filled in. Edit the artist if the channel is not the performer.' : 'Spotify details loaded. You can edit the title and artists below.';
    } catch (error) {
      if (sequence === metadataSequence && !savedDraft) $('music-metadata-status').textContent = error.message || 'Could not load track details. Enter the title and artist manually.';
    }
  }, 350);
}
function clearMatch() {
  matchedAudioUrl = null;
  $('music-confirm-match').checked = false;
  $('music-audio-source').value = '';
  $('music-match-preview').replaceChildren(); $('music-match-preview').hidden = true;
  $('music-match-results').replaceChildren(); $('music-match-status').textContent = '';
}
function previewRecording(url, container) {
  const source = musicSource(url);
  if (source.kind !== 'youtube') throw new Error('Choose an individual YouTube video.');
  const id = new URL(source.url).searchParams.get('v');
  const frame = node('iframe'); frame.src = `https://www.youtube-nocookie.com/embed/${id}`; frame.title = 'Preview selected recording';
  frame.loading = 'lazy'; frame.allow = 'encrypted-media; picture-in-picture'; frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
  const link = node('a', 'Open recording on YouTube'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const video = node('div', undefined, 'music-recording-video'); video.append(frame);
  container.replaceChildren(video, link); container.hidden = false;
  return source.url;
}
function chooseMatch(url) {
  matchedAudioUrl = previewRecording(url, $('music-match-preview'));
  $('music-audio-source').value = matchedAudioUrl;
  $('music-confirm-match').checked = false;
  $('music-match-status').textContent = 'Listen to the recording, then confirm it below.';
}
function renderCoverPreview() { $('music-cover-preview').innerHTML = musicDiscHtml({ coverUrl: $('music-cover-url').value }); }
function resetForm() {
  $('music-form').reset(); $('music-metadata').disabled = false;
  draftId = crypto.randomUUID(); savedDraft = false; coverEdited = false;
  $('music-submit').textContent = 'Submit for review';
  $('music-upload-progress').hidden = true; $('music-preview').hidden = true;
  $('music-preview').removeAttribute('src');
  if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
  sourceMode();
}
async function upload(id, file) {
  if (!file || file.size > MUSIC_FILE_LIMIT) throw new Error('Choose an audio file up to 20 MB.');
  const data = new FormData(); data.append('file', file);
  $('music-upload-progress').hidden = false;
  return api(`/api/music/${id}/audio/`, 'POST', data, { onProgress: (loaded, total) => { $('music-upload-progress').value = total ? loaded / total * 100 : 0; } });
}
async function action(work, status = $('music-account-status')) {
  if (busy || Date.now() < cooldownUntil) return;
  setBusy(true); status.textContent = '';
  try { await work(); } catch (error) { status.textContent = errorText(error); }
  finally { setBusy(false); }
}
function button(label, work) {
  const element = node('button', label); element.type = 'button';
  element.addEventListener('click', () => action(work)); return element;
}
function renderLibrary() {
  const library = $('music-library'); library.replaceChildren();
  for (const track of context.submissions) {
    const row = node('article', undefined, 'music-library-row'); row.dataset.musicId = track.id;
    row.insertAdjacentHTML('beforeend', musicDiscHtml(track));
    row.append(node('h3', track.title), node('p', `${track.artist || 'Artist not specified'} · ${track.poster.name}`), node('p', musicStatusText(track), 'music-state'));
    const claim = node('div'); claim.dataset.musicClaimSlot = ''; claim.innerHTML = claimHtml(track); row.append(claim);
    if (track.sourceUrl) { const link = node('a', track.sourceKind === 'spotify' ? 'Spotify track' : 'YouTube video'); link.href = track.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
    if (track.audioSourceUrl) { const link = node('a', 'Confirmed YouTube recording'); link.href = track.audioSourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(node('p', 'Audio matched from YouTube.'), link); }
    if (track.reviewNote) row.append(node('p', `Review: ${track.reviewNote}`, 'music-note'));
    if (track.hasAudio) {
      const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.src = track.audioUrl; audio.setAttribute('aria-label', `Preview ${track.title}`); row.append(audio);
      row.append(node('p', track.filename, 'music-note'));
    } else row.append(node('p', track.uploading ? 'An audio upload is in progress.' : track.sourceKind === 'youtube' || track.audioSourceUrl ? 'The server will try to fetch the confirmed recording after approval. You can attach audio before approval.' : 'Attach an audio file or confirm a YouTube recording before this track can be approved.', 'music-note'));
    if (track.sourceKind === 'spotify' && !track.hasAudio && !track.uploading && ['pending', 'rejected'].includes(track.status)) {
      const details = node('details'), input = node('input'), confirm = node('input'), preview = node('div');
      input.type = 'url'; input.id = `music-source-${track.id}`; input.value = track.audioSourceUrl || ''; input.maxLength = 2048;
      confirm.type = 'checkbox'; preview.className = 'music-recording-preview'; preview.hidden = true;
      const label = node('label', 'YouTube recording link'); label.htmlFor = input.id;
      const confirmation = node('label', undefined, 'music-match-confirm'); confirmation.append(confirm, document.createTextNode(' I listened and confirm this recording.'));
      let selected = null;
      input.addEventListener('input', () => { selected = null; confirm.checked = false; preview.replaceChildren(); preview.hidden = true; });
      details.append(node('summary', 'Choose or change the audio recording'), label, input,
        button('Preview recording', () => { selected = previewRecording(input.value, preview); confirm.checked = false; }), preview, confirmation,
        button('Save recording', async () => {
          if (!selected || !confirm.checked) throw new Error('Preview and confirm the recording before saving.');
          await api(`/api/music/${track.id}/source/`, 'POST', { audioSourceUrl: selected, audioSourceConfirmed: true, version: track.version });
          await refresh(); $('music-account-status').textContent = 'Recording saved and submitted for review.';
        }));
      row.append(details);
    }
    if (!track.hasAudio && !track.uploading && ['pending', 'rejected'].includes(track.status)) {
      const input = node('input'); input.type = 'file'; input.accept = '.mp3,.wav,.ogg,.flac,.m4a,audio/*'; input.id = `music-audio-${track.id}`;
      const label = node('label', 'Attach audio'); label.htmlFor = input.id;
      row.append(label, input, button('Upload audio', async () => { await upload(track.id, input.files[0]); await refresh(); $('music-account-status').textContent = 'Audio uploaded.'; }));
    }
    if (track.canManage) {
      const details = node('details', undefined, 'music-cover-editor'), input = node('input');
      input.type = 'url'; input.id = `music-cover-${track.id}`; input.value = track.coverUrl || ''; input.maxLength = 2048;
      const label = node('label', 'Album cover URL (optional)'); label.htmlFor = input.id;
      const preview = node('div'); preview.innerHTML = musicDiscHtml(track);
      input.addEventListener('input', () => { preview.innerHTML = musicDiscHtml({ coverUrl: input.value }); });
      details.append(node('summary', 'Edit album cover'), label, input, node('p', 'Use a direct HTTPS image link, or leave empty for a plain disc.', 'music-note'), preview);
      if (['spotify', 'youtube'].includes(track.sourceKind)) details.append(button(track.sourceKind === 'spotify' ? 'Use Spotify cover' : 'Use YouTube thumbnail', async () => {
        const original = input.value;
        const metadata = await api('/api/music/metadata/', 'POST', { sourceUrl: track.sourceUrl });
        if (!metadata.coverUrl) throw new Error('No artwork is available for this link. Paste an image link instead.');
        if (input.value !== original) return;
        input.value = metadata.coverUrl; preview.innerHTML = musicDiscHtml({ coverUrl: input.value });
      }));
      details.append(button('Save cover', async () => {
        await api(`/api/music/${track.id}/cover/`, 'POST', { coverUrl: musicCoverUrl(input.value), version: track.version });
        await refresh(); $('music-account-status').textContent = 'Album cover saved.';
      }));
      row.append(details);
    }
    const actions = node('div', undefined, 'music-actions');
    if (track.hasAudio && ['pending', 'rejected'].includes(track.status)) actions.append(button('Remove audio file', async () => {
      if (!confirm(`Remove the audio file from “${track.title}”? You can upload a replacement.`)) return;
      const result = await api(`/api/music/${track.id}/audio/`, 'DELETE', { version: track.version });
      await refresh(); $('music-account-status').textContent = result.deletionPending ? 'Audio deletion is pending. Storage will be freed when it finishes.' : 'Audio removed. You can now attach a replacement.';
    }));
    if (['pending', 'rejected'].includes(track.status)) actions.append(button('Remove from library', async () => {
      if (!confirm(`Remove “${track.title}” from your library?`)) return;
      const result = await api(`/api/music/${track.id}/`, 'DELETE', { version: track.version }); await refresh(); $('music-account-status').textContent = result.deletionPending ? 'Track removed. Storage will be freed when deletion finishes.' : 'Track removed.';
    }));
    if (context.user.owner && track.status !== 'released') {
      const label = node('label', 'Review note (optional)'), note = node('textarea'); note.id = `music-note-${track.id}`; note.maxLength = 500; note.rows = 2; note.value = track.reviewNote; label.htmlFor = note.id;
      row.append(label, note);
      for (const [state, text] of [['approved', 'Approve for server'], ['rejected', 'Request changes']]) {
        const review = button(text, async () => { await api(`/api/music/${track.id}/review/`, 'POST', { status: state, note: note.value, version: track.version }); await refresh(); $('music-account-status').textContent = state === 'approved' ? 'Approved. The server will pick up this track.' : 'Review saved.'; });
        if (state === 'approved') { review.disabled = track.uploading || (!track.hasAudio && track.sourceKind !== 'youtube' && !track.audioSourceUrl); review.dataset.unavailable = String(review.disabled); }
        actions.append(review);
      }
    }
    row.append(actions); library.append(row);
  }
  if (!context.submissions.length) library.append(node('p', 'Your library is empty. Add an audio file or track link to get started.'));
  $('music-library-prev').hidden = page <= 1; $('music-library-next').hidden = !context.hasMore;
}
function renderDelivery(delivery) {
  const banner = $('music-delivery');
  banner.hidden = !delivery;
  banner.textContent = !delivery ? '' : delivery.state === 'failed' ? `Server update failed: ${delivery.message}` : delivery.state === 'waiting' && delivery.message ? delivery.message : delivery.heartbeat ? `Music server last connected: ${new Date(delivery.heartbeat).toLocaleString()}.` : 'Music server is not connected yet. Approved tracks will wait for the server connection.';
}
async function refresh() {
  const scope = $('music-show-all').checked ? '&scope=all' : '';
  context = await api(`/api/music/context/?page=${page}${scope}`);
  signIn.hidden = Boolean(context.user);
  $('music-member').hidden = !context.user;
  renderDelivery(context.delivery);
  if (context.user) {
    const selected = $('music-poster').value;
    $('music-poster').replaceChildren(...context.postingPlayers.map(player => { const option = node('option', player.name); option.value = player.slug; return option; }));
    if (context.postingPlayers.some(player => player.slug === selected)) $('music-poster').value = selected;
    $('music-add').hidden = !context.postingPlayers.length;
    $('music-usage').textContent = `${mb(context.usage.used)} MB of ${mb(context.usage.limit)} MB used`;
    $('music-storage').value = context.usage.used;
    $('music-owner-controls').hidden = !context.user.owner;
    renderLibrary();
  }
}
$('music-cover-url').addEventListener('input', () => { coverEdited = true; renderCoverPreview(); });
$('music-source-type').addEventListener('change', sourceMode);
$('music-source-url').addEventListener('input', scheduleMetadataLookup);
$('music-audio-source').addEventListener('input', () => {
  matchedAudioUrl = null; $('music-confirm-match').checked = false;
  $('music-match-preview').replaceChildren(); $('music-match-preview').hidden = true;
});
$('music-preview-match').addEventListener('click', () => action(() => chooseMatch($('music-audio-source').value), $('music-match-status')));
$('music-find-matches').addEventListener('click', () => action(async () => {
  const source = musicSource($('music-source-url').value), sequence = metadataSequence;
  if (source.kind !== 'spotify') throw new Error('Paste a Spotify track link first.');
  $('music-match-status').textContent = 'Searching for possible recordings…';
  const result = await api('/api/music/matches/', 'POST', { sourceUrl: source.url });
  if (sequence !== metadataSequence || savedDraft) return;
  $('music-match-results').replaceChildren();
  for (const candidate of result.candidates) {
    const row = node('article', undefined, 'music-match-candidate');
    const duration = `${Math.floor(candidate.durationSeconds / 60)}:${String(candidate.durationSeconds % 60).padStart(2, '0')}`;
    row.append(node('h4', candidate.title), node('p', `${candidate.channel} · ${duration}`), button('Choose and preview', () => chooseMatch(candidate.url)));
    $('music-match-results').append(row);
  }
  $('music-match-status').textContent = result.candidates.length ? 'Choose a recording and listen before confirming. Matches may be different versions.' : 'No suitable recordings found. Paste a specific YouTube video below or upload a file.';
}, $('music-match-status')));
$('music-file').addEventListener('change', () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const file = $('music-file').files[0]; previewUrl = file ? URL.createObjectURL(file) : null;
  $('music-preview').hidden = !previewUrl;
  if (previewUrl) $('music-preview').src = previewUrl; else $('music-preview').removeAttribute('src');
});
$('music-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    cancelMetadataLookup();
    const file = $('music-file').files[0], link = $('music-source-type').value === 'link';
    if (file?.size > MUSIC_FILE_LIMIT) throw new Error('Audio files must be 20 MB or smaller.');
    if (!link && !file) throw new Error('Choose an audio file.');
    const source = link ? musicSource($('music-source-url').value) : null;
    const coverUrl = musicCoverUrl($('music-cover-url').value);
    const audioSourceUrl = !file && source?.kind === 'spotify' ? matchedAudioUrl : null;
    if (!savedDraft && !file && source?.kind === 'spotify' && (!audioSourceUrl || !$('music-confirm-match').checked)) throw new Error('Choose, preview and confirm a recording, or attach an audio file.');
    if (!savedDraft) {
      await api('/api/music/', 'POST', { id: draftId, posterSlug: $('music-poster').value, title: $('music-title').value, artist: $('music-artist').value, coverUrl, sourceUrl: link ? $('music-source-url').value : '', ...(audioSourceUrl ? { audioSourceUrl, audioSourceConfirmed: true } : {}) });
      savedDraft = true; $('music-metadata').disabled = true;
    }
    if (file) {
      $('music-form-status').textContent = 'Submission saved. Uploading audio…';
      $('music-submit').textContent = 'Retry audio upload';
      await upload(draftId, file);
    }
    resetForm(); $('music-form-status').textContent = 'Added to your library and submitted for review.'; await refresh();
  }, $('music-form-status'));
});
$('music-cancel').addEventListener('click', () => { resetForm(); $('music-form-status').textContent = ''; });
$('music-refresh').addEventListener('click', () => action(refresh));
$('music-show-all').addEventListener('change', () => { page = 1; action(refresh); });
$('music-library-prev').addEventListener('click', () => { page--; action(refresh); });
$('music-library-next').addEventListener('click', () => { page++; action(refresh); });
sourceMode();
action(refresh);

// Poll only read-only status nodes; draft fields, selected files and review notes
// remain the same DOM nodes throughout background updates.
let polling = false;
async function pollProgress() {
  if (document.hidden || busy || polling) return;
  polling = true;
  try {
    const scope = $('music-show-all').checked ? '&scope=all' : '';
    const latest = context?.user ? await api(`/api/music/context/?page=${page}${scope}`) : null;
    if (busy) return;
    renderDelivery(latest?.delivery);
    for (const track of latest?.submissions || []) {
      const row = document.querySelector(`[data-music-id="${track.id}"]`);
      if (!row) continue;
      row.querySelector('.music-state').textContent = musicStatusText(track);
      row.querySelector('[data-music-claim-slot]').innerHTML = claimHtml(track);
    }
  } catch { /* Retain the editable library on transient network failures. */ }
  finally { polling = false; }
}
setInterval(pollProgress, 15000);
document.addEventListener('visibilitychange', pollProgress);

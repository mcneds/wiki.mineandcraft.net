import { createApi } from './api.js';
import { MUSIC_FILE_LIMIT } from '../../shared/music.mjs';
import { musicStatusText } from '../../shared/music-render.mjs';
import { headClaimHtml } from '../../shared/heads-render.mjs';
import './head-claims.js';
import './music-playback.js';

const $ = id => document.getElementById(`heads-${id}`);
const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
let context, target, lookupSequence = 0, page = 1, draftId = crypto.randomUUID(), saved = false, busy = false, previewUrl;
const api = createApi({ csrf: () => context?.user?.csrf, onUnauthorized: () => { $('sign-in').hidden = false; } });
async function action(work, status = $('status')) {
  if (busy) return;
  busy = true; status.textContent = '';
  document.querySelectorAll('#heads-member button, #heads-refresh').forEach(b => { b.disabled = true; });
  try { await work(); } catch (error) { status.textContent = error.message; }
  finally { busy = false; document.querySelectorAll('#heads-member button, #heads-refresh').forEach(b => { b.disabled = b.dataset.unavailable === 'true'; }); }
}
function button(label, work, unavailable = false) {
  const el = node('button', label); el.type = 'button'; el.disabled = unavailable; el.dataset.unavailable = String(unavailable);
  el.addEventListener('click', () => action(work)); return el;
}
function reset() {
  $('form').reset(); $('fields').disabled = false; saved = false; draftId = crypto.randomUUID(); target = null; lookupSequence++;
  $('target').replaceChildren(); $('preview').hidden = true; $('preview').removeAttribute('src'); $('progress').hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
}
async function lookup() {
  const sequence = ++lookupSequence, name = $('name').value.trim(), edition = $('edition').value;
  target = null; $('target').textContent = 'Looking up head…';
  const result = await api('/api/heads/lookup/', 'POST', { name, edition });
  if (sequence !== lookupSequence || name !== $('name').value.trim() || edition !== $('edition').value) return;
  target = { ...result, query: name };
  const image = node('img'); image.src = result.preview; image.alt = `${result.name}’s head`; image.width = 96; image.height = 96;
  $('target').replaceChildren(image, node('p', `${result.name} (${result.edition})`));
  if (!result.canReplace) $('target').append(node('p', 'Another member manages this head.'));
  else if (result.canTakeOver) $('target').append(node('p', 'This is your account. Submitting takes control and replaces any previous pending submission. The installed sound stays until your replacement is approved and installed.'));
  else if (result.association?.hasPending) $('target').append(node('p', 'This head already has a pending submission. Manage it below or ask the owner to resolve it.'));
  else if (result.association) $('target').append(node('p', 'Submitting creates a replacement for review. The installed sound stays active until the replacement is installed.'));
}
async function upload(id, file) {
  if (!file || file.size > MUSIC_FILE_LIMIT) throw new Error('Choose an audio file up to 20 MB.');
  const data = new FormData(); data.append('file', file); $('progress').hidden = false;
  await api(`/api/music/${id}/audio/`, 'POST', data, { onProgress: (loaded, total) => { $('progress').value = total ? loaded / total * 100 : 0; } });
}
function library() {
  $('library').replaceChildren();
  for (const track of context.submissions) {
    const row = node('article'); row.className = 'music-library-row';
    const image = node('img'); image.src = track.head.image; image.alt = ''; image.width = 64; image.height = 64;
    row.append(image, node('h3', `${track.head.name}: ${track.title}`), node('p', musicStatusText(track)));
    if (track.reviewNote) row.append(node('p', `Review: ${track.reviewNote}`));
    const claim = node('div'); claim.innerHTML = headClaimHtml(track); row.append(claim);
    if (track.hasAudio) {
      const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.src = track.audioUrl; row.append(audio);
      row.append(node('p', track.validation === 'valid' ? `Validated: ${(track.durationMs / 1000).toFixed(2)} seconds` : track.validation === 'invalid' ? 'Audio rejected: upload a valid file no longer than 10 seconds.' : 'Waiting for server audio validation.'));
    }
    if (['pending', 'rejected'].includes(track.status)) {
      if (track.hasAudio) row.append(button('Remove audio', async () => { await api(`/api/music/${track.id}/audio/`, 'DELETE', { version: track.version }); await refresh(); }));
      else if (!track.uploading) {
        const file = node('input'); file.type = 'file'; file.accept = '.mp3,.wav,.ogg,.flac,.m4a'; file.setAttribute('aria-label', `Audio for ${track.title}`);
        row.append(file, button('Upload audio', async () => { await upload(track.id, file.files[0]); await refresh(); }));
      }
      row.append(button('Delete submission', async () => { await api(`/api/music/${track.id}/`, 'DELETE', { version: track.version }); await refresh(); }));
    }
    if (context.user.owner && track.status !== 'released') {
      const note = node('textarea'); note.maxLength = 500; note.setAttribute('aria-label', `Review note for ${track.title}`); note.value = track.reviewNote;
      row.append(note, button('Approve', async () => { await api(`/api/music/${track.id}/review/`, 'POST', { version: track.version, status: 'approved', note: note.value }); await refresh(); }, track.validation !== 'valid' || track.uploading),
        button('Request changes', async () => { await api(`/api/music/${track.id}/review/`, 'POST', { version: track.version, status: 'rejected', note: note.value }); await refresh(); }));
    }
    $('library').append(row);
  }
}
async function refresh() {
  context = await api(`/api/heads/context/?page=${page}${$('all').checked ? '&scope=all' : ''}`);
  $('sign-in').hidden = Boolean(context.user); $('member').hidden = !context.user;
  if (!context.user) return;
  const selected = $('poster').value;
  $('poster').replaceChildren(...context.postingPlayers.map(p => { const o = node('option', p.name); o.value = p.slug; return o; }));
  if (context.postingPlayers.some(p => p.slug === selected)) $('poster').value = selected;
  $('owner').hidden = !context.user.owner;
  $('usage').textContent = `${(context.usage.used / 1048576).toFixed(1)} MB of ${(context.usage.limit / 1048576).toFixed(0)} MB used by music and head sounds.`;
  $('storage').value = context.usage.used;
  $('prev').hidden = page <= 1; $('next').hidden = !context.hasMore;
  library();
}
$('lookup').addEventListener('click', () => action(lookup, $('form-status')));
for (const id of ['name', 'edition']) $(id).addEventListener('input', () => { target = null; lookupSequence++; $('target').replaceChildren(); });
$('file').addEventListener('change', () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const file = $('file').files[0]; previewUrl = file ? URL.createObjectURL(file) : null;
  $('preview').hidden = !file;
  if (previewUrl) $('preview').src = previewUrl;
});
$('preview').addEventListener('loadedmetadata', () => { $('form-status').textContent = $('preview').duration > 10 ? 'This file exceeds 10 seconds. Trim it before uploading.' : ''; });
$('form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const file = $('file').files[0];
    if (!file || file.size > MUSIC_FILE_LIMIT) throw new Error('Choose a file up to 20 MB.');
    if (Number.isFinite($('preview').duration) && $('preview').duration > 10) throw new Error('Trim this file to 10 seconds or less before uploading.');
    if (!target) await lookup();
    if (!target?.canReplace || (!saved && target.association?.hasPending && !target.canTakeOver)) throw new Error('This head is not available for a new submission.');
    if (!saved) {
      await api('/api/heads/', 'POST', { id: draftId, title: $('title').value, posterSlug: $('poster').value, name: target.query, edition: target.edition, version: target.association?.version });
      saved = true; $('fields').disabled = true;
    }
    await upload(draftId, file); reset(); await refresh(); $('form-status').textContent = 'Uploaded. Waiting for server validation and owner review.';
  }, $('form-status'));
});
$('clear').addEventListener('click', reset);
$('refresh').addEventListener('click', () => action(refresh));
$('all').addEventListener('change', () => { page = 1; action(refresh); });
$('prev').addEventListener('click', () => { page--; action(refresh); });
$('next').addEventListener('click', () => { page++; action(refresh); });
action(refresh);

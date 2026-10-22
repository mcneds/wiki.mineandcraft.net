import { createApi } from './api.js';
import { PRESET_TAGS } from '../../shared/coordinates.mjs';
import { entryHtml } from '../../shared/coordinate-render.mjs';

const $ = selector => document.querySelector(selector);
const form = $('#coordinate-form');
let context, current, changed = false, busy = false, authStale = false, pendingUpload, retryTimer, imageGeneration = 0;
const status = text => { $('#coordinate-form-status').textContent = text; };
const api = createApi({ csrf: () => context?.user?.csrf || '', onUnauthorized: () => {
  authStale = true; $('#coordinate-sign-in').hidden = false; $('#coordinate-sign-in').target = '_blank';
} });
async function run(button, action) {
  if (button) button.disabled = true;
  try { await action(); } catch (error) { status(error.message); $('#coordinate-account-status').textContent = error.message; }
  finally { if (button) button.disabled = false; }
}
function editable() {
  document.querySelectorAll('.edit-coordinate').forEach(button => { button.hidden = !context?.editableIds?.includes(button.dataset.id); });
}
async function refreshContext() {
  $('#coordinate-check-access').hidden = true;
  try { context = await api('/api/coordinates/context/'); }
  catch (error) { $('#coordinate-check-access').hidden = false; throw error; }
  authStale = false;
  $('#coordinate-sign-in').hidden = Boolean(context.user);
  $('#add-coordinate').hidden = !context.postingPlayers.length;
  $('#coordinate-account-status').textContent = context.user ? context.postingPlayers.length || context.user.owner ? '' : 'Add your player page with its matching Discord IGN role before submitting an entry.' : '';
  if (context.user && !context.postingPlayers.length) {
    const link = document.createElement('a'); link.href = '/account/'; link.textContent = ' Add player page'; $('#coordinate-account-status').append(link);
  }
  editable();
}
function discard() {
  if (busy) { status('Wait for the upload to finish.'); return false; }
  return !changed || confirm('Discard your unsaved entry changes?');
}
function clearUpload() {
  pendingUpload = null; clearTimeout(retryTimer); $('#coordinate-retry-upload').hidden = true;
  $('#coordinate-upload-sign-in').hidden = true; $('#coordinate-upload-status').textContent = ''; $('#coordinate-image-upload').value = '';
}
function visibility() {
  const privateEntry = $('#coordinate-access').value === 'private';
  $('#coordinate-location-fields').hidden = privateEntry; $('#coordinate-location-fields').disabled = privateEntry;
  $('#coordinate-private-note').hidden = !privateEntry;
  if (privateEntry) for (const axis of ['dimension', 'x', 'y', 'z']) $(`#coordinate-${axis}`).value = '';
  else if (!$('#coordinate-dimension').value) $('#coordinate-dimension').value = 'overworld';
}
function imagePreview() {
  const id = $('#coordinate-image-library').value;
  $('#coordinate-image-preview').hidden = !id;
  if (id) $('#coordinate-image-preview').src = `/media/${id}`;
  else $('#coordinate-image-preview').removeAttribute('src');
}
function addImage(image) {
  const select = $('#coordinate-image-library');
  let option = [...select.options].find(option => option.value === image.id);
  if (!option) { option = new Option(image.name || 'Selected image', image.id); select.add(option); }
  select.value = image.id; imagePreview();
}
async function imageLibrary(selected = $('#coordinate-image-library').value) {
  const slug = $('#coordinate-poster').value, token = ++imageGeneration;
  const result = await api(`/api/players/${slug}/images/`);
  if (token !== imageGeneration || slug !== $('#coordinate-poster').value) return;
  const select = $('#coordinate-image-library'); select.replaceChildren(new Option('No image', ''));
  for (const image of result.images) select.add(new Option(image.name, image.id));
  if (selected && result.images.some(image => image.id === selected)) select.value = selected;
  $('#coordinate-image-usage').textContent = `${(result.usage.used / 1048576).toFixed(1)} MB of 50 MB used by this profile`;
  imagePreview();
}
async function openEditor(entry) {
  if (!discard()) return;
  current = entry || null; form.reset(); clearUpload(); changed = false; status('');
  const poster = $('#coordinate-poster'); poster.replaceChildren();
  for (const player of context.postingPlayers) poster.add(new Option(player.name, player.slug));
  if (entry && !context.postingPlayers.some(player => player.slug === entry.poster.slug)) poster.add(new Option(entry.poster.name, entry.poster.slug));
  if (entry) poster.value = entry.poster.slug;
  poster.disabled = Boolean(entry);
  $('#coordinate-owner-options').replaceChildren();
  for (const player of context.players) {
    const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = player.slug; checkbox.checked = Boolean(entry?.owners.some(owner => owner.slug === player.slug)); label.append(checkbox, document.createTextNode(player.name)); $('#coordinate-owner-options').append(label);
  }
  $('#coordinate-name').value = entry?.name || ''; $('#coordinate-access').value = entry?.access || 'public';
  visibility();
  if (entry?.access === 'public') for (const field of ['dimension', 'x', 'y', 'z']) $(`#coordinate-${field}`).value = entry[field] ?? '';
  $('#coordinate-notes').value = entry?.notes || '';
  document.querySelectorAll('#coordinate-presets input').forEach(input => { input.checked = Boolean(entry?.tags.includes(input.value)); });
  $('#coordinate-custom-tags').value = (entry?.tags || []).filter(tag => !PRESET_TAGS.some(preset => preset.toLowerCase() === tag)).join(', ');
  $('#coordinate-image-alt').value = entry?.image?.alt || '';
  $('#coordinate-image-library').replaceChildren(new Option('No image', ''));
  if (entry?.image) addImage(entry.image); else imagePreview();
  $('#coordinate-editor-title').textContent = entry ? 'Edit entry' : 'Add entry';
  $('#save-coordinate').textContent = entry ? 'Save changes' : 'Publish entry';
  $('#delete-coordinate').hidden = !entry;
  $('#coordinate-editor').hidden = false; $('#coordinate-name').focus();
  try { await imageLibrary(entry?.image?.id || ''); }
  catch (error) { $('#coordinate-upload-status').textContent = error.message; }
}
$('#add-coordinate').addEventListener('click', event => run(event.target, () => openEditor()));
$('#coordinate-results').addEventListener('click', event => {
  const edit = event.target.closest('.edit-coordinate');
  if (edit) run(edit, async () => { const entry = await api(`/api/coordinates/${edit.dataset.id}/`); await openEditor(entry); });
  const copy = event.target.closest('.copy-coordinates');
  if (copy) run(copy, async () => { await navigator.clipboard.writeText(copy.dataset.coordinates); copy.textContent = 'Copied'; });
});
form.addEventListener('input', () => { changed = true; });
form.addEventListener('change', () => { changed = true; });
$('#coordinate-access').addEventListener('change', visibility);
$('#coordinate-image-library').addEventListener('change', imagePreview);
$('#coordinate-poster').addEventListener('change', () => { clearUpload(); $('#coordinate-image-library').replaceChildren(new Option('No image', '')); imagePreview(); run(null, () => imageLibrary('')); });
$('#coordinate-refresh-images').addEventListener('click', event => run(event.target, () => imageLibrary()));
$('#cancel-coordinate').addEventListener('click', () => { if (!discard()) return; changed = false; clearUpload(); $('#coordinate-editor').hidden = true; });
window.addEventListener('beforeunload', event => { if (changed || busy) event.preventDefault(); });
window.addEventListener('popstate', () => location.reload());
form.addEventListener('submit', event => {
  event.preventDefault(); run(event.submitter, async () => {
    if (busy) throw new Error('Wait for the upload to finish.');
    if (authStale) await refreshContext();
    const access = $('#coordinate-access').value;
    const tags = [...document.querySelectorAll('#coordinate-presets input:checked')].map(input => input.value).concat($('#coordinate-custom-tags').value.split(',').map(tag => tag.trim()).filter(Boolean));
    const body = {
      name: $('#coordinate-name').value, access, notes: $('#coordinate-notes').value, posterSlug: $('#coordinate-poster').value,
      tags: [...new Set(tags.map(tag => tag.toLowerCase()))], owners: [...document.querySelectorAll('#coordinate-owner-options input:checked')].map(input => input.value),
      imageId: $('#coordinate-image-library').value || null, imageAlt: $('#coordinate-image-alt').value,
      ...(access === 'public' ? { dimension: $('#coordinate-dimension').value, x: Number($('#coordinate-x').value), y: $('#coordinate-y').value === '' ? null : Number($('#coordinate-y').value), z: Number($('#coordinate-z').value) } : {}),
      ...(current ? { version: current.version } : {}),
    };
    const entry = await api(current ? `/api/coordinates/${current.id}/` : '/api/coordinates/', current ? 'PUT' : 'POST', body);
    changed = false; current = entry; clearUpload(); $('#coordinate-editor').hidden = true;
    $('#coordinate-results').innerHTML = entryHtml(entry, true);
    $('#coordinate-title').textContent = entry.name; document.title = `${entry.name} — mineandcraft.net`;
    $('#coordinate-filters').hidden = true; $('#coordinate-back').hidden = false; $('#coordinate-count').textContent = ''; $('#coordinate-pagination').replaceChildren();
    history.pushState({}, '', entry.url); document.querySelector('link[rel="canonical"]').href = location.href;
    context.editableIds = [...new Set([...context.editableIds, entry.id])]; editable();
    $('#coordinate-account-status').textContent = 'Entry saved.'; $('#coordinate-title').scrollIntoView({ block: 'start' });
  });
});
$('#delete-coordinate').addEventListener('click', event => run(event.target, async () => {
  if (busy) throw new Error('Wait for the upload to finish.');
  if (!current || !confirm('Delete this entry? Its image will remain in the posting player’s library.')) return;
  if (authStale) await refreshContext();
  await api(`/api/coordinates/${current.id}/`, 'DELETE', { version: current.version });
  changed = false; location.assign('/coordinates/');
}));

async function upload(file) {
  if (busy) return;
  if (file) pendingUpload = { file, slug: $('#coordinate-poster').value };
  if (!pendingUpload || pendingUpload.slug !== $('#coordinate-poster').value) return;
  clearTimeout(retryTimer); busy = true;
  const progress = $('#coordinate-upload-progress'), retry = $('#coordinate-retry-upload');
  retry.hidden = true; $('#coordinate-image-upload').disabled = true; $('#coordinate-poster').disabled = true; progress.hidden = false; progress.removeAttribute('value');
  try {
    if (authStale) { await refreshContext(); if (!context.user) throw Object.assign(new Error('Sign in with Discord, then retry the upload.'), { status: 401 }); }
    file = pendingUpload.file;
    if (!file.size || file.size > 5242880 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw Object.assign(new Error('Choose a PNG, JPEG, WebP, or GIF image up to 5 MB.'), { status: 415 });
    $('#coordinate-upload-status').textContent = `Uploading ${file.name}…`;
    const body = new FormData(); body.append('file', file);
    const result = await api(`/api/players/${pendingUpload.slug}/images/`, 'POST', body, { onProgress: (loaded, total) => {
      if (total) { progress.value = Math.min(100, Math.round(loaded / total * 100)); $('#coordinate-upload-status').textContent = progress.value === 100 ? `Saving ${file.name}…` : `Uploading ${file.name}: ${progress.value}%`; }
    } });
    ++imageGeneration; addImage(result.image); changed = true;
    if (!$('#coordinate-image-alt').value) $('#coordinate-image-alt').value = file.name;
    $('#coordinate-image-usage').textContent = `${(result.usage.used / 1048576).toFixed(1)} MB of 50 MB used by this profile`;
    clearUpload(); $('#coordinate-upload-status').textContent = 'Image uploaded. Publish or save the entry to use it.';
  } catch (error) {
    $('#coordinate-upload-status').textContent = error.message;
    $('#coordinate-upload-sign-in').hidden = error.status !== 401;
    retry.hidden = [400, 413, 415].includes(error.status); retry.disabled = Boolean(error.retryAfter);
    if (error.retryAfter) retryTimer = setTimeout(() => { retry.disabled = false; }, Math.min(error.retryAfter, 86400) * 1000);
  } finally { busy = false; progress.hidden = true; $('#coordinate-image-upload').disabled = false; $('#coordinate-poster').disabled = Boolean(current); }
}
$('#coordinate-image-upload').addEventListener('change', event => { if (event.target.files[0]) upload(event.target.files[0]); });
$('#coordinate-retry-upload').addEventListener('click', () => upload());
$('#coordinate-check-access').addEventListener('click', event => run(event.target, refreshContext));
run(null, async () => { await refreshContext(); });

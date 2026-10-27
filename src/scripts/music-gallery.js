import { createApi } from './api.js';
import { musicListHtml, musicPaginationHtml, musicFilterOptionsHtml } from '../../shared/music-render.mjs';
import './music-claims.js';
import './music-playback.js';

const api = createApi({});
const catalogue = document.getElementById('music-catalogue');
const search = document.getElementById('music-search');
const filters = { artist: document.getElementById('music-artist'), uploader: document.getElementById('music-uploader') };
const status = document.getElementById('music-gallery-status');
let sequence = 0, pending = false, debounce;

// Update metadata in place: disconnecting an audio element interrupts playback.
function updateRow(row, next) {
  if (!row.firstElementChild.isEqualNode(next.firstElementChild)) row.firstElementChild.replaceWith(next.firstElementChild);
  const details = row.lastElementChild;
  const children = [...next.lastElementChild.children];
  for (const [index, child] of children.entries()) {
    const existing = details.children[index];
    if (existing instanceof HTMLAudioElement && child instanceof HTMLAudioElement && existing.getAttribute('src') === child.getAttribute('src')) {
      existing.setAttribute('aria-label', child.getAttribute('aria-label'));
    } else if (!existing) details.append(child);
    else if (!existing.isEqualNode(child)) {
      if (existing instanceof HTMLAudioElement) existing.pause();
      existing.replaceWith(child);
    }
  }
  while (details.children.length > children.length) details.lastElementChild.remove();
}

function render(result) {
  const template = document.createElement('template');
  template.innerHTML = musicListHtml(result);
  const incoming = [...template.content.children];
  const ids = new Set(incoming.map(row => row.dataset.musicId));
  const rows = new Map([...catalogue.querySelectorAll('[data-music-id]')].map(row => [row.dataset.musicId, row]));
  // Remove disappeared rows first so retained songs need not move when a
  // preceding result disappears, including in browsers without moveBefore.
  for (const child of [...catalogue.children]) {
    if (!child.dataset.musicId || !ids.has(child.dataset.musicId)) {
      child.querySelectorAll('audio').forEach(audio => audio.pause());
      child.remove();
    }
  }
  for (const [index, next] of incoming.entries()) {
    const row = rows.get(next.dataset.musicId);
    const element = row || next;
    if (row) updateRow(row, next);
    if (catalogue.children[index] !== element) {
      if (row && catalogue.moveBefore) catalogue.moveBefore(element, catalogue.children[index] || null);
      else catalogue.insertBefore(element, catalogue.children[index] || null);
    }
  }
  document.getElementById('music-pagination').innerHTML = musicPaginationHtml(result);
  if (result.filters) for (const [kind, select] of Object.entries(filters)) {
    const options = document.createElement('select');
    options.innerHTML = musicFilterOptionsHtml(result, kind);
    if (select.innerHTML !== options.innerHTML) select.innerHTML = options.innerHTML;
    select.value = result.filters[kind] || '';
  }
  status.textContent = `${result.total} ${result.total === 1 ? 'song' : 'songs'}${result.query || result.filters?.artist || result.filters?.uploader ? ' found' : ' in the collection'}.`;
}

async function refresh() {
  if (document.hidden) { pending = false; return; }
  const current = ++sequence;
  pending = true;
  try {
    const result = await api('/api/music/' + location.search);
    if (current === sequence) render(result);
  } catch {
    if (current === sequence) status.textContent = 'Could not refresh the collection. The last loaded songs are shown.';
  } finally { if (current === sequence) pending = false; }
}

function applySearch() {
  clearTimeout(debounce);
  const url = new URL(location.href);
  const query = search.value.trim().slice(0, 120);
  if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
  for (const [kind, select] of Object.entries(filters)) {
    if (select.value) url.searchParams.set(kind, select.value); else url.searchParams.delete(kind);
  }
  url.searchParams.delete('page');
  history.replaceState(null, '', url);
  refresh();
}
search.addEventListener('input', () => {
  // Invalidate older requests immediately, including while the debounce runs.
  ++sequence;
  clearTimeout(debounce);
  debounce = setTimeout(applySearch, 250);
});
document.getElementById('music-search-form').addEventListener('submit', event => { event.preventDefault(); applySearch(); });
for (const select of Object.values(filters)) select.addEventListener('change', applySearch);
window.addEventListener('popstate', () => {
  clearTimeout(debounce);
  search.value = new URLSearchParams(location.search).get('q') || '';
  for (const [kind, select] of Object.entries(filters)) select.value = new URLSearchParams(location.search).get(kind) || '';
  refresh();
});
refresh();
setInterval(() => { if (!pending) refresh(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!pending) refresh(); });

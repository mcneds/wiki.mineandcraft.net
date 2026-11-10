import { musicStatusText } from './music-render.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function headClaimHtml(track) {
  if (!track.claimCode) return '';
  const command = `/trigger mac_heads set ${track.claimCode}`;
  return `<p>Hold a player head in your main hand, then use <code>${command}</code>. This overwrites the held head's skin and sound. A held stack keeps its count.</p><button type="button" data-head-claim="${escape(command)}">Copy head claim command</button>`;
}
export function headsListHtml(result) {
  if (!result.tracks.length) return '<p>No matching approved head sounds yet. <a href="/heads/create/">Submit a sound effect</a>.</p>';
  return result.tracks.map(track => `<article class="music-track"><img class="head-preview" src="${escape(track.head.image)}" alt="${escape(track.head.name)}’s head" width="96" height="96" loading="lazy"><div><h2>${escape(track.title)}</h2><p>${escape(track.head.name)} (${escape(track.head.edition)}) · Submitted by <a href="/wiki/players/${escape(track.poster.slug)}/">${escape(track.poster.name)}</a></p><p class="music-state">${escape(musicStatusText(track))}</p>${track.playbackUrl ? `<audio controls preload="none" src="${escape(track.playbackUrl)}" aria-label="Play ${escape(track.title)}"></audio>` : ''}${headClaimHtml(track)}</div></article>`).join('');
}
export function headsPaginationHtml(result) {
  if (result.pages <= 1) return '';
  const link = (page, label) => {
    const params = new URLSearchParams({ page: String(page) });
    if (result.query) params.set('q', result.query);
    if (result.filters.uploader) params.set('uploader', result.filters.uploader);
    return `<a href="/heads/?${escape(params)}">${label}</a>`;
  };
  return `${result.page > 1 ? link(result.page - 1, 'Previous') : ''} <span>Page ${result.page} of ${result.pages}</span> ${result.page < result.pages ? link(result.page + 1, 'Next') : ''}`;
}
export function headsUploaderHtml(result) {
  return '<option value="">All uploaders</option>' + result.uploaders.map(p => `<option value="${escape(p.slug)}"${p.slug === result.filters.uploader ? ' selected' : ''}>${escape(p.name)}</option>`).join('');
}

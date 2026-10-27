import { musicCoverUrl } from './music-cover.mjs';
import { MUSIC_STATES } from './music.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const audioLink = track => track.audioSourceUrl ? `<p>Audio recording: <a href="${escape(track.audioSourceUrl)}" target="_blank" rel="noopener noreferrer">Confirmed YouTube match</a></p>` : '';
export function musicStatusText(track) {
  if (track.status !== 'approved') return MUSIC_STATES[track.status];
  if (track.delivery?.phase === 'failed') return ({ youtube_access_blocked: 'Audio download blocked by YouTube', provider_unavailable: 'Audio source unavailable', invalid_audio: 'Audio could not be converted', installation_failed: 'Server installation failed' })[track.delivery.reason] || 'Music delivery failed';
  return ({ queued: 'Queued for processing', fetching_audio: 'Fetching audio', converting: 'Converting audio', waiting_for_empty_server: 'Audio ready · waiting for an empty server', installing: 'Installing on server' })[track.delivery?.phase] || 'Queued for processing';
}
export const claimHtml = track => track.claimCode ? `<p>Hold any music disc, then use <code>/trigger mac_music set ${escape(track.claimCode)}</code>. This changes the song while keeping the base disc and its appearance.</p><button type="button" data-music-claim="${escape(track.claimCode)}">Copy claim command</button>` : '';
export function musicDiscHtml(track) {
  let cover;
  try { cover = musicCoverUrl(track.coverUrl); } catch { /* Keep the plain disc for invalid legacy artwork. */ }
  return `<div class="music-disc" aria-hidden="true">${cover ? `<img src="${escape(cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}</div>`;
}
export function musicListHtml(result) {
  if (!result.tracks.length) return result.query || result.filters?.artist || result.filters?.uploader ? '<p>No songs match your search or filters. Try another song, artist or player.</p>' : '<p>No approved discs yet. <a href="/music/create/">Submit the first track</a>.</p>';
  return result.tracks.map(track => `<article class="music-track" data-music-id="${escape(track.id)}">${musicDiscHtml(track)}<div><h2>${escape(track.title)}</h2><p>${escape(track.artist || 'Artist not specified')} · Submitted by <a href="/wiki/players/${escape(track.poster.slug)}/">${escape(track.poster.name)}</a></p><p class="music-state">${escape(musicStatusText(track))}</p>${track.playbackUrl ? `<audio controls preload="none" src="/api/music/${escape(track.id)}/play/" aria-label="Play ${escape(track.title)}"></audio>` : '<p class="music-state">Playback will be available once the audio is ready.</p>'}${track.sourceUrl ? `<a href="${escape(track.sourceUrl)}" target="_blank" rel="noopener noreferrer">${track.sourceKind === 'spotify' ? 'Spotify track' : 'YouTube video'}</a>` : ''}${audioLink(track)}${claimHtml(track)}</div></article>`).join('');
}

export function musicPaginationHtml(result) {
  if (result.pages <= 1) return '';
  const link = (page, label) => {
    const params = new URLSearchParams();
    if (result.query) params.set('q', result.query);
    for (const key of ['artist', 'uploader']) if (result.filters?.[key]) params.set(key, result.filters[key]);
    params.set('page', String(page));
    return `<a href="/music/?${escape(params.toString())}">${label}</a>`;
  };
  return `${result.page > 1 ? link(result.page - 1, 'Previous') : ''}<span>Page ${result.page} of ${result.pages}</span>${result.page < result.pages ? link(result.page + 1, 'Next') : ''}`;
}

export function musicFilterOptionsHtml(result, kind) {
  const selected = result.filters?.[kind] || '';
  const options = kind === 'artist' ? (result.artists || []).map(artist => ({ value: artist, label: artist })) : (result.uploaders || []).map(player => ({ value: player.slug, label: player.name }));
  if (selected && !options.some(option => option.value === selected)) options.push({ value: selected, label: selected });
  return `<option value="">${kind === 'artist' ? 'All artists' : 'All uploaders'}</option>` + options.map(option => `<option value="${escape(option.value)}"${option.value === selected ? ' selected' : ''}>${escape(option.label)}</option>`).join('');
}

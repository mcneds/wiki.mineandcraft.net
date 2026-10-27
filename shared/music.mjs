import { musicCoverUrl } from './music-cover.mjs';
export const MUSIC_FILE_LIMIT = 20 * 1024 * 1024;
export const MUSIC_USER_LIMIT = 100 * 1024 * 1024;
export const MUSIC_TRACK_LIMIT = 25;
export const MUSIC_STATES = { pending: 'Awaiting review', approved: 'Approved for next pack', released: 'Added to server', rejected: 'Changes requested' };

export function musicClaimCode(id) {
  let crc = 0xffffffff;
  for (const character of id) {
    crc ^= character.charCodeAt(0);
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (((crc ^ 0xffffffff) >>> 0) & 0x7fffffff) || 1;
}

// Links identify one recording. Strip tracking, playlist parameters and times.
// Neither the browser nor Worker fetches arbitrary user-provided URLs.
export function musicSource(value) {
  if (!value) return { kind: 'file', url: null };
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Use a Spotify track or YouTube video link.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Use a full Spotify track or YouTube video link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an HTTPS Spotify or YouTube link.');
  const host = url.hostname.toLowerCase();
  if (host === 'open.spotify.com') {
    const match = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})\/?$/);
    if (match) return { kind: 'spotify', url: `https://open.spotify.com/track/${match[1]}` };
    throw new Error('Choose one Spotify track, rather than a playlist or album.');
  }
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host)) {
    const id = host.endsWith('youtu.be') ? url.pathname.slice(1).replace(/\/$/, '') : url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([^/]+)\/?$/)?.[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
    throw new Error('Choose one YouTube video, rather than a playlist or channel.');
  }
  throw new Error('Links must be Spotify tracks or YouTube videos.');
}

export function musicAudioSource(kind, value, confirmed) {
  if (value == null || value === '') return null;
  if (kind !== 'spotify' || confirmed !== true) throw new Error('Listen to the recording and confirm your Spotify match first.');
  const source = musicSource(value);
  if (source.kind !== 'youtube') throw new Error('Choose an individual YouTube recording for this Spotify track.');
  return source.url;
}

export function musicFields(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const artist = typeof body.artist === 'string' ? body.artist.trim() : '';
  if (!title || title.length > 100 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Enter a track title of 1–100 characters.');
  if (artist.length > 100 || /[\x00-\x1f\x7f]/.test(artist)) throw new Error('Artist names must be no longer than 100 characters.');
  const source = musicSource(body.sourceUrl);
  return { title, artist, source, coverUrl: musicCoverUrl(body.coverUrl), audioSourceUrl: musicAudioSource(source.kind, body.audioSourceUrl, body.audioSourceConfirmed) };
}

export function audioType(bytes) {
  const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  if (bytes.length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { mime: 'audio/wav', extension: 'wav' };
  if (bytes.length >= 28 && ascii(0, 4) === 'OggS' && bytes[4] === 0) return { mime: 'audio/ogg', extension: 'ogg' };
  if (bytes.length >= 42 && ascii(0, 4) === 'fLaC') return { mime: 'audio/flac', extension: 'flac' };
  if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') return { mime: 'audio/mp4', extension: 'm4a' };
  if (bytes.length >= 16 && (ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0 && (bytes[2] & 0xf0) !== 0xf0))) return { mime: 'audio/mpeg', extension: 'mp3' };
  throw new Error('Choose an MP3, WAV, Ogg, FLAC, or M4A audio file.');
}

import { HttpError } from './auth.mjs';
import { spotifyMetadata } from './music-metadata.mjs';

const text = value => (value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '').replace(/[\x00-\x1f\x7f]/g, '').trim();

export function youtubeCandidates(data, track) {
  const candidates = [], seen = new Set(), queue = [data];
  let visited = 0;
  while (queue.length && visited++ < 50000) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    const video = value.videoRenderer;
    if (!video) { queue.push(...Object.values(value).filter(item => item && typeof item === 'object')); continue; }
    const id = video.videoId, title = text(video.title).slice(0, 200), channel = text(video.ownerText || video.longBylineText).slice(0, 150);
    const length = text(video.lengthText);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id || '') || !title || !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(length) || seen.has(id)) continue;
    const durationSeconds = length.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    if (!(Number.isFinite(durationSeconds) && durationSeconds > 0)) continue;
    seen.add(id);
    const expected = new Set(`${track.title} ${track.artist}`.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const actual = new Set(`${title} ${channel}`.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const overlap = [...expected].filter(word => actual.has(word)).length / Math.max(1, expected.size);
    const delta = track.durationSeconds ? Math.abs(durationSeconds - track.durationSeconds) : 0;
    const normalize = value => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const channelName = normalize(channel.replace(/ - Topic$/, ''));
    const artistChannel = track.artist.split(',').some(name => channelName === normalize(name) || channelName === normalize(name) + 'vevo');
    const versions = ['lyrics', 'live', 'cover', 'karaoke', 'instrumental', 'remix', 'slowed', 'sped', 'pianoforte', 'extended', 'remaster'];
    const versionPenalty = versions.filter(word => title.toLocaleLowerCase().includes(word) && !track.title.toLocaleLowerCase().includes(word)).length * 12;
    const official = /\bofficial (?:audio|video)\b/i.test(title) ? 8 : 0;
    candidates.push({ url: `https://www.youtube.com/watch?v=${id}`, title, channel, durationSeconds, score: overlap * 100 + (artistChannel ? 20 : 0) + official - versionPenalty - Math.min(100, delta) });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 5).map(({ score, ...candidate }) => candidate);
}

export async function spotifyMatches(body, fetcher) {
  const track = await spotifyMetadata(body, fetcher);
  try {
    const query = `${track.artist} ${track.title} official audio`;
    const response = await fetcher(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`, {
      redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!response.ok || !response.body) throw new Error('Search unavailable');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let html = '', size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 3 * 1024 * 1024) throw new Error('Oversized search response');
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    const initial = html.match(/(?:var ytInitialData\s*=\s*|window\["ytInitialData"\]\s*=\s*)({.*?});<\/script>/s)?.[1];
    if (!initial) throw new Error('Missing search results');
    return { sourceUrl: track.sourceUrl, candidates: youtubeCandidates(JSON.parse(initial), track) };
  } catch {
    throw new HttpError(502, 'Could not search for recordings. Paste a specific YouTube video below or upload an audio file.');
  }
}

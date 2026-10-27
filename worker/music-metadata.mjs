import { musicCoverUrl } from '../shared/music-cover.mjs';
import { HttpError } from './auth.mjs';
import { musicSource } from '../shared/music.mjs';

async function providerText(response, maximum) {
  if (!response.ok || !response.body) throw new Error('Provider unavailable');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, content = '';
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Oversized metadata');
      content += decoder.decode(value, { stream: true });
    }
    return content + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

// Only retrieve a canonical Spotify embed page. Never forward member cookies,
// follow redirects, or return the embed's HTML, tokens, or preview audio. Artwork is limited to Spotify's image CDN.
export async function spotifyMetadata(body, fetcher) {
  let source;
  try { source = musicSource(body.sourceUrl); } catch (error) { throw new HttpError(400, error.message); }
  if (source.kind !== 'spotify') throw new HttpError(400, 'Use an individual Spotify track link.');
  const id = source.url.split('/').at(-1);
  try {
    const response = await fetcher(`https://open.spotify.com/embed/track/${id}`, {
      redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'text/html' },
    });
    const html = await providerText(response, 262144);
    const script = html.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i);
    const entity = script && JSON.parse(script[1]).props?.pageProps?.state?.data?.entity;
    if (!entity || entity.type !== 'track' || entity.id !== id || !Array.isArray(entity.artists)) throw new Error('Missing track details');
    const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
    const title = clean(entity.title || entity.name).slice(0, 100);
    const artist = entity.artists.map(value => clean(value.name)).filter(Boolean).join(', ').slice(0, 100);
    if (!title || !artist) throw new Error('Missing title or artist');
    let coverUrl;
    for (const image of Array.isArray(entity.visualIdentity?.image) ? entity.visualIdentity.image : []) {
      try {
        const url = musicCoverUrl(image.url);
        if (url && (new URL(url).hostname === 'i.scdn.co' || new URL(url).hostname.endsWith('.spotifycdn.com'))) { coverUrl = url; break; }
      } catch { /* Missing artwork must not prevent title/artist lookup. */ }
    }
    return { sourceUrl: source.url, title, artist, ...(coverUrl ? { coverUrl } : {}), ...(Number.isFinite(entity.duration) && entity.duration > 0 ? { durationSeconds: entity.duration / 1000 } : {}) };
  } catch {
    throw new HttpError(502, 'Could not load Spotify details. Enter the title and artist manually.');
  }
}

export async function musicMetadata(body, fetcher) {
  let source;
  try { source = musicSource(body.sourceUrl); } catch (error) { throw new HttpError(400, error.message); }
  if (source.kind === 'spotify') return spotifyMetadata(body, fetcher);
  if (source.kind !== 'youtube') throw new HttpError(400, 'Use a Spotify track or YouTube video link.');
  try {
    const response = await fetcher(`https://www.youtube.com/oembed?url=${encodeURIComponent(source.url)}&format=json`, {
      redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' },
    });
    const value = JSON.parse(await providerText(response, 16384));
    const clean = text => typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) : '';
    const title = clean(value.title), artist = clean(value.author_name).replace(/ - Topic$/, '');
    if (value.provider_name !== 'YouTube' || !title || !artist) throw new Error('Missing video details');
    const videoId = new URL(source.url).searchParams.get('v');
    let coverUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    try {
      const thumbnail = musicCoverUrl(value.thumbnail_url);
      const url = thumbnail && new URL(thumbnail);
      if (url?.hostname === 'i.ytimg.com' && url.pathname.startsWith(`/vi/${videoId}/`)) coverUrl = thumbnail;
    } catch { /* The canonical video thumbnail also works without oEmbed artwork. */ }
    return { sourceUrl: source.url, title, artist, artistIsChannel: true, coverUrl };
  } catch { throw new HttpError(502, 'Could not load YouTube details. Enter the title and artist manually.'); }
}

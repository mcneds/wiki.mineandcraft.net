// Only these providers can produce an iframe. Never use a submitted embed URL
// as the iframe source, even if it resembles one of these hosts.
export function video(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let id;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'].includes(host)) {
    id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)\/?$/)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) return null;
    return { url: `https://www.youtube.com/watch?v=${id}`, embed: `https://www.youtube-nocookie.com/embed/${id}`, provider: 'YouTube' };
  }
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
    const match = url.pathname.match(/^\/(?:video\/)?([0-9]{1,12})(?:\/([a-f0-9]{6,64}))?\/?$/);
    if (!match) return null;
    const hash = match[2] || url.searchParams.get('h');
    if (hash && !/^[a-f0-9]{6,64}$/.test(hash)) return null;
    return { url: `https://vimeo.com/${match[1]}${hash ? `/${hash}` : ''}`, embed: `https://player.vimeo.com/video/${match[1]}${hash ? `?h=${hash}` : ''}`, provider: 'Vimeo' };
  }
  return null;
}

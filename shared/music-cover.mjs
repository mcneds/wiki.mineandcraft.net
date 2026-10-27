export function musicCoverUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Use an HTTPS album cover image URL.');
  if (!value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Use a full HTTPS album cover image URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use an HTTPS album cover image URL without login details.');
  return url.href;
}

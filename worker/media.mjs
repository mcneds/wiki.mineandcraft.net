import { HttpError } from './auth.mjs';

export const FILE_LIMIT = 5 * 1024 * 1024;
export const PAGE_LIMIT = 50 * 1024 * 1024;
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const key = row => `${row.slug}/${row.id}`;
const summary = row => ({ id: row.id, name: row.filename, type: row.mime, size: row.bytes, url: `/media/${row.id}` });
async function usage(env, slug) {
  return { used: (await env.DB.prepare('SELECT bytes FROM media_usage WHERE slug=?').bind(slug).first())?.bytes || 0, limit: PAGE_LIMIT, fileLimit: FILE_LIMIT };
}

// Inspect bytes, not the browser's MIME type or the file extension. Images are
// served as raster images with nosniff; SVG and arbitrary HTML are never stored.
export function imageType(bytes) {
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && ascii(1, 4) === 'PNG' && bytes[0] === 137 && ascii(12, 16) === 'IHDR' && view.getUint32(16) && view.getUint32(20)) return 'image/png';
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) && view.getUint16(6, true) && view.getUint16(8, true) && bytes.at(-1) === 59) return 'image/gif';
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16)) && view.getUint32(4, true) + 8 === bytes.length) return 'image/webp';
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  throw new HttpError(415, 'Choose a PNG, JPEG, WebP, or GIF image.');
}
async function readFile(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'Choose an image to upload.');
  const bound = FILE_LIMIT + 65536;
  if (Number(request.headers.get('Content-Length') || 0) > bound) throw new HttpError(413, 'Images must be 5 MB or smaller.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Choose an image to upload.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > bound) { await reader.cancel(); throw new HttpError(413, 'Images must be 5 MB or smaller.'); }
    chunks.push(value);
  }
  let form;
  try { form = await new Response(new Blob(chunks), { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new HttpError(400, 'The upload could not be read.'); }
  const files = form.getAll('file');
  const file = files[0];
  if (files.length !== 1 || !file || typeof file === 'string') throw new HttpError(400, 'Choose one image to upload.');
  if (!file.size || file.size > FILE_LIMIT) throw new HttpError(413, 'Images must be between 1 byte and 5 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, mime: imageType(bytes), filename: file.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) || 'Image' };
}

export async function images(request, env, user, player, id) {
  if (!env.MEDIA) throw new HttpError(503, 'Image uploads are temporarily unavailable.');
  if (!id && request.method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM media WHERE slug=? AND state='ready' ORDER BY created DESC,id").bind(player.slug).all();
    return reply({ images: rows.results.map(summary), usage: await usage(env, player.slug) });
  }
  if (!id && request.method === 'POST') {
    const file = await readFile(request);
    const row = { id: crypto.randomUUID(), slug: player.slug, ...file };
    try {
      await env.DB.prepare("INSERT INTO media(id,slug,filename,mime,bytes,state,created,author_id) VALUES(?,?,?,?,?,'pending',?,?)")
        .bind(row.id, row.slug, row.filename, row.mime, file.bytes.length, Date.now(), user.user_id).run();
    } catch (error) {
      if (String(error).includes('CHECK')) throw new HttpError(413, 'This player has reached the 50 MB image limit. Delete an unused image first.');
      throw error;
    }
    try {
      await env.MEDIA.put(key(row), file.bytes, { httpMetadata: { contentType: file.mime } });
      const ready = await env.DB.prepare("UPDATE media SET state='ready' WHERE id=? AND state='pending' RETURNING *").bind(row.id).first();
      if (!ready) throw new Error('Upload reservation expired');
      return reply({ image: summary(ready), usage: await usage(env, player.slug) }, 201);
    } catch {
      // Keep the reservation if object deletion fails. The scheduled sweep can
      // retry it without freeing quota for bytes that still occupy storage.
      try { await env.MEDIA.delete(key(row)); await env.DB.prepare("UPDATE media SET state='deleted' WHERE id=?").bind(row.id).run(); } catch { /* Scheduled cleanup retries. */ }
      throw new HttpError(503, 'The image could not be stored. Please try again.');
    }
  }
  if (id && request.method === 'DELETE') {
    let row;
    try { row = await env.DB.prepare("UPDATE media SET state='deleting' WHERE id=? AND slug=? AND state IN ('ready','deleting') RETURNING *").bind(id, player.slug).first(); }
    catch (error) { if (String(error).includes('media_in_use')) throw new HttpError(409, 'This image is used on a current page. Remove it from the page before deleting it.'); throw error; }
    if (!row) throw new HttpError(404, 'Image not found.');
    try { await env.MEDIA.delete(key(row)); }
    catch { throw new HttpError(503, 'Deletion is pending. Please try again shortly.'); }
    await env.DB.prepare("UPDATE media SET state='deleted' WHERE id=?").bind(id).run();
    return reply({ usage: await usage(env, player.slug) });
  }
  throw new HttpError(405, 'This action is not supported.');
}

export async function publicImage(request, env, id) {
  const row = await env.DB.prepare("SELECT * FROM media WHERE id=? AND state='ready'").bind(id).first();
  if (!row || !env.MEDIA) throw new HttpError(404, 'Image not found.');
  const object = await env.MEDIA.get(key(row));
  if (!object) throw new HttpError(404, 'Image not found.');
  const headers = { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff', ETag: object.httpEtag };
  if (request.headers.get('If-None-Match') === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

export async function cleanupMedia(env) {
  if (!env.MEDIA) return;
  const rows = await env.DB.prepare("SELECT * FROM media WHERE state='deleting' OR (state='pending' AND created<?) LIMIT 100").bind(Date.now() - 3600000).all();
  for (const row of rows.results) {
    try {
      const claimed = await env.DB.prepare("UPDATE media SET state='deleting' WHERE id=? AND state IN ('pending','deleting') RETURNING id").bind(row.id).first();
      if (!claimed) continue;
      await env.MEDIA.delete(key(row));
      await env.DB.prepare("UPDATE media SET state='deleted' WHERE id=? AND state='deleting'").bind(row.id).run();
    } catch { console.error('Media cleanup will retry:', row.id); }
  }
}

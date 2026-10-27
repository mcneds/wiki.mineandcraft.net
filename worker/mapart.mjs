import { HttpError, authorize, configured, session, limit, hash, memberRoles } from './auth.mjs';
import { imageType } from './media.mjs';
import { MAPART_FILE_LIMIT, MAPART_DATA_LIMIT, MAPART_PREVIEW_LIMIT, MAPART_TILE_LIMIT, MAPART_SIDE_LIMIT, mapartFields } from '../shared/mapart.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const select = 'SELECT j.*,p.name AS poster_name,p.minecraft_id AS current_identity FROM mapart_jobs j JOIN players p ON p.slug=j.poster_slug';
const get = (env, id) => env.DB.prepare(`${select} WHERE j.id=?`).bind(id).first();
const sourceKey = row => `mapart/${row.id}/${row.source_token || 'unstarted'}/source`;
const artifactKey = (id, token, kind) => `mapart/${id}/${token}/${kind}`;
const roleMatches = (roles, name) => roles.some(role => role.toLowerCase() === name.toLowerCase());
const mayManage = (user, row) => user.owner || (row.author_id === user.user_id && roleMatches(user.roles, row.poster_name));
const view = row => ({ id: row.id, title: row.title, posterSlug: row.poster_slug, posterName: row.poster_name, settings: JSON.parse(row.settings), status: row.status, error: row.error, created: row.created, ...(row.status === 'ready' ? { previewUrl: `/api/mapart/${row.id}/preview/`, command: `/mapart claim ${row.claim_code}` } : {}), canRetry: row.status === 'failed' && (row.media_id !== null || row.source_state === 'ready') && row.expires > Date.now() });
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

export async function mapartForm(request, maximum) {
  if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data;')) throw new HttpError(415, 'Choose an image to upload.');
  if (Number(request.headers.get('Content-Length') || 0) > maximum) throw new HttpError(413, 'The upload is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Choose an image.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > maximum) { await reader.cancel(); throw new HttpError(413, 'The upload is too large.'); }
    chunks.push(value);
  }
  try { return await new Response(new Blob(chunks), { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData(); }
  catch { throw new HttpError(400, 'The upload could not be read.'); }
}
async function fileBytes(form, name, maximum) {
  const files = form.getAll(name), file = files[0];
  if (files.length !== 1 || !file || typeof file === 'string' || !file.size || file.size > maximum) throw new HttpError(413, `Choose one ${name} file within the size limit.`);
  return new Uint8Array(await file.arrayBuffer());
}
function databaseError(error) {
  if (String(error).includes('mapart_storage_quota')) throw new HttpError(413, 'Your mapart storage is full. Delete some artwork to free space, then retry.');
  if (String(error).includes('mapart_quota')) throw new HttpError(413, 'Your unfinished-job limit is reached. Wait for conversion or cancel a job.');
  if (String(error).includes('mapart_media_unavailable')) throw new HttpError(409, 'That library image is unavailable. Choose another image.');
  throw error;
}
async function measureLegacyStorage(env, authorId) {
  const attempts = (await env.DB.prepare(`SELECT a.* FROM mapart_attempts a JOIN mapart_jobs j ON j.id=a.job_id WHERE a.size_checked=0 AND NOT((j.status='uploading' AND j.source_state='receiving' AND j.source_token IS a.token AND j.updated>?) OR (j.status='converting' AND j.lease IS a.token AND j.lease_until>?))${authorId ? ' AND j.author_id=?' : ' LIMIT 100'}`).bind(Date.now()-300000, Date.now(), ...(authorId ? [authorId] : [])).all()).results;
  for (const attempt of attempts) {
    const files = await Promise.all(['source','pixels','preview'].map(kind => env.MEDIA.head(artifactKey(attempt.job_id, attempt.token, kind))));
    await env.DB.prepare('UPDATE mapart_attempts SET bytes=?,size_checked=1 WHERE token=? AND size_checked=0').bind(files.reduce((sum, file) => sum + (file?.size || 0), 0), attempt.token).run();
  }
}
export async function mapartContext(request, env, fetcher) {
  if (!configured(env) || !await session(request, env)) return json({ user: null, postingPlayers: [], artworks: [], enabled: env.MAPART_ENABLED === 'true' });
  const user = await authorize(request, env, fetcher);
  const players = (await env.DB.prepare('SELECT slug,name,minecraft_id FROM players ORDER BY name COLLATE NOCASE').all()).results;
  const postingPlayers = players.filter(player => player.minecraft_id && roleMatches(user.roles, player.name)).map(({ slug, name }) => ({ slug, name }));
  const params = new URL(request.url).searchParams, all = params.get('scope') === 'all';
  if (all && !user.owner) throw new HttpError(403, 'Only the owner can manage all mapart.');
  const rows = (await env.DB.prepare(`${select} WHERE j.status!='deleted'${all ? '' : ' AND j.author_id=?'} ORDER BY j.created DESC`).bind(...(all ? [] : [user.user_id])).all()).results;
  await measureLegacyStorage(env, user.user_id);
  const limits = await env.DB.prepare('SELECT storage_limit_bytes,pending_limit FROM mapart_limits WHERE id=1').first();
  const used = (await env.DB.prepare('SELECT bytes FROM mapart_storage WHERE author_id=?').bind(user.user_id).first())?.bytes || 0;
  return json({ user: { csrf: user.csrf, owner: user.owner }, postingPlayers, artworks: rows.filter(row => mayManage(user, row)).map(view), enabled: env.MAPART_ENABLED === 'true', usage: { used, limit: limits.storage_limit_bytes }, limits: { pending: limits.pending_limit, fileBytes: MAPART_FILE_LIMIT } });
}

export async function mapartApi(request, env, user, body = {}) {
  if (!env.MEDIA) throw new HttpError(503, 'Mapart storage is unavailable.');
  const path = new URL(request.url).pathname;
  if (path === '/api/mapart/' && request.method === 'POST') {
    if (env.MAPART_ENABLED !== 'true' || !env.MAPART_BRIDGE_KEY || env.MAPART_BRIDGE_KEY.length < 32) throw new HttpError(503, 'Mapart submissions are not enabled yet.');
    let fields; try { fields = mapartFields(body); } catch (error) { throw new HttpError(400, error.message); }
    if (!uuid.test(body.id || '')) throw new HttpError(400, 'Refresh the form before submitting.');
    const existing = await get(env, body.id);
    if (existing) {
      if (!mayManage(user, existing) || existing.author_id !== user.user_id || existing.status === 'deleted' || existing.settings !== JSON.stringify(fields) || existing.poster_slug !== body.posterSlug || existing.media_id !== (body.mediaId || null)) throw new HttpError(409, 'This submission ID is already in use.');
      return json(view(existing));
    }
    const player = await env.DB.prepare('SELECT * FROM players WHERE slug=?').bind(String(body.posterSlug || '')).first();
    if (!player?.minecraft_id || !roleMatches(user.roles, player.name)) throw new HttpError(403, 'Choose your verified player profile with its matching Discord IGN role.');
    if (body.mediaId !== undefined && !uuid.test(body.mediaId)) throw new HttpError(400, 'Choose an image from your library.');
    await limit(env, `mapart-submit:${user.user_id}`, 5, 60);
    const now = Date.now(), library = Boolean(body.mediaId);
    await measureLegacyStorage(env, user.user_id);
    try {
      await env.DB.prepare('INSERT INTO mapart_jobs(id,claim_code,author_id,poster_slug,minecraft_id,title,settings,media_id,source_state,status,created,updated,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(body.id, crypto.randomUUID().replaceAll('-', '').slice(0, 12), user.user_id, player.slug, player.minecraft_id, fields.title, JSON.stringify(fields), body.mediaId || null, library ? 'none' : 'pending', library ? 'queued' : 'uploading', now, now, now + 86400000).run();
    } catch (error) { databaseError(error); }
    return json(view(await get(env, body.id)), 201);
  }
  const match = path.match(/^\/api\/mapart\/([a-f0-9-]{36})\/(source\/|preview\/|retry\/)?$/);
  if (!match) throw new HttpError(404, 'Artwork not found.');
  const row = await get(env, match[1]);
  if (!row || row.status === 'deleted') throw new HttpError(404, 'Artwork not found.');
  if (!mayManage(user, row)) throw new HttpError(403, 'This artwork belongs to another member.');
  const action = match[2] || '';
  if (!action && request.method === 'GET') return json(view(row));
  if (action === 'preview/' && request.method === 'GET' && row.status === 'ready') return stored(env, artifactKey(row.id, row.artifact_token, 'preview'), 'image/png');
  if (action === 'source/' && request.method === 'POST' && row.media_id === null && row.expires > Date.now()) {
    const form = await mapartForm(request, MAPART_FILE_LIMIT + 65536), bytes = await fileBytes(form, 'file', MAPART_FILE_LIMIT);
    const mime = imageType(bytes), sha256 = await digest(bytes);
    if (row.source_state === 'ready' && row.source_sha256 === sha256 && row.status !== 'uploading') return json(view(row));
    // Claim the upload before touching storage: concurrent uploads must not overwrite it.
    await measureLegacyStorage(env, row.author_id);
    const uploadToken = crypto.randomUUID();
    const claimed = await env.DB.prepare("UPDATE mapart_jobs SET source_state='receiving',source_token=?,updated=? WHERE id=? AND status='uploading' AND (source_state='pending' OR (source_state='receiving' AND updated<?)) RETURNING id").bind(uploadToken, Date.now(), row.id, Date.now() - 300000).first();
    if (!claimed) throw new HttpError(409, 'The artwork changed. Refresh before retrying.');
    const uploadRow = { ...row, source_token: uploadToken };
    try {
      await env.DB.prepare('INSERT INTO mapart_attempts(token,job_id,created,bytes,size_checked) VALUES(?,?,?,?,1)').bind(uploadToken, row.id, Date.now(), bytes.length).run();
      await env.MEDIA.put(sourceKey(uploadRow), bytes, { httpMetadata: { contentType: mime } });
      const changed = await env.DB.prepare("UPDATE mapart_jobs SET source_state='ready',source_sha256=?,status='queued',updated=? WHERE id=? AND status='uploading' AND source_token=? RETURNING id").bind(sha256, Date.now(), row.id, uploadToken).first();
      if (!changed) { await env.MEDIA.delete(sourceKey(uploadRow)); throw new Error('Cancelled'); }
    } catch (error) {
      await env.DB.prepare("UPDATE mapart_jobs SET source_state='pending' WHERE id=? AND status='uploading' AND source_state='receiving' AND source_token=?").bind(row.id, uploadToken).run();
      if (String(error).includes('mapart_storage_quota')) databaseError(error);
      throw new HttpError(503, 'The submission is saved. Retry its image upload.');
    }
    return json(view(await get(env, row.id)));
  }
  if (action === 'retry/' && request.method === 'POST' && view(row).canRetry) {
    try { await env.DB.prepare("UPDATE mapart_jobs SET status='queued',error='',lease=NULL,lease_until=NULL,updated=? WHERE id=? AND status='failed'").bind(Date.now(), row.id).run(); }
    catch (error) { databaseError(error); }
    return json(view(await get(env, row.id)));
  }
  if (!action && request.method === 'DELETE') {
    await env.DB.prepare("UPDATE mapart_jobs SET status='deleted',source_state=CASE WHEN source_state IN ('pending','receiving','ready') THEN 'deleting' ELSE source_state END,lease=NULL,lease_until=NULL,updated=? WHERE id=?").bind(Date.now(), row.id).run();
    await cleanupMapart(env);
    return json({ deleted: true });
  }
  throw new HttpError(409, 'This action is unavailable for the artwork’s current state. Refresh and try again.');
}
async function stored(env, key, type) {
  const object = await env.MEDIA?.get(key);
  if (!object) throw new HttpError(404, 'Artwork file not found.');
  return new Response(object.body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function leaseCheck(request, row) {
  if (row.status !== 'converting' || row.lease_until <= Date.now() || request.headers.get('X-Mapart-Lease') !== row.lease) throw new HttpError(409, 'The conversion lease expired.');
}
export async function mapartBridge(request, env, body, fetcher) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.{32,256})$/)?.[1];
  if (!token || typeof env.MAPART_BRIDGE_KEY !== 'string' || env.MAPART_BRIDGE_KEY.length < 32 || await hash(token) !== await hash(env.MAPART_BRIDGE_KEY)) throw new HttpError(401, 'Mapart server authentication failed.');
  const path = new URL(request.url).pathname;
  if (path === '/api/mapart/bridge/active/' && request.method === 'GET') return json({ ids: (await env.DB.prepare("SELECT id FROM mapart_jobs WHERE status!='deleted'").all()).results.map(row => row.id) });
  if (path === '/api/mapart/bridge/lease/' && request.method === 'POST') {
    // Older companions keep handling smaller jobs while larger jobs wait for an upgrade.
    const tiles = Number(request.headers.get('X-Mapart-Max-Tiles') || 64), side = Number(request.headers.get('X-Mapart-Max-Side') || 8);
    if (!Number.isInteger(tiles) || tiles < 1 || !Number.isInteger(side) || side < 1) throw new HttpError(400, 'Invalid converter limits.');
    const now = Date.now(), lease = crypto.randomUUID();
    const row = await env.DB.prepare("UPDATE mapart_jobs SET status='converting',lease=?,lease_until=?,updated=? WHERE id=(SELECT id FROM mapart_jobs WHERE expires>? AND (status='queued' OR (status='converting' AND lease_until<?)) AND json_extract(settings,'$.columns')<=? AND json_extract(settings,'$.rows')<=? AND json_extract(settings,'$.columns')*json_extract(settings,'$.rows')<=? ORDER BY created LIMIT 1) RETURNING *")
      .bind(lease, now + 300000, now, now, now, Math.min(side, MAPART_SIDE_LIMIT), Math.min(side, MAPART_SIDE_LIMIT), Math.min(tiles, MAPART_TILE_LIMIT)).first();
    if (!row) return json({ job: null });
    await env.DB.prepare('INSERT INTO mapart_attempts(token,job_id,created,bytes,size_checked) VALUES(?,?,?,0,1)').bind(lease, row.id, now).run();
    return json({ job: { id: row.id, title: row.title, settings: JSON.parse(row.settings), lease, source: `/api/mapart/bridge/${row.id}/source/` } });
  }
  if (path === '/api/mapart/bridge/claim/' && request.method === 'POST') {
    if (!configured(env)) throw new HttpError(503, 'Discord authorization is unavailable.');
    if (!/^[a-f0-9]{12}$/.test(body.code || '')) throw new HttpError(400, 'Use the claim command shown on the website.');
    const row = await env.DB.prepare(`${select} WHERE j.claim_code=? AND j.status='ready'`).bind(body.code).first();
    if (!row || row.minecraft_id !== body.identity || row.current_identity !== body.identity) throw new HttpError(403, 'This artwork is unavailable for your Minecraft account.');
    await limit(env, `mapart-claim:${row.id}`, 10, 60);
    if (!roleMatches(await memberRoles(env, row.author_id, fetcher), row.poster_name)) throw new HttpError(403, 'Your matching Discord IGN role is required to claim this artwork.');
    return json({ id: row.id, title: row.title, settings: JSON.parse(row.settings), sha256: row.artifact_sha256, pixels: `/api/mapart/bridge/${row.id}/pixels/` });
  }
  const match = path.match(/^\/api\/mapart\/bridge\/([a-f0-9-]{36})\/(source|result|failed|pixels)\/$/);
  const row = match ? await get(env, match[1]) : null;
  if (!row || row.status === 'deleted') throw new HttpError(404, 'Artwork not found.');
  if (match[2] === 'pixels' && request.method === 'GET' && row.status === 'ready') return stored(env, artifactKey(row.id, row.artifact_token, 'pixels'), 'application/octet-stream');
  leaseCheck(request, row);
  if (match[2] === 'source' && request.method === 'GET') {
    const media = row.media_id ? await env.DB.prepare("SELECT * FROM media WHERE id=? AND state='ready'").bind(row.media_id).first() : null;
    const object = await env.MEDIA.get(media ? `${media.slug}/${media.id}` : sourceKey(row));
    if (!object) throw new HttpError(404, 'The source image is unavailable.');
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (bytes.length > MAPART_FILE_LIMIT) throw new HttpError(413, 'The image exceeds the file limit.');
    const sha256 = await digest(bytes);
    if (row.source_sha256 && row.source_sha256 !== sha256) throw new HttpError(409, 'The source checksum changed.');
    await env.DB.prepare('UPDATE mapart_jobs SET source_sha256=? WHERE id=? AND lease=?').bind(sha256, row.id, row.lease).run();
    return new Response(bytes, { headers: { 'Content-Type': imageType(bytes), 'Cache-Control': 'no-store', 'X-Content-SHA256': sha256 } });
  }
  if (match[2] === 'failed' && request.method === 'POST') {
    await env.DB.prepare("UPDATE mapart_jobs SET status='failed',error=?,lease=NULL,lease_until=NULL,updated=? WHERE id=? AND lease=?").bind('The server could not convert this image. Retry, or delete it and choose another image.', Date.now(), row.id, row.lease).run();
    return json({ recorded: true });
  }
  if (match[2] === 'result' && request.method === 'POST') {
    const settings = JSON.parse(row.settings), length = settings.columns * settings.rows * 16384;
    const form = await mapartForm(request, MAPART_PREVIEW_LIMIT + MAPART_DATA_LIMIT + 65536);
    const pixels = await fileBytes(form, 'pixels', MAPART_DATA_LIMIT), preview = await fileBytes(form, 'preview', MAPART_PREVIEW_LIMIT);
    const png = new DataView(preview.buffer, preview.byteOffset, preview.byteLength);
    if (pixels.length !== length || imageType(preview) !== 'image/png' || png.getUint32(16) !== settings.columns * 128 || png.getUint32(20) !== settings.rows * 128) throw new HttpError(400, 'The converted image dimensions do not match the artwork.');
    const sha256 = await digest(pixels), key = kind => artifactKey(row.id, row.lease, kind);
    await measureLegacyStorage(env, row.author_id);
    // Reserve the exact output size atomically before either object is written.
    // A failed write keeps its reservation until cleanup confirms both files are gone.
    try {
      const reserved = await env.DB.prepare("UPDATE mapart_attempts SET bytes=MAX(bytes,?) WHERE token=? AND EXISTS(SELECT 1 FROM mapart_jobs WHERE id=? AND status='converting' AND lease=? AND lease_until>?) RETURNING token")
        .bind(pixels.length + preview.length, row.lease, row.id, row.lease, Date.now()).first();
      if (!reserved) throw new HttpError(409, 'The artwork changed during conversion.');
    } catch (error) {
      if (String(error).includes('mapart_storage_quota')) {
        await env.DB.prepare("UPDATE mapart_jobs SET status='failed',error='Your mapart storage is full. Delete some artwork, then retry conversion.',lease=NULL,lease_until=NULL,updated=? WHERE id=? AND lease=?").bind(Date.now(), row.id, row.lease).run();
      }
      databaseError(error);
    }
    await env.MEDIA.put(key('pixels'), pixels);
    await env.MEDIA.put(key('preview'), preview, { httpMetadata: { contentType: 'image/png' } });
    const updated = await env.DB.prepare("UPDATE mapart_jobs SET status='ready',artifact_token=?,artifact_sha256=?,source_state=CASE WHEN source_state='ready' THEN 'deleting' ELSE source_state END,lease=NULL,lease_until=NULL,error='',updated=? WHERE id=? AND lease=? AND status='converting' AND lease_until>? RETURNING id")
      .bind(row.lease, sha256, Date.now(), row.id, row.lease, Date.now()).first();
    if (!updated) { await env.MEDIA.delete(key('pixels')); await env.MEDIA.delete(key('preview')); throw new HttpError(409, 'The artwork changed during conversion.'); }
    // Failure to delete does not invalidate a completed conversion; the sweep retries.
    try { await deleteSource(env, row); } catch { /* Retain deleting state. */ }
    return json({ recorded: true, sha256 });
  }
  throw new HttpError(405, 'This action is not supported.');
}
async function deleteSource(env, row) {
  if (row.source_state === 'none' || row.source_state === 'deleted') return;
  await env.MEDIA.delete(sourceKey(row));
  await env.DB.prepare("UPDATE mapart_jobs SET source_state='deleted' WHERE id=? AND source_state='deleting'").bind(row.id).run();
  if (row.source_token) await env.DB.prepare('UPDATE mapart_attempts SET bytes=0,size_checked=1 WHERE token=?').bind(row.source_token).run();
}
export async function cleanupMapart(env) {
  if (!env.MEDIA) return;
  await measureLegacyStorage(env);
  const now = Date.now();
  await env.DB.prepare("UPDATE mapart_jobs SET status='failed',error='The source expired. Delete this artwork and upload the image again.',source_state=CASE WHEN source_state IN ('pending','receiving','ready') THEN 'deleting' ELSE source_state END,media_id=NULL,lease=NULL,lease_until=NULL WHERE status IN ('uploading','queued','converting','failed') AND expires<=?").bind(now).run();
  const sources = (await env.DB.prepare("SELECT * FROM mapart_jobs WHERE source_state='deleting' LIMIT 100").all()).results;
  for (const row of sources) { try { await deleteSource(env, row); } catch { console.warn('Mapart source cleanup will retry.'); } }
  const attempts = (await env.DB.prepare("SELECT a.* FROM mapart_attempts a JOIN mapart_jobs j ON j.id=a.job_id WHERE (j.status='deleted' OR a.created<?) AND NOT(j.status='ready' AND j.artifact_token IS a.token) AND NOT(j.source_token IS a.token AND j.source_state!='deleted') AND NOT(j.status='converting' AND j.lease IS a.token AND j.lease_until>?) LIMIT 100").bind(now - 3600000, now).all()).results;
  for (const attempt of attempts) {
    try {
      await env.MEDIA.delete(artifactKey(attempt.job_id, attempt.token, 'pixels'));
      await env.MEDIA.delete(artifactKey(attempt.job_id, attempt.token, 'preview'));
      await env.MEDIA.delete(artifactKey(attempt.job_id, attempt.token, 'source'));
      await env.DB.prepare('DELETE FROM mapart_attempts WHERE token=?').bind(attempt.token).run();
    } catch { console.warn('Mapart artifact cleanup will retry.'); }
  }
}

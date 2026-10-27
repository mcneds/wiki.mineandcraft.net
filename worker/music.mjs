import { musicCoverUrl } from '../shared/music-cover.mjs';
import { HttpError, authorize, configured, session, limit, hash } from './auth.mjs';
import { MUSIC_FILE_LIMIT, MUSIC_USER_LIMIT, MUSIC_TRACK_LIMIT, musicFields, musicAudioSource, audioType, musicClaimCode } from '../shared/music.mjs';
export { musicListHtml, musicPaginationHtml, musicFilterOptionsHtml } from '../shared/music-render.mjs';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const select = `SELECT s.*,p.name AS poster_name,f.id AS file_id,f.filename,f.mime,f.extension,f.bytes,f.sha256,f.state AS audio_state,g.phase AS delivery_phase,g.reason AS delivery_reason FROM music_submissions s JOIN players p ON p.slug=s.poster_slug LEFT JOIN music_files f ON f.submission_id=s.id AND f.state!='deleted' LEFT JOIN music_progress g ON g.submission_id=s.id AND g.catalogue_version=(SELECT catalogue_version FROM music_delivery WHERE id=1)`;
const fileKey = row => `music/${row.submission_id}/${row.id}`;
const owns = (user, row) => user.roles.some(role => role.toLowerCase() === row.poster_name.toLowerCase());
const canManage = (user, row) => user.owner || (row.author_id === user.user_id && owns(user, row));
const publicTrack = row => ({ id: row.id, title: row.title, artist: row.artist, coverUrl: row.cover_url || null, poster: { slug: row.poster_slug, name: row.poster_name }, sourceKind: row.source_kind, sourceUrl: row.source_url, ...(row.audio_source_url ? { audioSourceUrl: row.audio_source_url } : {}), status: row.status, ...(row.audio_state === 'ready' && ['approved', 'released'].includes(row.status) ? { playbackUrl: `/api/music/${row.id}/play/` } : {}), ...(row.delivery_phase ? { delivery: { phase: row.delivery_phase, reason: row.delivery_reason } } : {}), created: row.created, ...(row.status === 'released' ? { claimCode: musicClaimCode(row.id) } : {}) });
const privateTrack = (row, user) => ({ ...publicTrack(row), version: row.version, reviewNote: row.review_note, hasAudio: row.audio_state === 'ready', uploading: ['uploading', 'deleting'].includes(row.audio_state), canManage: canManage(user, row), ...(row.audio_state === 'ready' ? { audioUrl: `/api/music/${row.id}/audio/`, filename: row.filename } : {}) });
const pagination = params => Math.max(1, Math.min(10000, Number.parseInt(params.get('page') || '1', 10) || 1));
const getTrack = (env, id) => env.DB.prepare(`${select} WHERE s.id=? AND s.status!='deleted'`).bind(id).first();
const creditArtists = credit => credit.split(',').map(artist => artist.trim()).filter(Boolean);

export async function musicList(env, params = new URLSearchParams()) {
  const query = (params.get('q') || '').trim().slice(0, 120);
  // Resolve individual artists to their full credits before SQL pagination.
  // This keeps existing track credits intact and includes collaborations.
  const credits = (await env.DB.prepare("SELECT DISTINCT artist FROM music_submissions WHERE status IN ('approved','released') AND artist!='' ORDER BY artist COLLATE NOCASE").all()).results.map(row => row.artist);
  const artistNames = new Map();
  for (const credit of credits) for (const artist of creditArtists(credit)) {
    if (!artistNames.has(artist.toLowerCase())) artistNames.set(artist.toLowerCase(), artist);
  }
  // Older gallery links selected a whole credit; retain its first artist.
  const requestedArtist = creditArtists((params.get('artist') || '').slice(0, 100))[0] || '';
  const filters = { artist: artistNames.get(requestedArtist.toLowerCase()) || requestedArtist, uploader: (params.get('uploader') || '').slice(0, 50) };
  const where = "s.status IN ('approved','released')" + (query ? ' AND (instr(lower(s.title),lower(?))>0 OR instr(lower(s.artist),lower(?))>0 OR instr(lower(p.name),lower(?))>0)' : '') + (filters.artist ? ' AND s.artist IN (SELECT value FROM json_each(?))' : '') + (filters.uploader ? ' AND s.poster_slug=?' : '');
  const values = query ? [query, query, query] : [];
  if (filters.artist) values.push(JSON.stringify(credits.filter(credit => creditArtists(credit).some(artist => artist.toLowerCase() === filters.artist.toLowerCase()))));
  if (filters.uploader) values.push(filters.uploader);
  const total = (await env.DB.prepare(`SELECT count(*) AS total FROM music_submissions s JOIN players p ON p.slug=s.poster_slug WHERE ${where}`).bind(...values).first()).total;
  const pages = Math.max(1, Math.ceil(total / 30)), page = Math.min(pagination(params), pages);
  const rows = (await env.DB.prepare(`${select} WHERE ${where} ORDER BY s.created DESC,s.id LIMIT 30 OFFSET ?`).bind(...values, (page - 1) * 30).all()).results;
  // Keep filter choices available across pages and even when a combination is empty.
  const artists = [...artistNames.values()].sort((a, b) => a.localeCompare(b));
  const uploaders = (await env.DB.prepare("SELECT DISTINCT p.slug,p.name FROM music_submissions s JOIN players p ON p.slug=s.poster_slug WHERE s.status IN ('approved','released') ORDER BY p.name COLLATE NOCASE").all()).results;
  return { tracks: rows.map(publicTrack), total, page, pages, query, filters, artists, uploaders };
}

// Public listening is limited to approved audio; pending originals stay private.
export async function musicPlayback(request, env, id) {
  const row = await getTrack(env, id);
  if (!row || !['approved', 'released'].includes(row.status) || row.audio_state !== 'ready') throw new HttpError(404, 'Audio is not available yet.');
  const key = fileKey({ id: row.file_id, submission_id: row.id });
  const metadata = await env.MEDIA?.head(key);
  if (!metadata) throw new HttpError(404, 'Audio not found.');
  const size = metadata.size;
  const headers = new Headers({ 'Content-Type': row.mime, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') return new Response(null, { headers });
  let range;
  // If-Range without a matching validator falls back to a complete response.
  const requested = request.headers.get('Range');
  if (requested && !request.headers.has('If-Range')) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(requested);
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
        headers.set('Content-Range', `bytes */${size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      range = { offset: start, length: end - start + 1 };
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(range.length));
    }
    // Ignore malformed or multipart ranges, which this endpoint does not serve.
  }
  const object = await env.MEDIA.get(key, range ? { range } : undefined);
  if (!object) throw new HttpError(404, 'Audio not found.');
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function musicContext(request, env, fetcher) {
  const user = configured(env) && await session(request, env) ? await authorize(request, env, fetcher) : null;
  if (!user) return json({ user: null, postingPlayers: [], submissions: [], page: 1, hasMore: false });
  const players = (await env.DB.prepare('SELECT slug,name FROM players ORDER BY name COLLATE NOCASE').all()).results;
  const postingPlayers = players.filter(player => user.roles.some(role => role.toLowerCase() === player.name.toLowerCase()));
  const params = new URL(request.url).searchParams, manageAll = params.get('scope') === 'all';
  if (manageAll && !user.owner) throw new HttpError(403, 'Only the owner can review all music.');
  const page = pagination(params);
  const rows = (await env.DB.prepare(`${select} WHERE s.status!='deleted'${manageAll ? '' : ' AND s.author_id=?'} ORDER BY s.created DESC,s.id LIMIT 51 OFFSET ?`).bind(...(manageAll ? [] : [user.user_id]), (page - 1) * 50).all()).results;
  const used = (await env.DB.prepare("SELECT coalesce(sum(bytes),0) AS used FROM music_files WHERE author_id=? AND state!='deleted'").bind(user.user_id).first()).used;
  const delivery = user.owner ? await env.DB.prepare('SELECT heartbeat,state,message FROM music_delivery WHERE id=1').first() : undefined;
  return json({ user: { csrf: user.csrf, owner: user.owner }, postingPlayers, submissions: rows.slice(0, 50).filter(row => canManage(user, row)).map(row => privateTrack(row, user)), page, hasMore: rows.length > 50, ...(delivery ? { delivery } : {}), usage: { used, limit: MUSIC_USER_LIMIT, fileLimit: MUSIC_FILE_LIMIT, trackLimit: MUSIC_TRACK_LIMIT } });
}

function databaseError(error) {
  const message = String(error);
  if (message.includes('music_track_quota')) throw new HttpError(413, 'You have reached the 25-track limit. Remove an unapproved submission first.');
  if (message.includes('music_file_quota')) throw new HttpError(413, 'You have reached the 100 MB music upload limit.');
  if (message.includes('music_audio_required')) throw new HttpError(409, 'Attach audio or confirm a YouTube recording for this Spotify track before approval, and wait for any file operation to finish.');
  if (message.includes('music_not_pending')) throw new HttpError(409, 'This submission changed. Refresh before uploading.');
  if (message.includes('UNIQUE')) throw new HttpError(409, 'An upload is already attached or in progress. Refresh before retrying.');
  throw error;
}

async function createSubmission(env, user, body) {
  let fields;
  try { fields = musicFields(body); } catch (error) { throw new HttpError(400, error.message); }
  if (typeof body.id !== 'string' || !uuid.test(body.id)) throw new HttpError(400, 'Refresh the form before submitting.');
  const existing = await getTrack(env, body.id);
  if (existing) {
    if (existing.author_id !== user.user_id || !canManage(user, existing)) throw new HttpError(409, 'This submission ID is already in use.');
    if (existing.cover_url !== fields.coverUrl || existing.title !== fields.title || existing.artist !== fields.artist || existing.source_url !== fields.source.url || existing.audio_source_url !== fields.audioSourceUrl || existing.poster_slug !== body.posterSlug) throw new HttpError(409, 'This submission was already saved with different details. Refresh your submissions.');
    return json(privateTrack(existing, user));
  }
  const player = await env.DB.prepare('SELECT name FROM players WHERE slug=?').bind(String(body.posterSlug || '')).first();
  if (!player || !user.roles.some(role => role.toLowerCase() === player.name.toLowerCase())) throw new HttpError(403, 'Choose your player page with its matching Discord IGN role to submit music.');
  await limit(env, `music-submit:${user.user_id}`, 5, 60);
  const timestamp = new Date().toISOString();
  try {
    await env.DB.prepare('INSERT INTO music_submissions(id,poster_slug,author_id,title,artist,source_kind,source_url,audio_source_url,cover_url,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind(body.id, body.posterSlug, user.user_id, fields.title, fields.artist, fields.source.kind, fields.source.url, fields.audioSourceUrl, fields.coverUrl, timestamp, timestamp).run();
  } catch (error) { databaseError(error); }
  return json(privateTrack(await getTrack(env, body.id), user), 201);
}

async function readAudio(request) {
  if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data;')) throw new HttpError(415, 'Upload the audio using the file picker.');
  const maximum = MUSIC_FILE_LIMIT + 65536;
  if (Number(request.headers.get('Content-Length') || 0) > maximum) throw new HttpError(413, 'Audio files must be 20 MB or smaller.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Choose an audio file.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > maximum) { await reader.cancel(); throw new HttpError(413, 'Audio files must be 20 MB or smaller.'); }
    chunks.push(value);
  }
  let form;
  try { form = await new Response(new Blob(chunks), { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData(); }
  catch { throw new HttpError(400, 'The upload could not be read. Choose the file again.'); }
  const file = form.get('file');
  if (!(file instanceof File) || !file.size || file.size > MUSIC_FILE_LIMIT) throw new HttpError(413, 'Choose an audio file up to 20 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let type;
  try { type = audioType(bytes); } catch (error) { throw new HttpError(415, error.message); }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { bytes, ...type, sha256, filename: file.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) || `audio.${type.extension}` };
}

async function attachAudio(request, env, user, row, bridge = false) {
  if (!env.MEDIA) throw new HttpError(503, 'Audio uploads are temporarily unavailable.');
  if (!(bridge ? row.status === 'approved' && (row.source_kind === 'youtube' || (row.source_kind === 'spotify' && row.audio_source_url)) : ['pending', 'rejected'].includes(row.status))) throw new HttpError(409, 'Audio can only be attached before approval.');
  const file = await readAudio(request);
  // A retry after a lost response reuses the stored file, without charging twice.
  if (row.audio_state === 'ready' && row.sha256 === file.sha256) return json(privateTrack(row, user));
  if (row.file_id) throw new HttpError(409, 'This submission already has an audio file or an upload in progress.');
  const reservation = { id: crypto.randomUUID(), submission_id: row.id };
  try {
    await env.DB.prepare("INSERT INTO music_files(id,submission_id,author_id,filename,mime,extension,bytes,sha256,state,created) VALUES(?,?,?,?,?,?,?,?,'uploading',?)")
      .bind(reservation.id, row.id, row.author_id, file.filename, file.mime, file.extension, file.bytes.length, file.sha256, Date.now()).run();
  } catch (error) { databaseError(error); }
  try {
    await env.MEDIA.put(fileKey(reservation), file.bytes, { httpMetadata: { contentType: file.mime } });
    const ready = await env.DB.prepare("UPDATE music_files SET state='ready' WHERE id=? AND state='uploading' RETURNING id").bind(reservation.id).first();
    if (!ready) throw new Error('Upload reservation expired');
    await env.DB.prepare("UPDATE music_submissions SET status=CASE WHEN version=? AND status='rejected' THEN 'pending' ELSE status END,audio_source_url=CASE WHEN ? THEN NULL ELSE audio_source_url END,version=version+1,updated=? WHERE id=?")
      .bind(row.version, bridge ? 0 : 1, new Date().toISOString(), row.id).run();
  } catch {
    try { await env.MEDIA.delete(fileKey(reservation)); await env.DB.prepare("UPDATE music_files SET state='deleted' WHERE id=?").bind(reservation.id).run(); } catch { /* The scheduled sweep retains quota until storage deletion succeeds. */ }
    throw new HttpError(503, 'The submission is saved, but its audio upload failed. Retry the upload.');
  }
  return json(privateTrack(await getTrack(env, row.id) || row, user));
}

async function deliveryManifest(env) {
  const snapshot = await env.DB.prepare('SELECT catalogue_version FROM music_delivery WHERE id=1').first();
  const rows = (await env.DB.prepare(`${select} WHERE s.status IN ('approved','released') ORDER BY s.id`).all()).results;
  if (rows.length > 2000) throw new HttpError(413, 'The music catalogue exceeds the 2,000-track limit.');
  if (rows.some(row => row.audio_state === 'uploading' || (!row.file_id && row.source_kind !== 'youtube' && !(row.source_kind === 'spotify' && row.audio_source_url)))) throw new HttpError(409, 'An approved track is missing its audio.');
  const tracks = rows.map(row => ({ ...publicTrack(row), version: row.version, libraryId: row.author_id, ...(row.file_id ? { audio: `/api/music/bridge/${row.id}/audio/`, sha256: row.sha256 } : {}) }));
  const releaseId = await hash(JSON.stringify(tracks.map(({ id, title, artist, sourceKind, sourceUrl, audioSourceUrl, sha256 }) => ({ id, title, artist, sourceKind, sourceUrl, audioSourceUrl, sha256 }))));
  return { schema: 1, releaseId, catalogueVersion: snapshot.catalogue_version, tracks };
}

// This credential only reads approved sources, attaches converted YouTube audio,
// and reports delivery. It cannot sign in, approve music or edit wiki content.
export async function musicBridge(request, env, body) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.{32,256})$/)?.[1];
  if (!token || typeof env.MUSIC_BRIDGE_KEY !== 'string' || env.MUSIC_BRIDGE_KEY.length < 32 || await hash(token) !== await hash(env.MUSIC_BRIDGE_KEY)) throw new HttpError(401, 'Music server authentication failed.');
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/api/music/bridge/manifest/') {
    await env.DB.prepare('UPDATE music_delivery SET heartbeat=? WHERE id=1').bind(Date.now()).run();
    return json(await deliveryManifest(env));
  }
  if (request.method === 'POST' && path === '/api/music/bridge/heartbeat/') {
    await env.DB.prepare('UPDATE music_delivery SET heartbeat=? WHERE id=1').bind(Date.now()).run();
    return json({ recorded: true });
  }
  if (request.method === 'POST' && path === '/api/music/bridge/progress/') {
    const phases = ['queued','fetching_audio','converting','waiting_for_empty_server','installing','installed','failed'];
    const reasons = ['', 'youtube_access_blocked','provider_unavailable','invalid_audio','installation_failed'];
    if (!phases.includes(body.phase) || !reasons.includes(body.reason || '') || !uuid.test(body.trackId || '')) throw new HttpError(400, 'Invalid music progress.');
    const current = await deliveryManifest(env);
    if (current.releaseId !== body.releaseId || current.catalogueVersion !== body.catalogueVersion || !current.tracks.some(track => track.id === body.trackId)) throw new HttpError(409, 'This music attempt is out of date.');
    const recorded = await env.DB.prepare('INSERT INTO music_progress(submission_id,release_id,catalogue_version,phase,reason,updated) SELECT ?,?,?,?,?,? WHERE (SELECT catalogue_version FROM music_delivery WHERE id=1)=? ON CONFLICT(submission_id) DO UPDATE SET release_id=excluded.release_id,catalogue_version=excluded.catalogue_version,phase=excluded.phase,reason=excluded.reason,updated=excluded.updated RETURNING submission_id')
      .bind(body.trackId, body.releaseId, body.catalogueVersion, body.phase, body.reason || '', Date.now(), body.catalogueVersion).first();
    if (!recorded) throw new HttpError(409, 'This music attempt is out of date.');
    return json({ recorded: true });
  }
  if (request.method === 'POST' && path === '/api/music/bridge/report/') {
    if (!['installed', 'failed', 'waiting'].includes(body.status) || !/^[a-f0-9]{64}$/.test(body.releaseId || '')) throw new HttpError(400, 'Invalid delivery report.');
    const current = await deliveryManifest(env);
    if (current.releaseId !== body.releaseId || current.catalogueVersion !== body.catalogueVersion) throw new HttpError(409, 'The approved catalogue changed. Rebuild before reporting delivery.');
    if (body.status === 'installed') {
      if (current.tracks.some(track => !track.audio)) throw new HttpError(409, 'Convert and store every source before installing.');
      try { await env.DB.batch([
        ...current.tracks.map(track => env.DB.prepare("INSERT INTO music_progress(submission_id,release_id,catalogue_version,phase,reason,updated) VALUES(?,?,?,'installed','',?) ON CONFLICT(submission_id) DO UPDATE SET release_id=excluded.release_id,catalogue_version=excluded.catalogue_version,phase='installed',reason='',updated=excluded.updated").bind(track.id, body.releaseId, current.catalogueVersion, Date.now())),
        ...current.tracks.filter(track => track.status === 'approved').map(track => env.DB.prepare("UPDATE music_submissions SET status='released',version=version+1,updated=? WHERE id=? AND version=? AND status='approved'").bind(new Date().toISOString(), track.id, track.version)),
        env.DB.prepare("UPDATE music_delivery SET state='installed',release_id=?,installed_catalogue_version=?,message='',heartbeat=? WHERE id=1").bind(body.releaseId, current.catalogueVersion, Date.now()),
      ]); } catch (error) {
        if (String(error).includes('music_catalogue_changed')) throw new HttpError(409, 'The collection changed during delivery. Rebuild before reporting installation.');
        throw error;
      }
    } else {
      const message = typeof body.message === 'string' ? body.message.slice(0, 500) : 'The server could not install the music update.';
      await env.DB.prepare('UPDATE music_delivery SET state=?,message=?,heartbeat=? WHERE id=1').bind(body.status, message, Date.now()).run();
    }
    return json({ recorded: true });
  }
  const match = path.match(/^\/api\/music\/bridge\/([a-f0-9-]{36})\/audio\/$/);
  if (match) {
    const row = await getTrack(env, match[1]);
    if (!row || !['approved', 'released'].includes(row.status)) throw new HttpError(404, 'Approved audio not found.');
    if (request.method === 'POST') return attachAudio(request, env, { owner: true }, row, true);
    if (request.method === 'GET' && row.audio_state === 'ready') {
      const object = await env.MEDIA?.get(fileKey({ id: row.file_id, submission_id: row.id }));
      if (!object) throw new HttpError(404, 'Approved audio not found.');
      return new Response(object.body, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
  }
  throw new HttpError(405, 'This music server action is not supported.');
}

export async function musicApi(request, env, user, body) {
  const path = new URL(request.url).pathname, method = request.method;
  if (path === '/api/music/' && method === 'POST') return createSubmission(env, user, body);
  const match = path.match(/^\/api\/music\/([a-f0-9-]{36})\/(audio\/|review\/|source\/|cover\/)?$/);
  if (!match) throw new HttpError(404, 'Music submission not found.');
  const row = await getTrack(env, match[1]);
  if (!row) throw new HttpError(404, 'Music submission not found.');
  if (!canManage(user, row)) throw new HttpError(403, 'You can only manage your own music submissions.');
  if (match[2] === 'cover/' && method === 'POST') {
    let coverUrl;
    try { coverUrl = musicCoverUrl(body.coverUrl); } catch (error) { throw new HttpError(400, error.message); }
    if (!Number.isSafeInteger(body.version)) throw new HttpError(400, 'Refresh before saving the cover.');
    const changed = await env.DB.prepare("UPDATE music_submissions SET cover_url=?,version=version+1,updated=? WHERE id=? AND version=? AND status!='deleted' RETURNING id")
      .bind(coverUrl, new Date().toISOString(), row.id, body.version).first();
    if (!changed) throw new HttpError(409, 'This track changed. Refresh before saving the cover.');
    return json(privateTrack(await getTrack(env, row.id), user));
  }
  if (match[2] === 'source/' && method === 'POST') {
    let source;
    try { source = musicAudioSource(row.source_kind, body.audioSourceUrl, body.audioSourceConfirmed); }
    catch (error) { throw new HttpError(400, error.message); }
    if (!source || !Number.isSafeInteger(body.version)) throw new HttpError(400, 'Choose and confirm a recording, then refresh before saving.');
    const changed = await env.DB.prepare("UPDATE music_submissions SET audio_source_url=?,status='pending',version=version+1,updated=? WHERE id=? AND version=? AND source_kind='spotify' AND status IN ('pending','rejected') AND NOT EXISTS(SELECT 1 FROM music_files WHERE submission_id=? AND state!='deleted') RETURNING id")
      .bind(source, new Date().toISOString(), row.id, body.version, row.id).first();
    if (!changed) throw new HttpError(409, 'Refresh this unapproved Spotify track and remove its audio file before changing the recording.');
    return json(privateTrack(await getTrack(env, row.id), user));
  }
  if (match[2] === 'audio/' && method === 'POST') return attachAudio(request, env, user, row);
  if (match[2] === 'audio/' && method === 'DELETE') {
    if (!['pending', 'rejected'].includes(row.status) || !['ready', 'deleting'].includes(row.audio_state)) throw new HttpError(409, 'Only an unapproved audio file can be removed.');
    if (!Number.isSafeInteger(body.version)) throw new HttpError(400, 'Refresh the submission before removing audio.');
    // Block approval before storage deletion; the file remains charged until R2
    // confirms deletion. The SQL condition closes an approval/removal race.
    const reserved = await env.DB.prepare("UPDATE music_files SET state='deleting' WHERE id=? AND state IN ('ready','deleting') AND EXISTS(SELECT 1 FROM music_submissions WHERE id=? AND version=? AND status IN ('pending','rejected')) RETURNING id")
      .bind(row.file_id, row.id, body.version).first();
    if (!reserved) throw new HttpError(409, 'This submission changed. Refresh before removing audio.');
    try {
      await env.MEDIA.delete(fileKey({ id: row.file_id, submission_id: row.id }));
      await env.DB.prepare("UPDATE music_files SET state='deleted' WHERE id=?").bind(row.file_id).run();
      await env.DB.prepare('UPDATE music_submissions SET version=version+1,updated=? WHERE id=?').bind(new Date().toISOString(), row.id).run();
    } catch { return json({ deleted: true, deletionPending: true }); }
    return json({ deleted: true });
  }
  if (match[2] === 'audio/' && method === 'GET') {
    if (row.audio_state !== 'ready') throw new HttpError(404, 'Audio not found.');
    const object = await env.MEDIA?.get(fileKey({ id: row.file_id, submission_id: row.id }));
    if (!object) throw new HttpError(404, 'Audio not found.');
    return new Response(object.body, { headers: { 'Content-Type': row.mime, 'Content-Disposition': `inline; filename="${row.id}.${row.extension}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (method === 'POST' && match[2] === 'review/') {
    if (!user.owner) throw new HttpError(403, 'Only the owner can review music submissions.');
    if (!['approved', 'rejected'].includes(body.status) || typeof body.note !== 'string' || body.note.length > 500 || body.note.includes('\0')) throw new HttpError(400, 'Choose a review decision and a note up to 500 characters.');
    if (row.status === 'released') throw new HttpError(409, 'Installed tracks remain in future packs.');
    if (!Number.isSafeInteger(body.version)) throw new HttpError(400, 'Refresh the submission before reviewing.');
    try {
      const changed = await env.DB.prepare('UPDATE music_submissions SET status=?,review_note=?,version=version+1,updated=? WHERE id=? AND version=? RETURNING id')
        .bind(body.status, body.note.trim(), new Date().toISOString(), row.id, body.version).first();
      if (!changed) throw new HttpError(409, 'This submission changed. Refresh before reviewing.');
    } catch (error) { databaseError(error); }
    return json(privateTrack(await getTrack(env, row.id), user));
  }
  if (!match[2] && method === 'DELETE') {
    if (!['pending', 'rejected'].includes(row.status)) throw new HttpError(409, 'Approved and installed tracks cannot be deleted.');
    if (!Number.isSafeInteger(body.version)) throw new HttpError(400, 'Refresh the submission before deleting.');
    const changed = await env.DB.prepare("UPDATE music_submissions SET status='deleted',version=version+1,updated=? WHERE id=? AND version=? AND status IN ('pending','rejected') RETURNING id")
      .bind(new Date().toISOString(), row.id, body.version).first();
    if (!changed) throw new HttpError(409, 'This submission changed. Refresh before deleting.');
    let deletionPending = false;
    if (row.file_id && row.audio_state === 'ready') {
      try { await env.MEDIA.delete(fileKey({ id: row.file_id, submission_id: row.id })); await env.DB.prepare("UPDATE music_files SET state='deleted' WHERE id=?").bind(row.file_id).run(); }
      catch { deletionPending = true; }
    } else if (row.file_id) deletionPending = true;
    return json({ deleted: true, deletionPending });
  }
  throw new HttpError(405, 'This action is not supported.');
}

export async function cleanupMusic(env) {
  if (!env.MEDIA) return;
  const files = (await env.DB.prepare("SELECT f.* FROM music_files f JOIN music_submissions s ON s.id=f.submission_id WHERE f.state!='deleted' AND (f.state='deleting' OR (f.state='uploading' AND f.created<?) OR (s.status='deleted' AND s.updated<?)) LIMIT 30")
    .bind(Date.now() - 3600000, new Date(Date.now() - 3600000).toISOString()).all()).results;
  for (const file of files) {
    try { await env.MEDIA.delete(fileKey(file)); await env.DB.prepare("UPDATE music_files SET state='deleted' WHERE id=?").bind(file.id).run(); } catch { /* Retry next hour; reservation stays charged. */ }
  }
}

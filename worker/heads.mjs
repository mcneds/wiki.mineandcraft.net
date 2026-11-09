import { HttpError, limit, memberRoles } from './auth.mjs';
import { lookup } from './lookup.mjs';
import { musicFields, musicClaimCode } from '../shared/music.mjs';
import { select, publicTrack, privateTrack, musicContext, databaseError } from './music.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const json = value => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
const rolesMatch = (roles, name) => roles.some(role => role.toLowerCase() === name.toLowerCase());
export async function freshWhitelist(env) {
  const snapshot = await env.DB.prepare('SELECT received FROM head_whitelist_snapshot WHERE id=1').first();
  if (!snapshot || snapshot.received < Date.now() - 120000) throw new HttpError(503, 'Head permissions are waiting for a fresh server whitelist. Please retry shortly.');
}
export async function ownsHead(env, roles, head) {
  const players = (await env.DB.prepare('SELECT name FROM players WHERE minecraft_id=?').bind(head.minecraft_id).all()).results;
  return rolesMatch(roles, head.name) || players.some(player => rolesMatch(roles, player.name));
}
async function allowedTarget(env, roles, head) {
  await freshWhitelist(env);
  const owned = await ownsHead(env, roles, head);
  if (!owned && await env.DB.prepare('SELECT uuid FROM head_whitelist WHERE uuid=?').bind(head.target_uuid).first()) throw new HttpError(403, 'Only this whitelisted account’s verified owner may set its head sound.');
  return owned;
}
export async function validateHeadAuthor(env, row, fetcher) {
  const head = await env.DB.prepare('SELECT * FROM sound_heads WHERE id=?').bind(row.head_id).first();
  if (!head) throw new HttpError(409, 'Head association not found.');
  const roles = await memberRoles(env, row.author_id, fetcher);
  const poster = await env.DB.prepare('SELECT name FROM players WHERE slug=?').bind(row.poster_slug).first();
  if (!poster || !rolesMatch(roles, poster.name)) throw new HttpError(403, 'The submitter no longer owns their posting profile.');
  const owned = await allowedTarget(env, roles, head);
  // Never allow an old ownership attestation to authorize a new release.
  if (row.head_owned && !owned) throw new HttpError(403, 'The submitter no longer owns this head.');
}
export async function guardHeadAction(env, user, row, action, method, fetcher, body) {
  if (row.kind !== 'head') return;
  if (['cover/', 'source/'].includes(action)) throw new HttpError(400, 'Head sounds accept audio files only.');
  if (method === 'GET' || method === 'HEAD') return;
  if (action === 'review/') {
    if (body.status !== 'approved') return;
    await validateHeadAuthor(env, row, fetcher);
  } else if (method !== 'DELETE') {
    const head = await env.DB.prepare('SELECT * FROM sound_heads WHERE id=?').bind(row.head_id).first();
    await allowedTarget(env, user.roles, head);
    if (user.user_id !== row.author_id) throw new HttpError(403, 'Only the submitter may upload this head’s sound.');
  }
}
export function headTrack(row) {
  return { ...publicTrack(row), head: { id: row.head_id, name: row.head_name, edition: row.head_edition, version: row.head_version,
    image: `/heads/image/${row.head_id}.png` }, ...(row.status === 'released' ? { claimCode: musicClaimCode(row.head_id) } : {}) };
}
export async function headsList(env, params = new URLSearchParams()) {
  const query = (params.get('q') || '').trim().slice(0, 120), uploader = (params.get('uploader') || '').slice(0, 50);
  const where = "s.kind='head' AND h.suppressed=0 AND (s.id=h.active_id OR (h.active_id IS NULL AND s.status='approved'))" +
    (query ? ' AND (instr(lower(s.title),lower(?))>0 OR instr(lower(h.name),lower(?))>0 OR instr(lower(p.name),lower(?))>0)' : '') + (uploader ? ' AND s.poster_slug=?' : '');
  const values = [...(query ? [query, query, query] : []), ...(uploader ? [uploader] : [])];
  const total = (await env.DB.prepare(`SELECT count(*) AS total FROM music_submissions s JOIN sound_heads h ON h.id=s.head_id JOIN players p ON p.slug=s.poster_slug WHERE ${where}`).bind(...values).first()).total;
  const pages = Math.max(1, Math.ceil(total / 30)), page = Math.max(1, Math.min(pages, parseInt(params.get('page')) || 1));
  const rows = (await env.DB.prepare(`${select} WHERE ${where} ORDER BY s.created DESC,s.id LIMIT 30 OFFSET ?`).bind(...values, (page - 1) * 30).all()).results;
  const uploaders = (await env.DB.prepare("SELECT DISTINCT p.slug,p.name FROM music_submissions s JOIN sound_heads h ON h.id=s.head_id JOIN players p ON p.slug=s.poster_slug WHERE h.suppressed=0 AND (s.id=h.active_id OR (h.active_id IS NULL AND s.status='approved')) ORDER BY p.name COLLATE NOCASE").all()).results;
  return { tracks: rows.map(headTrack), total, page, pages, query, filters: { uploader }, uploaders };
}
export async function headContext(request, env, fetcher) {
  return musicContext(request, env, fetcher, 'head');
}
async function resolveHead(body, fetcher) {
  const value = await lookup(body, fetcher);
  const id = value.edition === 'java' ? value.minecraft_id.slice(5) : BigInt(value.minecraft_id.slice(8)).toString(16).padStart(32, '0');
  const target_uuid = id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  // An ID-only Java profile is dynamic: Minecraft resolves its current skin.
  // Supplying both name and ID without textures creates a static default skin.
  return { ...value, target_uuid, profile: { id: target_uuid, ...(value.texture ? { name: value.name, properties: [{ name: 'textures', value: value.texture }] } : {}) } };
}
export async function headsApi(request, env, user, body, fetcher) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !['/api/heads/', '/api/heads/lookup/'].includes(path)) throw new HttpError(405, 'This head action is not supported.');
  await limit(env, `head-lookup:${user.user_id}`, 15, 60);
  const target = await resolveHead(body, fetcher);
  const owned = await allowedTarget(env, user.roles, target);
  const existing = await env.DB.prepare('SELECT * FROM sound_heads WHERE minecraft_id=?').bind(target.minecraft_id).first();
  const canReplace = !existing || (!existing.active_id && !existing.pending_id) || existing.author_id === user.user_id || owned;
  const canTakeOver = Boolean(existing && owned && existing.author_id !== user.user_id);
  if (path.endsWith('/lookup/')) return json({ name: target.name, edition: target.edition, preview: target.preview, canReplace, canTakeOver,
    association: existing ? { id: existing.id, version: existing.version, hasPending: Boolean(existing.pending_id) } : null });
  if (!canReplace) throw new HttpError(403, 'This head already belongs to another submitter.');
  if (!uuid.test(body.id || '')) throw new HttpError(400, 'Refresh the form before submitting.');
  let fields;
  try { fields = musicFields({ title: body.title }); } catch (error) { throw new HttpError(400, error.message); }
  const prior = await env.DB.prepare(`${select} WHERE s.id=?`).bind(body.id).first();
  if (prior) {
    if (prior.kind !== 'head' || prior.author_id !== user.user_id || prior.head_id !== existing?.id || prior.title !== fields.title || prior.poster_slug !== body.posterSlug || prior.status === 'deleted') throw new HttpError(409, 'This submission ID is already in use.');
    return json(privateTrack(prior, user));
  }
  if (existing && (body.version !== existing.version || (existing.pending_id && !canTakeOver))) throw new HttpError(409, 'This head changed or already has a pending replacement. Refresh its lookup.');
  const player = await env.DB.prepare('SELECT name FROM players WHERE slug=?').bind(String(body.posterSlug || '')).first();
  if (!player || !rolesMatch(user.roles, player.name)) throw new HttpError(403, 'Choose your player profile with its matching Discord IGN role.');
  await limit(env, `music-submit:${user.user_id}`, 5, 60);
  const id = existing?.id || crypto.randomUUID(), stamp = new Date().toISOString();
  try {
    await env.DB.batch([
      ...(existing ? [] : [env.DB.prepare('INSERT INTO sound_heads(id,minecraft_id,target_uuid,name,edition,head_png,profile_json,author_id) VALUES(?,?,?,?,?,?,?,?)')
        .bind(id, target.minecraft_id, target.target_uuid, target.name, target.edition, target.head_png, JSON.stringify(target.profile), user.user_id)]),
      ...(existing?.pending_id && canTakeOver ? [env.DB.prepare("UPDATE music_submissions SET status='deleted',updated=?,version=version+1 WHERE id=? AND status IN ('pending','rejected','approved') AND EXISTS(SELECT 1 FROM sound_heads WHERE id=? AND version=?)")
        .bind(stamp, existing.pending_id, existing.id, existing.version)] : []),
      // The conditional insert and unique pending index close simultaneous replacement races.
      env.DB.prepare("INSERT INTO music_submissions(id,poster_slug,author_id,title,artist,source_kind,created,updated,kind,head_id,head_owned) SELECT ?,?,?,?,'','file',?,?,'head',?,? WHERE EXISTS(SELECT 1 FROM sound_heads WHERE id=? AND version=? AND pending_id IS NULL)")
        .bind(body.id, body.posterSlug, user.user_id, fields.title, stamp, stamp, id, owned ? 1 : 0, id, (existing?.version || 1) + (existing?.pending_id && canTakeOver ? 1 : 0)),
      env.DB.prepare('UPDATE sound_heads SET name=?,head_png=?,profile_json=? WHERE id=? AND pending_id=?')
        .bind(target.name, target.head_png, JSON.stringify(target.profile), id, body.id),
    ]);
  } catch (error) { databaseError(error); }
  const row = await env.DB.prepare(`${select} WHERE s.id=?`).bind(body.id).first();
  if (!row) throw new HttpError(409, 'This head changed. Refresh before submitting.');
  return json(privateTrack(row, user));
}

// Called only after the shared music bridge credential has been verified.
export async function headsBridge(request, env, body) {
  const path = new URL(request.url).pathname;
  if (path === '/api/music/bridge/heads/whitelist/' && request.method === 'POST') {
    if (!Array.isArray(body.players) || body.players.length > 2000 || !body.players.every(p => uuid.test(p.uuid || '') && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 64)) throw new HttpError(400, 'Invalid whitelist snapshot.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM head_whitelist'),
      env.DB.prepare('INSERT INTO head_whitelist(uuid,name) SELECT json_extract(value,\'$.uuid\'),json_extract(value,\'$.name\') FROM json_each(?)').bind(JSON.stringify(body.players)),
      env.DB.prepare('UPDATE head_whitelist_snapshot SET received=? WHERE id=1').bind(Date.now()),
      env.DB.prepare("UPDATE sound_heads SET suppressed=CASE WHEN active_id IS NOT NULL AND EXISTS(SELECT 1 FROM head_whitelist WHERE uuid=sound_heads.target_uuid) AND NOT EXISTS(SELECT 1 FROM music_submissions WHERE id=sound_heads.active_id AND head_owned=1) THEN 1 ELSE 0 END"),
    ]);
    return json({ recorded: true });
  }
  if (path === '/api/music/bridge/heads/validation/' && request.method === 'GET') {
    const rows = (await env.DB.prepare("SELECT s.id,s.version,f.id AS fileId,f.sha256 FROM music_submissions s JOIN music_files f ON f.submission_id=s.id WHERE s.kind='head' AND s.status IN ('pending','rejected') AND f.state='ready' AND f.validation='pending' LIMIT 25").all()).results;
    return json({ submissions: rows.map(row => ({ ...row, audio: `/api/music/bridge/heads/${row.id}/audio/` })) });
  }
  const match = path.match(/^\/api\/music\/bridge\/heads\/([a-f0-9-]{36})\/(audio|validation)\/$/);
  if (!match) throw new HttpError(404, 'Head bridge endpoint not found.');
  const row = await env.DB.prepare(`${select} WHERE s.id=? AND s.kind='head' AND s.status IN ('pending','rejected') AND f.state='ready'`).bind(match[1]).first();
  if (!row) throw new HttpError(404, 'Pending head audio not found.');
  if (match[2] === 'audio' && request.method === 'GET') {
    const object = await env.MEDIA?.get(`music/${row.id}/${row.file_id}`);
    if (!object) throw new HttpError(404, 'Audio not found.');
    return new Response(object.body, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'no-store' } });
  }
  if (match[2] === 'validation' && request.method === 'POST') {
    if (body.fileId !== row.file_id || body.sha256 !== row.sha256 || body.version !== row.version) throw new HttpError(409, 'This validation result is out of date.');
    if (typeof body.valid !== 'boolean' || (body.valid && (!Number.isFinite(body.durationMs) || body.durationMs <= 0 || body.durationMs > 10000))) throw new HttpError(400, 'Invalid audio validation result.');
    const changed = await env.DB.prepare("UPDATE music_files SET validation=?,duration_ms=? WHERE id=? AND state='ready' AND sha256=? AND EXISTS(SELECT 1 FROM music_submissions WHERE id=? AND version=? AND status IN ('pending','rejected')) RETURNING id")
      .bind(body.valid ? 'valid' : 'invalid', body.valid ? body.durationMs : null, body.fileId, body.sha256, row.id, body.version).first();
    if (!changed) throw new HttpError(409, 'This validation result is out of date.');
    return json({ recorded: true });
  }
  throw new HttpError(405, 'This head bridge action is not supported.');
}

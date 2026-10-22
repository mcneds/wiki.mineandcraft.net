import { HttpError, configured, session, authorize, mayEdit } from './auth.mjs';
import { PRESET_TAGS, DIMENSIONS, coordinateUrl } from '../shared/coordinates.mjs';

const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const players = async env => (await env.DB.prepare('SELECT slug,name FROM players ORDER BY name COLLATE NOCASE').all()).results;
const get = (env, id) => env.DB.prepare('SELECT * FROM coordinate_entries WHERE id=?').bind(id).first();
const playerLink = player => ({ slug: player.slug, name: player.name, url: `/wiki/players/${player.slug}/` });
function dto(row, roster) {
  const bySlug = new Map(roster.map(player => [player.slug, player]));
  return {
    id: row.id, url: coordinateUrl(row.id), name: row.name, access: row.access, notes: row.notes,
    ...(row.access === 'public' ? { dimension: row.dimension, x: row.x, y: row.y, z: row.z } : {}),
    tags: JSON.parse(row.tags_json), owners: JSON.parse(row.owners_json).map(slug => bySlug.get(slug)).filter(Boolean).map(playerLink),
    poster: playerLink(bySlug.get(row.poster_slug)),
    image: row.image_id ? { id: row.image_id, url: `/media/${row.image_id}`, alt: row.image_alt } : null,
    version: row.version, created: row.created, updated: row.updated,
  };
}
export async function coordinateDetail(env, id) {
  const row = await get(env, id);
  if (!row) throw new HttpError(404, 'Entry not found.');
  return dto(row, await players(env));
}
export async function coordinateList(env, params) {
  const q = (params.get('q') || '').trim().slice(0, 100).toLowerCase();
  const tag = (params.get('tag') || '').trim().toLowerCase();
  const dimension = params.get('dimension') || '', access = params.get('access') || '';
  if (dimension && !Object.hasOwn(DIMENSIONS, dimension)) throw new HttpError(400, 'Choose a valid dimension.');
  if (access && !['public', 'private'].includes(access)) throw new HttpError(400, 'Choose Public or Private.');
  const page = Math.max(1, Math.min(100000, Number.parseInt(params.get('page') || '1', 10) || 1));
  const where = [], values = [];
  if (q) { where.push("(instr(lower(e.name || ' ' || e.notes),?)>0 OR EXISTS(SELECT 1 FROM coordinate_tags t WHERE t.entry_id=e.id AND instr(t.tag,?)>0) OR EXISTS(SELECT 1 FROM coordinate_owners o JOIN players p ON p.slug=o.player_slug WHERE o.entry_id=e.id AND instr(lower(p.name),?)>0))"); values.push(q, q, q); }
  if (tag) { where.push('EXISTS(SELECT 1 FROM coordinate_tags t WHERE t.entry_id=e.id AND t.tag=?)'); values.push(tag); }
  if (dimension) { where.push("e.access='public' AND e.dimension=?"); values.push(dimension); }
  if (access) { where.push('e.access=?'); values.push(access); }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const order = params.get('sort') === 'updated' ? 'e.updated DESC,e.id' : 'e.name COLLATE NOCASE,e.id';
  const total = (await env.DB.prepare('SELECT count(*) AS n FROM coordinate_entries e' + clause).bind(...values).first()).n;
  const rows = await env.DB.prepare('SELECT e.* FROM coordinate_entries e' + clause + ` ORDER BY ${order} LIMIT 50 OFFSET ?`).bind(...values, (page - 1) * 50).all();
  const roster = await players(env);
  const tags = (await env.DB.prepare('SELECT DISTINCT tag FROM coordinate_tags ORDER BY tag').all()).results.map(row => row.tag);
  return { entries: rows.results.map(row => dto(row, roster)), total, page, pages: Math.max(1, Math.ceil(total / 50)), tags: [...new Set([...PRESET_TAGS.map(value => value.toLowerCase()), ...tags])].sort() };
}
export async function coordinateContext(request, env, fetcher) {
  if (!configured(env) || !await session(request, env)) return reply({ user: null, players: [], editableIds: [], postingPlayers: [] });
  const user = await authorize(request, env, fetcher), roster = await players(env);
  const own = roster.filter(player => user.roles.some(role => role.toLowerCase() === player.name.toLowerCase()));
  const rows = (await env.DB.prepare('SELECT id,author_id,poster_slug FROM coordinate_entries').all()).results;
  return reply({ user: { name: user.display_name, owner: user.owner, csrf: user.csrf }, players: roster.map(playerLink), postingPlayers: own.map(playerLink), editableIds: rows.filter(row => user.owner || (row.author_id === user.user_id && own.some(player => player.slug === row.poster_slug))).map(row => row.id) });
}
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new HttpError(400, `${label} must be ${required ? 'between 1 and' : 'no longer than'} ${max} characters.`);
  return value.trim();
}
function validate(body) {
  const name = text(body.name, 'Name', 80, true), notes = text(body.notes ?? '', 'Notes', 2000);
  if (!['public', 'private'].includes(body.access)) throw new HttpError(400, 'Choose Public or Private.');
  let dimension = null, x = null, y = null, z = null;
  if (body.access === 'private') {
    if (['dimension', 'x', 'y', 'z'].some(field => body[field] !== undefined && body[field] !== null && body[field] !== '')) throw new HttpError(400, 'Private entries must not include a location.');
  } else {
    dimension = body.dimension;
    if (!Object.hasOwn(DIMENSIONS, dimension)) throw new HttpError(400, 'Choose a dimension.');
    const coordinate = (value, label, optional = false) => {
      if (optional && (value === null || value === undefined || value === '')) return null;
      if (!Number.isSafeInteger(value) || Math.abs(value) > 30000000) throw new HttpError(400, `${label} must be an integer between -30,000,000 and 30,000,000.`);
      return value;
    };
    x = coordinate(body.x, 'X'); y = coordinate(body.y, 'Y', true); z = coordinate(body.z, 'Z');
  }
  if (!Array.isArray(body.tags) || !body.tags.length || body.tags.length > 8) throw new HttpError(400, 'Choose between 1 and 8 tags.');
  const tags = [...new Set(body.tags.map(tag => text(tag, 'Tag', 24, true).toLowerCase().replace(/\s+/g, ' ')))];
  if (!Array.isArray(body.owners) || body.owners.length > 30 || !body.owners.every(slug => typeof slug === 'string' && /^[a-z0-9_-]{1,50}$/.test(slug))) throw new HttpError(400, 'Choose valid owner or builder pages.');
  const imageId = body.imageId || null;
  if (imageId !== null && (typeof imageId !== 'string' || !/^[a-f0-9-]{36}$/.test(imageId))) throw new HttpError(400, 'Choose an image from the posting player’s library.');
  return { name, notes, access: body.access, dimension, x, y, z, tags, owners: [...new Set(body.owners)], imageId, imageAlt: text(body.imageAlt ?? '', 'Alt text', 300) };
}
export async function coordinateWrite(request, env, user, id, body) {
  const existing = id ? await get(env, id) : null;
  if (id && !existing) throw new HttpError(404, 'Entry not found.');
  const roster = await players(env);
  const poster = roster.find(player => player.slug === (existing?.poster_slug || body.posterSlug));
  if (!poster || !mayEdit(user, poster) || (existing && !user.owner && existing.author_id !== user.user_id)) throw new HttpError(403, 'You can only manage entries you submitted with your verified player profile.');
  if (existing && body.posterSlug !== undefined && body.posterSlug !== existing.poster_slug) throw new HttpError(400, 'The posting profile cannot be changed.');
  if (existing && (!Number.isSafeInteger(body.version) || body.version !== existing.version)) throw new HttpError(409, 'This entry changed while you were editing. Your draft is still here; reload the entry before saving.');
  if (request.method === 'DELETE') {
    const removed = await env.DB.prepare('DELETE FROM coordinate_entries WHERE id=? AND version=? RETURNING id').bind(id, body.version).first();
    if (!removed) throw new HttpError(409, 'This entry changed. Reload it before deleting.');
    return reply({ deleted: true });
  }
  if (!['POST', 'PUT'].includes(request.method) || (request.method === 'POST') === Boolean(id)) throw new HttpError(405, 'This action is not supported.');
  const data = validate(body);
  if (data.owners.some(slug => !roster.some(player => player.slug === slug))) throw new HttpError(400, 'Choose existing owner or builder pages.');
  id ||= crypto.randomUUID();
  const stamp = new Date().toISOString();
  try {
    if (existing) {
      const updated = await env.DB.prepare('UPDATE coordinate_entries SET name=?,access=?,dimension=?,x=?,y=?,z=?,notes=?,image_id=?,image_alt=?,tags_json=?,owners_json=?,version=version+1,updated=? WHERE id=? AND version=? RETURNING id')
        .bind(data.name, data.access, data.dimension, data.x, data.y, data.z, data.notes, data.imageId, data.imageAlt, JSON.stringify(data.tags), JSON.stringify(data.owners), stamp, id, body.version).first();
      if (!updated) throw new HttpError(409, 'This entry changed while you were editing. Reload it before saving.');
    } else await env.DB.prepare('INSERT INTO coordinate_entries(id,name,access,dimension,x,y,z,notes,poster_slug,author_id,image_id,image_alt,tags_json,owners_json,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, data.name, data.access, data.dimension, data.x, data.y, data.z, data.notes, poster.slug, user.user_id, data.imageId, data.imageAlt, JSON.stringify(data.tags), JSON.stringify(data.owners), stamp, stamp).run();
  } catch (error) {
    if (String(error).includes('coordinate_image_unavailable')) throw new HttpError(409, 'This image is unavailable or belongs to another player. Choose an image from the posting profile’s library.');
    throw error;
  }
  return reply(await coordinateDetail(env, id), existing ? 200 : 201);
}

export { entryHtml, listHtml } from '../shared/coordinate-render.mjs';

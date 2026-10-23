import { HttpError, configured, session, authorize, limit } from './auth.mjs';
export { commentsSection } from '../shared/comments-render.mjs';

const roster = async env => (await env.DB.prepare('SELECT slug,name FROM players ORDER BY name COLLATE NOCASE').all()).results;
const owns = (user, player) => user.roles.some(role => role.toLowerCase() === player.name.toLowerCase());
const removable = (user, row, players) => Boolean(user && (user.owner || (row.author_id === user.user_id && players.some(player => player.slug === row.poster_slug && owns(user, player)))));
async function profile(env, slug) {
  if (!await env.DB.prepare('SELECT slug FROM players WHERE slug=?').bind(slug).first()) throw new HttpError(404, 'Player not found.');
}
export async function commentList(env, slug, params = new URLSearchParams(), user = null, players = []) {
  await profile(env, slug);
  const page = Math.max(1, Math.min(100000, Number.parseInt(params.get('page') || '1', 10) || 1));
  const rows = (await env.DB.prepare('SELECT c.*,p.name AS poster_name FROM profile_comments c JOIN players p ON p.slug=c.poster_slug WHERE c.profile_slug=? ORDER BY c.created DESC,c.id DESC LIMIT 31 OFFSET ?').bind(slug, (page - 1) * 30).all()).results;
  return { page, hasMore: rows.length > 30, comments: rows.slice(0, 30).map(row => ({ id: row.id, poster: { slug: row.poster_slug, name: row.poster_name }, body: row.body, created: row.created, ...(user ? { canDelete: removable(user, row, players) } : {}) })) };
}
export async function commentContext(request, env, fetcher, slug) {
  const user = configured(env) && await session(request, env) ? await authorize(request, env, fetcher) : null;
  const players = user ? await roster(env) : [];
  return { ...await commentList(env, slug, new URL(request.url).searchParams, user, players), user: user ? { csrf: user.csrf } : null, postingPlayers: players.filter(player => owns(user, player)) };
}
export async function commentWrite(request, env, user, slug, id, body) {
  await profile(env, slug);
  const players = await roster(env);
  if (id && request.method === 'DELETE') {
    const row = await env.DB.prepare('SELECT * FROM profile_comments WHERE id=? AND profile_slug=?').bind(id, slug).first();
    if (!row) throw new HttpError(404, 'Comment not found.');
    if (!removable(user, row, players)) throw new HttpError(403, 'You can only delete your own comments.');
    await env.DB.prepare('DELETE FROM profile_comments WHERE id=? AND profile_slug=?').bind(id, slug).run();
    return { deleted: true };
  }
  if (id || request.method !== 'POST') throw new HttpError(405, 'This action is not supported.');
  const poster = players.find(player => player.slug === body.posterSlug && owns(user, player));
  if (!poster) throw new HttpError(403, 'Choose your player page with its matching Discord IGN role to comment.');
  if (typeof body.body !== 'string' || !body.body.trim() || body.body.trim().length > 2000 || body.body.includes('\0')) throw new HttpError(400, 'Comments must be between 1 and 2,000 characters and contain no null characters.');
  await limit(env, `comment:${user.user_id}`, 5, 60);
  const comment = { id: crypto.randomUUID(), poster, body: body.body.trim().replaceAll('\r\n', '\n'), created: new Date().toISOString(), canDelete: true };
  await env.DB.prepare('INSERT INTO profile_comments(id,profile_slug,poster_slug,author_id,body,created) VALUES(?,?,?,?,?,?)').bind(comment.id, slug, poster.slug, user.user_id, comment.body, comment.created).run();
  return comment;
}

import catalog from './catalog.generated.json' with { type: 'json' };
import { HttpError, configured, session, authorize, mayEdit, checkOrigin, checkCsrf, login, callback, cookie, limit } from './auth.mjs';
import { lookup, png } from './lookup.mjs';
import { escape, render, article, card, tile, playerUrl, description } from './content.mjs';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const allPlayers = async env => (await env.DB.prepare('SELECT slug,name,image,markdown,version,updated,edition,minecraft_id FROM players ORDER BY name COLLATE NOCASE').all()).results;
const getPlayer = (env, slug) => env.DB.prepare('SELECT * FROM players WHERE slug=?').bind(slug).first();
const publicPlayer = player => ({ slug: player.slug, name: player.name, image: player.image, version: player.version, updated: player.updated, edition: player.edition, url: playerUrl(player) });
async function input(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Send the form as JSON.');
  if (Number(request.headers.get('Content-Length') || 0) > 400000) throw new HttpError(413, 'The submitted page is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'The form is empty.');
  let size = 0, text = '';
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 400000) { await reader.cancel(); throw new HttpError(413, 'The submitted page is too large.'); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { const body = JSON.parse(text); if (body && !Array.isArray(body) && typeof body === 'object') return body; }
  catch { /* Return a consistent validation error. */ }
  throw new HttpError(400, 'The form could not be read.');
}
const validateMarkdown = value => {
  if (typeof value !== 'string' || value.length > 30000) throw new HttpError(400, 'Page text must be no longer than 30,000 characters.');
  return value.replaceAll('\r\n', '\n');
};
const roleName = name => name.toLowerCase();
async function update(env, user, player, changes, expected) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new HttpError(400, 'Reload the page before saving.');
  const row = await env.DB.prepare('UPDATE players SET markdown=?,name=?,edition=?,minecraft_id=?,image=?,head_png=?,version=version+1,updated=?,updated_by=? WHERE slug=? AND version=? RETURNING slug,version')
    .bind(changes.markdown ?? player.markdown, changes.name ?? player.name, changes.edition ?? player.edition, changes.minecraft_id ?? player.minecraft_id,
      changes.image ?? player.image, changes.head_png ?? player.head_png, new Date().toISOString(), user.user_id, player.slug, expected).first();
  if (!row) throw new HttpError(409, 'This page changed while you were editing. Copy your text, reload, and merge the changes.');
  return row;
}

async function api(request, env, fetcher) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === '/api/me/' && method === 'GET') {
    const current = await session(request, env);
    if (!configured(env) || !current) return json({ configured: configured(env), user: null });
    let user;
    try { user = await authorize(request, env, fetcher); }
    catch (error) {
      if (error instanceof HttpError && error.status === 403) return json({ configured: true, user: { name: current.display_name, owner: false, csrf: current.csrf, denied: true }, players: [], roles: [], error: error.message });
      throw error;
    }
    const players = await allPlayers(env);
    const showAll = new URL(request.url).searchParams.get('scope') === 'all';
    if (showAll && !user.owner) throw new HttpError(403, 'Only the owner can manage all player pages.');
    const visible = showAll ? players : players.filter(player => user.roles.some(role => role.toLowerCase() === player.name.toLowerCase()));
    return json({ configured: true, user: { name: user.display_name, owner: user.owner, csrf: user.csrf }, players: visible.map(publicPlayer), roles: user.roles });
  }
  if (path === '/api/players/' && method === 'GET') {
    const query = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    const players = await allPlayers(env);
    return json({ players: players.filter(player => !query || `${player.name} ${player.markdown}`.toLowerCase().includes(query)).map(player => ({ ...publicPlayer(player), excerpt: player.markdown.replace(/[#*_`\[\]]/g, '').replace(/\s+/g, ' ').slice(0, 180) })) });
  }
  const user = await authorize(request, env, fetcher);
  if (!['GET', 'HEAD'].includes(method)) {
    checkOrigin(request, env); checkCsrf(request, user);
    await limit(env, `write:${user.user_id}`, 30, 60);
  }
  if (path === '/api/lookup/' && method === 'POST') {
    const body = await input(request);
    // A role name must match the requested IGN before any external lookup is allowed.
    if (!user.owner && !user.roles.some(role => roleName(role) === roleName(String(body.name || '').trim()))) throw new HttpError(403, 'You need a Discord role matching this IGN.');
    await limit(env, `lookup:${user.user_id}`, 8, 60);
    return json(await lookup(body, fetcher));
  }
  if (path === '/api/players/' && method === 'POST') {
    const body = await input(request);
    if (!user.owner && !user.roles.some(role => roleName(role) === roleName(String(body.name || '').trim()))) throw new HttpError(403, 'You need a Discord role matching this IGN.');
    await limit(env, `lookup:${user.user_id}`, 8, 60);
    const profile = await lookup(body, fetcher);
    if (!mayEdit(user, profile)) throw new HttpError(403, 'You need a Discord role matching this IGN.');
    // Existing pages are matched by stable identity or case-insensitive name; never claim or duplicate them.
    const existing = await env.DB.prepare('SELECT slug FROM players WHERE minecraft_id=? OR name=? COLLATE NOCASE').bind(profile.minecraft_id, profile.name).first();
    if (existing) throw new HttpError(409, 'This player already has a page. Select it from your editable pages.');
    let slug = profile.name.toLowerCase().replaceAll(' ', '_');
    if (await getPlayer(env, slug)) slug = `${profile.edition}-${slug}`;
    try {
      await env.DB.prepare('INSERT INTO players(slug,name,edition,minecraft_id,image,head_png,markdown,updated,updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(slug, profile.name, profile.edition, profile.minecraft_id, `/player-heads/${slug}.png`, profile.head_png, '## About\n\n## Builds & projects\n', new Date().toISOString(), user.user_id).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new HttpError(409, 'This player already has a page.');
      throw error;
    }
    return json({ slug, url: `/wiki/players/${slug}/` }, 201);
  }
  if (path === '/api/preview/' && method === 'POST') {
    const body = await input(request);
    const player = await getPlayer(env, String(body.slug || ''));
    if (!player || !mayEdit(user, player)) throw new HttpError(403, 'You need a Discord role matching this page’s IGN.');
    return json({ html: render(validateMarkdown(body.markdown)).html });
  }
  const match = path.match(/^\/api\/players\/([a-z0-9_-]{1,50})\/(history\/|restore\/|identity\/|head\/)?$/);
  if (!match) throw new HttpError(404, 'Page not found.');
  const player = await getPlayer(env, match[1]);
  if (!player) throw new HttpError(404, 'Player not found.');
  if (!mayEdit(user, player)) throw new HttpError(403, 'You need a Discord role matching this page’s IGN.');
  const action = match[2] || '';
  if (!action && method === 'GET') return json({ ...publicPlayer(player), markdown: player.markdown });
  if (!action && method === 'PUT') {
    const body = await input(request);
    return json(await update(env, user, player, { markdown: validateMarkdown(body.markdown) }, body.version));
  }
  if (action === 'history/' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT id,version,author_id,created FROM revisions WHERE slug=? ORDER BY version DESC LIMIT 100').bind(player.slug).all();
    return json({ revisions: rows.results });
  }
  if (action === 'restore/' && method === 'POST') {
    const body = await input(request);
    const revision = await env.DB.prepare('SELECT markdown FROM revisions WHERE id=? AND slug=?').bind(Number(body.revision), player.slug).first();
    if (!revision) throw new HttpError(404, 'Revision not found.');
    return json(await update(env, user, player, { markdown: revision.markdown }, body.version));
  }
  if (action === 'identity/' && method === 'POST') {
    if (!user.owner) throw new HttpError(403, 'Only the owner can update player names and identities.');
    const body = await input(request);
    await limit(env, `lookup:${user.user_id}`, 8, 60);
    const profile = await lookup(body, fetcher);
    if (player.minecraft_id && player.minecraft_id !== profile.minecraft_id) throw new HttpError(400, 'This is a different Minecraft account. Create a separate player page instead.');
    if (!player.minecraft_id && player.name.toLowerCase() !== profile.name.toLowerCase()) throw new HttpError(400, 'Look up the existing player’s name to verify their account first.');
    try { return json(await update(env, user, player, { ...profile, image: `/player-heads/${player.slug}.png` }, body.version)); }
    catch (error) { if (String(error).includes('UNIQUE')) throw new HttpError(409, 'This Minecraft account already belongs to another page.'); throw error; }
  }
  if (action === 'head/' && method === 'POST') {
    if (!user.owner) throw new HttpError(403, 'Only the owner can replace player head images.');
    const body = await input(request);
    if (typeof body.png !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(body.png) || body.png.length > 350000) throw new HttpError(400, 'Choose a PNG image smaller than 256 KB.');
    const image = png(Uint8Array.from(atob(body.png), character => character.charCodeAt(0)));
    return json(await update(env, user, player, { head_png: image, image: `/player-heads/${player.slug}.png` }, body.version));
  }
  throw new HttpError(405, 'This action is not supported.');
}

async function html(request, env, template, main, title, player) {
  const base = await env.ASSETS.fetch(new Request(new URL(template, request.url), { method: 'GET' }));
  if (!base.ok) throw new HttpError(503, 'The page is temporarily unavailable.');
  const headers = new Headers(base.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('ETag'); headers.delete('Content-Length'); headers.delete('Content-Encoding');
  const response = new Response(base.body, { status: 200, headers });
  const rewrite = new HTMLRewriter().on('#main-content', { element(element) { element.setInnerContent(main, { html: true }); } })
    .on('title', { element(element) { element.setInnerContent(`${title} — mineandcraft.net`); } })
    .on('meta[property="og:title"]', { element(element) { element.setAttribute('content', `${title} — mineandcraft.net`); } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute('href', `${env.SITE_ORIGIN}${new URL(request.url).pathname}`); } })
    .on('.article-tabs .selected', { element(element) { element.setAttribute('href', new URL(request.url).pathname); } });
  if (player) rewrite.on('meta[name="description"],meta[property="og:description"]', { element(element) { element.setAttribute('content', description(player)); } })
    .on('.article-tabs a[href^="/source/"]', { element(element) { element.setAttribute('href', `/source/players/${player.slug}.txt`); } })
    .on('.article-tabs .page-actions', { element(element) { element.append(`<a href="/account/?player=${player.slug}">Edit page</a>`, { html: true }); } });
  return rewrite.transform(response);
}

async function publicPage(request, env) {
  const path = new URL(request.url).pathname;
  const source = path.match(/^\/source\/players\/([a-z0-9_-]+)\.txt$/);
  if (source) {
    const player = await getPlayer(env, source[1]);
    if (player) return new Response(`---\ntitle: "${player.name}"\ncategory: "Players"\nupdated: "${player.updated}"\n---\n${player.markdown}`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  const head = path.match(/^\/player-heads\/([a-z0-9_-]+)\.png$/);
  if (head) {
    const player = await getPlayer(env, head[1]);
    if (!player?.head_png) throw new HttpError(404, 'Image not found.');
    return new Response(Uint8Array.from(atob(player.head_png), character => character.charCodeAt(0)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' } });
  }
  const page = path.match(/^\/wiki\/players\/([a-z0-9_-]+)\/$/);
  if (page) {
    const player = await getPlayer(env, page[1]);
    if (player) return html(request, env, '/wiki/players/0480/', article(player), player.name, player);
  }
  if (['/', '/players/', '/all-pages/', '/category/players/'].includes(path)) {
    const players = await allPlayers(env);
    const staticResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(staticResponse.headers);
    headers.set('Cache-Control', 'no-store'); headers.delete('ETag'); headers.delete('Content-Length'); headers.delete('Content-Encoding');
    const response = new Response(staticResponse.body, { status: staticResponse.status, headers });
    const all = [...catalog, ...players.map(player => ({ title: player.name, description: description(player), url: playerUrl(player) }))].sort((a, b) => a.title.localeCompare(b.title));
    const rewrite = new HTMLRewriter().on('.nav-count', { element(element) { element.setInnerContent(String(all.length)); } })
      .on('.random-page', { element(element) { element.setAttribute('data-pages', JSON.stringify(all.map(item => item.url))); } });
    if (path === '/') rewrite.on('.profile-grid', { element(element) { element.setInnerContent(players.map(tile).join(''), { html: true }); } });
    if (path === '/players/') rewrite.on('.directory-grid', { element(element) { element.setInnerContent(players.map(card).join(''), { html: true }); } });
    if (path === '/all-pages/' || path === '/category/players/') {
      const entries = path === '/all-pages/' ? all : all.filter(item => item.url.startsWith('/wiki/players/'));
      rewrite.on('.alphabet-list', { element(element) { element.setInnerContent(entries.map(item => `<li><a href="${escape(item.url)}">${escape(item.title)}</a><p>${escape(item.description)}</p></li>`).join(''), { html: true }); } })
        .on('.page-heading p', { element(element) { element.setInnerContent(`${entries.length} articles${path === '/all-pages/' ? ' in the mineandcraft.net wiki.' : ' in this category.'}`); } });
    }
    return rewrite.transform(response);
  }
  return env.ASSETS.fetch(request);
}

export function createHandler(fetcher = (...args) => fetch(...args)) {
  return async (request, env) => {
    const url = new URL(request.url);
    try {
      const path = url.pathname;
      const publicApi = path === '/api/players/' && request.method === 'GET';
      if ((path.startsWith('/auth/') || (path.startsWith('/api/') && !publicApi)) && url.origin !== env.SITE_ORIGIN) throw new HttpError(403, 'Use the wiki’s main address to sign in and edit.');
      if (path === '/auth/login/' && request.method === 'GET') return await login(request, env);
      if (path === '/auth/callback/' && request.method === 'GET') return await callback(request, env, fetcher);
      if (path === '/auth/logout/' && request.method === 'POST') {
        checkOrigin(request, env);
        const user = await session(request, env);
        if (user) { checkCsrf(request, user); await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.token_hash).run(); }
        return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie(env, 'session', '', 0), 'Cache-Control': 'no-store' } });
      }
      if (path.startsWith('/api/')) return await api(request, env, fetcher);
      if (path.startsWith('/auth/')) throw new HttpError(404, 'Page not found.');
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'This action is not supported.');
      // Match the existing trailing-slash convention for database-backed pages too.
      if (/^\/wiki\/players\/[^/.]+$/.test(path)) return Response.redirect(new URL(path + '/', request.url).href, 308);
      const response = await publicPage(request, env);
      if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('Wiki request failed:', error?.name || 'Error', error?.stack?.split('\n').slice(1).join('\n') || '');
      const message = error instanceof HttpError ? error.message : 'The request could not be completed. Please try again shortly.';
      if (url.pathname.startsWith('/api/')) return json({ error: message }, status);
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>mineandcraft.net</title><p>${escape(message)}</p><p><a href="/account/">Back to the editor</a> · <a href="/">Main page</a></p></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
  };
}
export default { fetch: createHandler() };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHandler } from '../worker/index.mjs';
import { render } from '../worker/content.mjs';
import { lookup } from '../worker/lookup.mjs';
import { cleanupMedia } from '../worker/media.mjs';

const OWNER = '100000000000000001', MEMBER = '100000000000000002', OTHER = '100000000000000003';
const GUILD = '200000000000000001', APP = '300000000000000001';
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_accounts.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0002_initial_players.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0003_media.sql', 'utf8'));
  t.after(() => sqlite.close());
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    async first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    async run() { return sqlite.prepare(this.sql).run(...this.values); }
  }
  const DB = {
    prepare: sql => new Statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const env = { DB, SITE_ORIGIN: 'https://wiki.test', DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_BOT_TOKEN: 'bot-token', DISCORD_GUILD_ID: GUILD, DISCORD_OWNER_ID: OWNER, SESSION_KEY: 'a-long-test-key-that-is-not-used-in-production-1234' };
  const objects = new Map();
  env.MEDIA = {
    async put(key, value) { objects.set(key, new Uint8Array(value)); },
    async get(key) { const value = objects.get(key); return value ? { body: value, httpEtag: '"test-etag"' } : null; },
    async delete(key) { objects.delete(key); },
  };
  const memberships = new Map([[OWNER, ['role-uaiden']], [MEMBER, ['role-uaiden', 'role-notch']], [OTHER, ['role-apokefish']]]);
  let discordFailure = false, refreshed = 0;
  const mockFetch = async (address, options = {}) => {
    const url = new URL(address);
    const auth = options.headers?.Authorization;
    const id = auth?.replace('Bearer access:', '');
    if (url.hostname === 'discord.com') {
      if (discordFailure) return Response.json({}, { status: 503 });
      if (url.pathname === '/api/oauth2/token') {
        const fields = new URLSearchParams(options.body);
        const userId = fields.get('grant_type') === 'refresh_token' ? fields.get('refresh_token').slice(8) : fields.get('code');
        if (fields.get('grant_type') === 'refresh_token') refreshed++;
        assert.equal(fields.get('client_secret'), env.DISCORD_CLIENT_SECRET);
        return Response.json({ access_token: `access:${userId}`, refresh_token: `refresh:${userId}`, expires_in: 3600 });
      }
      if (url.pathname === '/api/v10/users/@me') return Response.json({ id, username: `user-${id}`, global_name: 'Player' });
      if (url.pathname === `/api/v10/users/@me/guilds/${GUILD}/member`) return memberships.has(id) ? Response.json({ roles: memberships.get(id) }) : Response.json({}, { status: 404 });
      if (url.pathname === `/api/v10/guilds/${GUILD}/roles`) {
        assert.equal(auth, 'Bot bot-token');
        return Response.json([{ id: GUILD, name: 'uaiden' }, { id: 'role-uaiden', name: 'uAiDeN' }, { id: 'role-apokefish', name: 'apokefish' }, { id: 'role-notch', name: 'Notch' }]);
      }
    }
    if (url.hostname === 'api.mojang.com') return Response.json({ name: 'Notch', id: '069a79f444e94726a5befca90e38aaf5' });
    if (url.hostname === 'mc-heads.net') return new Response(readFileSync('public/images/players/0480.png'), { headers: { 'Content-Type': 'image/png' } });
    throw new Error(`Unexpected test request: ${url.origin}${url.pathname}`);
  };
  const handle = createHandler(mockFetch);
  const request = async (path, options = {}) => handle(new Request(`${env.SITE_ORIGIN}${path}`, options), env);
  async function login(id = MEMBER) {
    const start = await request('/auth/login/');
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get('Location'));
    assert.equal(url.searchParams.get('scope'), 'identify guilds.members.read');
    assert.match(start.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure/);
    const state = url.searchParams.get('state');
    const oauthCookie = start.headers.get('Set-Cookie').split(';')[0];
    const callback = await request(`/auth/callback/?code=${id}&state=${state}`, { headers: { Cookie: oauthCookie } });
    assert.equal(callback.status, 302);
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-mac_session=')).split(';')[0];
    const meResponse = await request('/api/me/', { headers: { Cookie: cookie } });
    const me = await meResponse.json();
    assert.equal(meResponse.status, 200);
    return {
      cookie, csrf: me.user.csrf, me, state, oauthCookie,
      call(path, method = 'GET', body, overrides = {}) {
        return request(path, { method, headers: { Cookie: cookie, Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': me.user.csrf, ...overrides }, ...(body ? { body: JSON.stringify(body) } : {}) });
      },
    };
  }
  return { env, sqlite, request, login, memberships, objects, failDiscord: () => { discordFailure = true; }, refreshCount: () => refreshed };
}

test('Discord sign-in uses single-use state, secure opaque cookies, and encrypted provider credentials', async t => {
  const f = fixture(t), user = await f.login();
  assert.deepEqual(user.me.players.map(player => player.name), ['uaiden']);
  const stored = f.sqlite.prepare('SELECT * FROM sessions').get();
  assert.equal(stored.credentials.includes('access:'), false);
  assert.equal(stored.token_hash.includes(user.cookie.split('=')[1]), false);
  const replay = await f.request(`/auth/callback/?code=${MEMBER}&state=${user.state}`, { headers: { Cookie: user.oauthCookie } });
  assert.equal(replay.status, 400);
  const forged = await f.request('/auth/callback/?code=bad&state=forged');
  assert.equal(forged.status, 400);
});

test('anonymous requests cannot save, create pages, or read revision history', async t => {
  const f = fixture(t);
  for (const [path, method] of [['/api/players/uaiden/', 'PUT'], ['/api/players/', 'POST'], ['/api/players/uaiden/history/', 'GET']]) {
    const response = await f.request(path, { method }); assert.equal(response.status, 401);
  }
  const publicList = await f.request('/api/players/');
  assert.equal((await publicList.json()).players.length, 14);
});

test('IGN roles ignore capitalization but cannot edit another player or grant access through @everyone', async t => {
  const f = fixture(t), user = await f.login();
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'My build', version: 1 })).status, 200);
  assert.equal((await user.call('/api/players/apokefish/', 'PUT', { markdown: 'Changed', version: 1 })).status, 403);
  assert.equal((await user.call('/api/players/apokefish/history/')).status, 403);
  f.memberships.set(MEMBER, [GUILD]);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'Bypass', version: 2 })).status, 403);
});

test('removing a role or leaving Discord blocks the next write, even with an existing session', async t => {
  const f = fixture(t), user = await f.login();
  f.memberships.set(MEMBER, []);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'No access', version: 1 })).status, 403);
  f.memberships.delete(MEMBER);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'No membership', version: 1 })).status, 403);
  assert.equal(f.sqlite.prepare("SELECT version FROM players WHERE slug='uaiden'").get().version, 1);
});

test('Discord outages fail closed, and token refresh still checks current roles', async t => {
  const f = fixture(t), user = await f.login();
  f.sqlite.exec('UPDATE sessions SET credentials=credentials');
  const row = f.sqlite.prepare('SELECT credentials FROM sessions').get();
  const { unseal, seal } = await import('../worker/auth.mjs');
  const credentials = await unseal(row.credentials, f.env); credentials.expires = 0;
  f.sqlite.prepare('UPDATE sessions SET credentials=?').run(await seal(credentials, f.env));
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'Refreshed', version: 1 })).status, 200);
  assert.equal(f.refreshCount(), 1);
  f.failDiscord();
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'Blocked', version: 2 })).status, 503);
});

test('writes require both the exact site origin and the session CSRF token', async t => {
  const f = fixture(t), user = await f.login();
  for (const overrides of [{ Origin: 'https://evil.test' }, { 'X-CSRF-Token': 'forged' }]) {
    assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'Blocked', version: 1 }, overrides)).status, 403);
  }
});

test('the owner can edit all player pages; saves detect conflicts and preserve restorable history', async t => {
  const f = fixture(t), owner = await f.login(OWNER);
  assert.deepEqual(owner.me.players.map(player => player.name), ['uaiden']);
  const all = await (await owner.call('/api/me/?scope=all')).json();
  assert.equal(all.players.length, 14);
  const member = await f.login(MEMBER);
  assert.equal((await member.call('/api/me/?scope=all')).status, 403);
  const original = f.sqlite.prepare("SELECT markdown FROM players WHERE slug='apokefish'").get().markdown;
  assert.equal((await owner.call('/api/players/apokefish/', 'PUT', { markdown: 'First edit', version: 1 })).status, 200);
  assert.equal((await owner.call('/api/players/apokefish/', 'PUT', { markdown: 'Stale edit', version: 1 })).status, 409);
  const history = await (await owner.call('/api/players/apokefish/history/')).json();
  assert.equal(history.revisions.length, 2);
  const first = history.revisions.find(revision => revision.version === 1);
  assert.equal((await owner.call('/api/players/apokefish/restore/', 'POST', { revision: first.id, version: 2 })).status, 200);
  assert.equal(f.sqlite.prepare("SELECT markdown FROM players WHERE slug='apokefish'").get().markdown, original);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM revisions WHERE slug='apokefish'").get().n, 3);
});

test('IGN role holders can automatically create their own page with canonical name, UUID, and cached head', async t => {
  const f = fixture(t), user = await f.login();
  const identity = { name: 'notch', edition: 'java' };
  const preview = await (await user.call('/api/lookup/', 'POST', identity)).json();
  assert.equal(preview.name, 'Notch'); assert.match(preview.preview, /^data:image\/png;base64,/);
  const response = await user.call('/api/players/', 'POST', identity);
  assert.equal(response.status, 201);
  const created = f.sqlite.prepare("SELECT * FROM players WHERE slug='notch'").get();
  assert.equal(created.name, 'Notch'); assert.equal(created.minecraft_id, 'java:069a79f444e94726a5befca90e38aaf5');
  assert.equal(created.image, '/player-heads/notch.png'); assert.ok(created.head_png);
  assert.equal((await user.call('/api/players/', 'POST', identity)).status, 409);
  assert.equal((await user.call('/api/players/notch/', 'PUT', { markdown: 'New profile', version: 1 })).status, 200);
  const search = await (await f.request('/api/players/?q=New%20profile')).json();
  assert.equal(search.players[0].name, 'Notch');
  const someoneElse = await f.login(OTHER);
  assert.equal((await someoneElse.call('/api/players/', 'POST', identity)).status, 403);
});

test('members cannot change identities or heads; oversized text and body content are rejected', async t => {
  const f = fixture(t), user = await f.login();
  for (const action of ['identity', 'head']) assert.equal((await user.call(`/api/players/uaiden/${action}/`, 'POST', { version: 1 })).status, 403);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'x'.repeat(30001), version: 1 })).status, 400);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'x'.repeat(400001), version: 1 })).status, 413);
});

test('Markdown preview escapes raw HTML, rejects executable links, and produces unique heading anchors', () => {
  const result = render('## Build\n\n## Build\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![x](data:image/svg+xml,bad)');
  assert.equal(result.html.includes('<script>'), false);
  assert.equal(result.html.includes('href="javascript:'), false);
  assert.equal(result.html.includes('src="data:'), false);
  assert.deepEqual(result.headings.map(heading => heading.id), ['build', 'build-1']);
});

test('logout invalidates the stored session and missing configuration cannot enable editing', async t => {
  const f = fixture(t), user = await f.login();
  assert.equal((await user.call('/auth/logout/', 'POST')).status, 204);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'After logout', version: 1 })).status, 401);
  delete f.env.DISCORD_BOT_TOKEN;
  assert.equal((await f.request('/auth/login/')).status, 503);
  const me = await (await f.request('/api/me/')).json(); assert.equal(me.configured, false);
});

test('role-gated writes are rate limited', async t => {
  const f = fixture(t), user = await f.login();
  for (let version = 1; version <= 30; version++) assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: `Edit ${version}`, version })).status, 200);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: 'Too fast', version: 31 })).status, 429);
});

test('Bedrock lookup uses the canonical Xbox name, XUID, and a stored Geyser skin', async () => {
  const xuid = '2535451190094467';
  const fetcher = async address => {
    const url = new URL(address);
    if (url.pathname.includes('/xuid/')) return Response.json({ xuid: Number(xuid) });
    if (url.pathname.includes('/gamertag/')) return Response.json({ gamertag: 'Poke Fish' });
    if (url.pathname.includes('/skin/')) return Response.json({ texture_id: 'a-valid-texture' });
    assert.equal(url.pathname, `/head/${BigInt(xuid).toString(16).padStart(32, '0')}/256`);
    return new Response(readFileSync('public/images/players/0480.png'), { headers: { 'Content-Type': 'image/png' } });
  };
  const profile = await lookup({ edition: 'bedrock', name: 'poke fish' }, fetcher);
  assert.equal(profile.name, 'Poke Fish'); assert.equal(profile.minecraft_id, `bedrock:${xuid}`);
  await assert.rejects(lookup({ edition: 'bedrock', name: 'poke fish' }, async address => new URL(address).pathname.includes('/xuid/') ? Response.json({ xuid: Number(xuid) }) : Response.json({}, { status: 503 })), /lookup is unavailable/);
});

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
test('Java lookup falls back when Mojang blocks Cloudflare, without trusting a mismatched name or hiding not-found', async () => {
  let fallbackCalls = 0;
  const fetcher = async (address, options) => {
    const url = new URL(address);
    if (url.hostname === 'api.mojang.com') return new Response('Forbidden', { status: 403 });
    if (url.hostname === 'playerdb.co') {
      fallbackCalls++; assert.match(options.headers['User-Agent'], /mineandcraft.net/);
      return Response.json({ success: true, data: { player: { username: 'uAiden', raw_id: '78eac36d1de348e98ef0bd65d90953ef' } } });
    }
    return new Response(readFileSync('public/images/players/0480.png'), { headers: { 'Content-Type': 'image/png' } });
  };
  const profile = await lookup({ edition: 'java', name: 'uaiden' }, fetcher);
  assert.equal(profile.name, 'uAiden'); assert.equal(profile.minecraft_id, 'java:78eac36d1de348e98ef0bd65d90953ef');
  await assert.rejects(lookup({ edition: 'java', name: 'Notch' }, fetcher), /could not be verified/);
  assert.equal(fallbackCalls, 2);
  await assert.rejects(lookup({ edition: 'java', name: 'missing' }, async () => new Response(null, { status: 404 })), /Player not found/);
  await assert.rejects(lookup({ edition: 'java', name: 'missing' }, async address => new Response(null, { status: new URL(address).hostname === 'api.mojang.com' ? 403 : 400 })), /Player not found/);
});
async function upload(f, user, bytes = gif, slug = 'uaiden', headers = {}, filename = 'Build.gif') {
  const body = new FormData(); body.set('file', new File([bytes], filename, { type: 'image/gif' }));
  return f.request(`/api/players/${slug}/images/`, { method: 'POST', body, headers: { Cookie: user.cookie, Origin: f.env.SITE_ORIGIN, 'X-CSRF-Token': user.csrf, ...headers } });
}

test('GIF uploads preserve bytes, reserve quota without revisions, and serve revalidated public images', async t => {
  const f = fixture(t), user = await f.login();
  const response = await upload(f, user); assert.equal(response.status, 201);
  const { image, usage } = await response.json();
  assert.equal(image.type, 'image/gif'); assert.equal(usage.used, gif.length);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM revisions WHERE slug='uaiden'").get().n, 1);
  const list = await (await user.call('/api/players/uaiden/images/')).json();
  assert.equal(list.images.length, 1); assert.equal(list.images[0].name, 'Build.gif');
  const publicFile = await f.request(image.url);
  assert.equal(publicFile.status, 200); assert.equal(publicFile.headers.get('Content-Type'), 'image/gif');
  assert.equal(publicFile.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(publicFile.headers.get('Cache-Control'), /must-revalidate/);
  assert.deepEqual(Buffer.from(await publicFile.arrayBuffer()), gif);
  assert.equal((await f.request(image.url, { headers: { 'If-None-Match': '"test-etag"' } })).status, 304);
});

test('unchanged Markdown does not create a revision and still detects an outdated version', async t => {
  const f = fixture(t), user = await f.login();
  const player = await (await user.call('/api/players/uaiden/')).json();
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: player.markdown, version: player.version })).status, 200);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM revisions WHERE slug='uaiden'").get().n, 1);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: player.markdown, version: player.version + 1 })).status, 409);
});

test('media permissions use fresh roles, owner scope, and CSRF on uploads and deletes', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER), owner = await f.login(OWNER);
  assert.equal((await f.request('/api/players/uaiden/images/')).status, 401);
  assert.equal((await upload(f, other)).status, 403);
  assert.equal((await other.call('/api/players/uaiden/images/')).status, 403);
  assert.equal((await upload(f, user, gif, 'uaiden', { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await upload(f, user, gif, 'uaiden', { Origin: 'https://attacker.test' })).status, 403);
  const image = (await (await upload(f, user)).json()).image;
  assert.equal((await other.call(`/api/players/apokefish/images/${image.id}/`, 'DELETE')).status, 404);
  assert.equal((await other.call(`/api/players/uaiden/images/${image.id}/`, 'DELETE')).status, 403);
  f.memberships.set(MEMBER, []);
  assert.equal((await upload(f, user)).status, 403);
  assert.equal((await user.call('/api/players/uaiden/images/')).status, 403);
  assert.equal((await owner.call('/api/players/uaiden/images/')).status, 200);
  assert.equal((await owner.call(`/api/players/uaiden/images/${image.id}/`, 'DELETE')).status, 200);
});

test('images reject spoofed raster content and oversized bodies before allocating storage', async t => {
  const f = fixture(t), user = await f.login();
  assert.equal((await upload(f, user, Buffer.from('<svg onload="alert(1)"></svg>'))).status, 415);
  assert.equal((await upload(f, user, Buffer.from('<html>bad</html>'))).status, 415);
  assert.equal((await upload(f, user, Buffer.alloc(5242881))).status, 413);
  assert.equal((await upload(f, user, gif, 'uaiden', { 'Content-Length': '99999999' })).status, 413);
  assert.equal(f.objects.size, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM media').get().n, 0);
});

test('concurrent reservations cannot exceed quota, failed uploads release it, and pending objects are swept', async t => {
  const f = fixture(t), user = await f.login();
  for (let i = 0; i < 10; i++) f.sqlite.prepare("INSERT INTO media VALUES(?, 'uaiden', 'existing.png','image/png',?, 'ready',?, 'test')").run(`seed-${i}`, i === 9 ? 5242880 - gif.length : 5242880, Date.now());
  const results = await Promise.all([upload(f, user), upload(f, user)]);
  assert.deepEqual(results.map(response => response.status).sort(), [201, 413]);
  assert.equal(f.sqlite.prepare("SELECT bytes FROM media_usage WHERE slug='uaiden'").get().bytes, 52428800);
  const other = await f.login(OTHER);
  const originalPut = f.env.MEDIA.put;
  f.env.MEDIA.put = async () => { throw new Error('R2 unavailable'); };
  assert.equal((await upload(f, other, gif, 'apokefish')).status, 503);
  assert.equal(f.sqlite.prepare("SELECT bytes FROM media_usage WHERE slug='apokefish'").get().bytes, 0);
  f.env.MEDIA.put = originalPut;
  f.sqlite.prepare("INSERT INTO media VALUES('abandoned','apokefish','pending.gif','image/gif',40,'pending',?, 'test')").run(Date.now() - 7200000);
  f.objects.set('apokefish/abandoned', gif);
  await cleanupMedia(f.env);
  assert.equal(f.objects.has('apokefish/abandoned'), false);
  assert.equal(f.sqlite.prepare("SELECT bytes FROM media_usage WHERE slug='apokefish'").get().bytes, 0);
});

test('deleting checks every current page atomically, permits historical-only deletion, and prevents new references', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const { image } = await (await upload(f, user)).json();
  const content = `![Build](${image.url.replaceAll('/', '\\/')})`;
  assert.equal((await owner.call('/api/players/apokefish/', 'PUT', { markdown: content, version: 1 })).status, 200);
  assert.equal((await user.call(`/api/players/uaiden/images/${image.id}/`, 'DELETE')).status, 409);
  assert.equal((await owner.call('/api/players/apokefish/', 'PUT', { markdown: 'Removed', version: 2 })).status, 200);
  assert.equal((await user.call(`/api/players/uaiden/images/${image.id}/`, 'DELETE')).status, 200);
  assert.equal((await f.request(image.url, { headers: { 'If-None-Match': '"test-etag"' } })).status, 404);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: content, version: 1 })).status, 409);
  assert.equal(f.objects.size, 0);
  const next = (await (await upload(f, user)).json()).image;
  f.sqlite.prepare("UPDATE media SET state='deleting' WHERE id=?").run(next.id);
  assert.equal((await user.call('/api/players/uaiden/', 'PUT', { markdown: `![race](${next.url})`, version: 1 })).status, 409);
});

test('video embeds accept only provider URLs and raw iframes remain escaped', () => {
  const result = render('[Video](https://youtu.be/dQw4w9WgXcQ)\n\n[Video](https://vimeo.com/76979871)\n\n[Video](https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ)\n\n<iframe src="https://evil.test"></iframe>');
  assert.equal((result.html.match(/<iframe /g) || []).length, 2);
  assert.match(result.html, /src="https:\/\/www.youtube-nocookie.com\/embed\/dQw4w9WgXcQ"/);
  assert.match(result.html, /src="https:\/\/player.vimeo.com\/video\/76979871"/);
  assert.doesNotMatch(result.html, /<iframe src="https:\/\/evil/);
});

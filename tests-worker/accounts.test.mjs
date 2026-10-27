import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHandler } from '../worker/index.mjs';
import { article, render } from '../worker/content.mjs';
import { lookup } from '../worker/lookup.mjs';
import { cleanupMedia } from '../worker/media.mjs';
import { commentsSection } from '../worker/comments.mjs';
import { musicSource, audioType } from '../shared/music.mjs';
import { musicListHtml, musicFilterOptionsHtml, musicPaginationHtml } from '../shared/music-render.mjs';
import { cleanupMusic } from '../worker/music.mjs';
import { cleanupMapart } from '../worker/mapart.mjs';
import { mapartFields, mapartLayout } from '../shared/mapart.mjs';

const OWNER = '100000000000000001', MEMBER = '100000000000000002', OTHER = '100000000000000003';
const GUILD = '200000000000000001', APP = '300000000000000001';
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_accounts.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0002_initial_players.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0003_media.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0004_coordinates.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0005_comments.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0006_music.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0007_music_matching.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0008_mapart.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0009_server_status.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0010_music_covers.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0011_mapart_storage.sql', 'utf8'));
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
  const env = { DB, SITE_ORIGIN: 'https://wiki.test', DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_BOT_TOKEN: 'bot-token', DISCORD_GUILD_ID: GUILD, DISCORD_OWNER_ID: OWNER, DISCORD_OWNER_IDS: '', SESSION_KEY: 'a-long-test-key-that-is-not-used-in-production-1234' };
  const objects = new Map();
  env.MEDIA = {
    async head(key) { const value = objects.get(key); return value ? { size: value.byteLength } : null; },
    async put(key, value) { objects.set(key, new Uint8Array(value)); },
    async get(key, options) { const value = objects.get(key), range = options?.range; return value ? { body: range ? value.slice(range.offset, range.offset + range.length) : value, size: value.length, httpEtag: '"test-etag"' } : null; },
    async delete(key) { objects.delete(key); },
  };
  const memberships = new Map([[OWNER, ['role-uaiden']], [MEMBER, ['role-uaiden', 'role-notch']], [OTHER, ['role-apokefish']]]);
  const discordResponses = new Map(), discordCalls = [], spotifyResponses = new Map(), spotifyCalls = [], youtubeResponses = new Map(), youtubeCalls = [];
  let discordFailure = false, refreshed = 0;
  const mockFetch = async (address, options = {}) => {
    const url = new URL(address);
    const auth = options.headers?.Authorization;
    if (url.hostname === 'www.youtube.com') {
      youtubeCalls.push({ url, options });
      const respond = youtubeResponses.get(url.pathname);
      if (respond) return respond(url, options);
      throw new Error('Unexpected YouTube request');
    }
    if (url.hostname === 'open.spotify.com') {
      spotifyCalls.push({ url, options });
      const respond = spotifyResponses.get(url.pathname);
      if (respond) return respond(url, options);
      throw new Error('Unexpected Spotify track');
    }
    const id = auth?.replace('Bearer access:', '');
    if (url.hostname === 'discord.com') {
      const endpoint = url.pathname.endsWith('/token') ? 'token' : url.pathname.endsWith('/roles') ? 'roles' : url.pathname.includes('/members/') ? 'member' : 'identity';
      discordCalls.push(endpoint);
      if (discordResponses.has(endpoint)) return discordResponses.get(endpoint)(url, options);
      if (discordFailure) return Response.json({}, { status: 503 });
      if (url.pathname === '/api/oauth2/token') {
        const fields = new URLSearchParams(options.body);
        const userId = fields.get('grant_type') === 'refresh_token' ? fields.get('refresh_token').slice(8) : fields.get('code');
        if (fields.get('grant_type') === 'refresh_token') refreshed++;
        assert.equal(fields.get('client_secret'), env.DISCORD_CLIENT_SECRET);
        return Response.json({ access_token: `access:${userId}`, refresh_token: `refresh:${userId}`, expires_in: 3600 });
      }
      if (url.pathname === '/api/v10/users/@me') return Response.json({ id, username: `user-${id}`, global_name: 'Player' });
      if (url.pathname.startsWith(`/api/v10/guilds/${GUILD}/members/`)) {
        assert.equal(auth, 'Bot bot-token');
        const memberId = url.pathname.split('/').at(-1);
        return memberships.has(memberId) ? Response.json({ user: { id: memberId }, roles: memberships.get(memberId) }) : Response.json({ code: 10007 }, { status: 404 });
      }
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
  return { env, sqlite, request, login, memberships, objects, discordResponses, discordCalls, spotifyResponses, spotifyCalls, youtubeResponses, youtubeCalls, failDiscord: () => { discordFailure = true; }, refreshCount: () => refreshed };
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

test('additional owners retain full permissions alongside the primary owner and require current membership', async t => {
  const f = fixture(t), additionalId = '733429219090104340';
  f.env.DISCORD_OWNER_IDS = ` ${OTHER}, ${additionalId} `;
  f.memberships.set(additionalId, []);
  for (const id of [OWNER, OTHER, additionalId]) {
    const owner = await f.login(id);
    assert.equal(owner.me.user.owner, true);
    const all = await (await owner.call('/api/me/?scope=all')).json();
    assert.equal(all.players.length, 14);
  }
  const member = await f.login(MEMBER);
  assert.equal(member.me.user.owner, false);
  const additional = await f.login(additionalId);
  assert.equal((await additional.call('/api/players/apokefish/', 'PUT', { markdown: 'Additional owner edit', version: 1 })).status, 200);
  f.env.DISCORD_OWNER_IDS = `9${additionalId}`;
  assert.equal((await additional.call('/api/players/apokefish/', 'PUT', { markdown: 'Removed owner', version: 2 })).status, 403);
  f.env.DISCORD_OWNER_IDS = additionalId;
  f.memberships.delete(additionalId);
  assert.equal((await additional.call('/api/players/apokefish/', 'PUT', { markdown: 'No membership', version: 2 })).status, 403);
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

test('contents labels decode entities and remove Markdown formatting while preserving existing anchors', () => {
  const result = render('## Builds &amp; projects\n\n## Builds &amp; projects\n\n## **Builds** & projects\n\n## [Farms](https://example.com) and `bases`\n\n## ![Our *base*](/base.png) &#38; builds');
  assert.deepEqual(result.headings, [
    { id: 'builds-amp-projects', text: 'Builds & projects' },
    { id: 'builds-amp-projects-1', text: 'Builds & projects' },
    { id: 'builds-projects', text: 'Builds & projects' },
    { id: 'farmshttpsexamplecom-and-bases', text: 'Farms and bases' },
    { id: 'our-basebasepng-38-builds', text: 'Our base & builds' },
  ]);
  for (const heading of result.headings) assert.ok(result.html.includes(`id="${heading.id}"`));
});

test('article contents escape decoded labels once and preserve intentionally literal entities', () => {
  const html = article({ name: 'Player', image: '/head.png', updated: '2026-10-23', markdown: '## Builds &amp; projects\n\n## Literal &amp;amp;\n\n## &lt;img src=x onerror=alert(1)&gt;' });
  assert.ok(html.includes('<a href="#builds-amp-projects">Builds &amp; projects</a>'));
  assert.ok(html.includes('>Literal &amp;amp;</a>'));
  assert.ok(html.includes('>&lt;img src=x onerror=alert(1)&gt;</a>'));
  assert.equal(html.includes('<img src=x'), false);
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

test('repeated editor actions use fresh bot membership checks without spending the OAuth membership quota', async t => {
  const f = fixture(t), user = await f.login();
  const before = f.discordCalls.filter(value => value === 'member').length;
  for (let i = 0; i < 12; i++) {
    const path = ['/api/players/uaiden/', '/api/players/uaiden/history/', '/api/players/uaiden/images/'][i % 3];
    assert.equal((await user.call(path)).status, 200);
  }
  assert.equal(f.discordCalls.filter(value => value === 'member').length - before, 12);
  f.memberships.set(MEMBER, []);
  assert.equal((await upload(f, user)).status, 403);
  assert.equal(f.objects.size, 0);
});

test('short Discord throttles retry the read once; long throttles return timing and leave uploads untouched', async t => {
  const f = fixture(t), user = await f.login();
  let attempts = 0;
  f.discordResponses.set('member', () => ++attempts === 1 ? Response.json({ retry_after: 0.001 }, { status: 429, headers: { 'Retry-After': '0.001' } }) : Response.json({ user: { id: MEMBER }, roles: ['role-uaiden'] }));
  assert.equal((await user.call('/api/players/uaiden/')).status, 200);
  assert.equal(attempts, 2);
  attempts = 0;
  f.discordResponses.set('member', () => { attempts++; return Response.json({ retry_after: 257.1 }, { status: 429 }); });
  const limited = await upload(f, user);
  assert.equal(limited.status, 503); assert.equal(limited.headers.get('Retry-After'), '258');
  assert.equal((await limited.json()).code, 'DISCORD_RATE_LIMITED');
  assert.equal(attempts, 1); assert.equal(f.objects.size, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM media').get().n, 0);
  f.discordResponses.clear();
  assert.equal((await upload(f, user)).status, 201);
  assert.equal(f.objects.size, 1);
});

test('Discord retries are bounded, report bot configuration separately, and reject malformed membership', async t => {
  const f = fixture(t), user = await f.login();
  let attempts = 0;
  f.discordResponses.set('member', () => { attempts++; return Response.json({ retry_after: 0 }, { status: 429 }); });
  const throttled = await user.call('/api/players/uaiden/');
  assert.equal(throttled.status, 503); assert.equal(attempts, 2);
  for (const status of [401, 403, 404]) {
    f.discordResponses.set('member', () => Response.json({ code: 10004 }, { status }));
    const denied = await user.call('/api/players/uaiden/');
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).code, 'DISCORD_BOT_CONFIGURATION');
  }
  f.discordResponses.set('member', () => Response.json({ user: { id: OTHER }, roles: ['role-uaiden'] }));
  const mismatched = await user.call('/api/players/uaiden/');
  assert.equal(mismatched.status, 503); assert.equal((await mismatched.json()).code, 'DISCORD_UNAVAILABLE');
  f.discordResponses.clear();
  f.discordResponses.set('roles', () => Response.json({}, { status: 403 }));
  const roles = await user.call('/api/players/uaiden/');
  assert.equal((await roles.json()).code, 'DISCORD_BOT_CONFIGURATION');
});

test('expired sessions and revoked refresh credentials require sign-in instead of reporting a role failure', async t => {
  const f = fixture(t), user = await f.login();
  const { seal, unseal } = await import('../worker/auth.mjs');
  const credentials = await unseal(f.sqlite.prepare('SELECT credentials FROM sessions').get().credentials, f.env);
  credentials.expires = 0;
  f.sqlite.prepare('UPDATE sessions SET credentials=?').run(await seal(credentials, f.env));
  let attempts = 0;
  f.discordResponses.set('token', () => { attempts++; return Response.json({}, { status: 400 }); });
  const expired = await user.call('/api/players/uaiden/');
  assert.equal(expired.status, 401); assert.equal((await expired.json()).code, 'SIGN_IN_REQUIRED'); assert.equal(attempts, 1);
  attempts = 0;
  f.discordResponses.set('token', () => { attempts++; return Response.json({ retry_after: 0 }, { status: 429 }); });
  assert.equal((await user.call('/api/players/uaiden/')).status, 503); assert.equal(attempts, 1);
  f.env.SESSION_KEY = 'changed-test-key-that-cannot-decrypt-an-existing-session';
  assert.equal((await user.call('/api/players/uaiden/')).status, 401);
  f.sqlite.prepare('UPDATE sessions SET expires=0').run();
  assert.equal((await upload(f, user)).status, 401);
  assert.equal(f.objects.size, 0);
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

const entryData = (extra = {}) => ({ name: 'Iron farm', access: 'public', dimension: 'overworld', x: -120, y: 80, z: 450, notes: 'Use the collection chest.', tags: ['Farm', 'IRON', 'iron'], owners: ['apokefish'], posterSlug: 'uaiden', imageId: null, imageAlt: '', ...extra });
test('verified players publish searchable coordinates and attribution without exposing Discord IDs', async t => {
  const f = fixture(t), user = await f.login();
  assert.equal((await f.request('/api/coordinates/', { method: 'POST' })).status, 401);
  const response = await user.call('/api/coordinates/', 'POST', entryData()); assert.equal(response.status, 201);
  const entry = await response.json();
  assert.deepEqual(entry.tags, ['farm', 'iron']); assert.equal(entry.owners[0].name, 'apokefish'); assert.equal(entry.poster.name, 'uaiden');
  assert.equal(JSON.stringify(entry).includes(MEMBER), false); assert.equal(entry.author_id, undefined);
  assert.equal((await f.request(`/api/coordinates/${entry.id}/`)).status, 200);
  for (const query of ['q=IRON', 'q=apokefish', 'tag=farm', 'dimension=overworld', 'access=public', 'sort=updated']) {
    const result = await (await f.request('/api/coordinates/?' + query)).json(); assert.equal(result.total, 1);
  }
  assert.equal((await (await f.request('/api/coordinates/?dimension=nether')).json()).total, 0);
  assert.equal((await (await f.request('/api/coordinates/?tag=%27%20OR%201%3D1--')).json()).total, 0);
  const context = await (await user.call('/api/coordinates/context/')).json();
  assert.deepEqual(context.editableIds, [entry.id]); assert.equal(context.postingPlayers[0].slug, 'uaiden');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM coordinate_tags').get().n, 2);
});

test('private entries never store location values, and making a public entry private clears them atomically', async t => {
  const f = fixture(t), user = await f.login();
  assert.equal((await user.call('/api/coordinates/', 'POST', entryData({ access: 'private' }))).status, 400);
  const body = entryData({ access: 'private' }); for (const key of ['dimension', 'x', 'y', 'z']) delete body[key];
  const privateEntry = await (await user.call('/api/coordinates/', 'POST', body)).json();
  for (const key of ['dimension', 'x', 'y', 'z']) assert.equal(Object.hasOwn(privateEntry, key), false);
  const saved = f.sqlite.prepare('SELECT dimension,x,y,z FROM coordinate_entries WHERE id=?').get(privateEntry.id);
  assert.ok(Object.values(saved).every(value => value === null));
  const pub = await (await user.call('/api/coordinates/', 'POST', entryData({ name: 'Changing base', x: 18765432, z: -19876543 }))).json();
  const updated = await user.call(`/api/coordinates/${pub.id}/`, 'PUT', { ...body, version: 1, tags: ['base'], owners: [] }); assert.equal(updated.status, 200);
  const record = f.sqlite.prepare('SELECT dimension,x,y,z FROM coordinate_entries WHERE id=?').get(pub.id);
  assert.ok(Object.values(record).every(value => value === null));
  const list = await (await f.request('/api/coordinates/?access=private')).json();
  assert.equal(JSON.stringify(list).includes('18765432'), false);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM coordinate_tags WHERE entry_id=?').get(pub.id).n, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM coordinate_owners WHERE entry_id=?').get(pub.id).n, 0);
});

test('entry edits require the original submitter and current IGN role, with owner override and version conflicts', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER), owner = await f.login(OWNER);
  const entry = await (await user.call('/api/coordinates/', 'POST', entryData())).json();
  assert.equal((await other.call(`/api/coordinates/${entry.id}/`, 'PUT', { ...entryData(), version: 1 })).status, 403);
  f.memberships.set(OTHER, ['role-uaiden']);
  assert.equal((await other.call(`/api/coordinates/${entry.id}/`, 'DELETE', { version: 1 })).status, 403);
  assert.deepEqual((await (await other.call('/api/coordinates/context/')).json()).editableIds, []);
  assert.equal((await user.call(`/api/coordinates/${entry.id}/`, 'PUT', { ...entryData({ notes: 'New notes' }), version: 1 })).status, 200);
  assert.equal((await user.call(`/api/coordinates/${entry.id}/`, 'PUT', { ...entryData({ tags: ['stale'] }), version: 1 })).status, 409);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM coordinate_tags WHERE tag='stale'").get().n, 0);
  f.memberships.set(MEMBER, []);
  assert.equal((await user.call(`/api/coordinates/${entry.id}/`, 'PUT', { ...entryData(), version: 2 })).status, 403);
  assert.equal((await owner.call(`/api/coordinates/${entry.id}/`, 'PUT', { ...entryData({ posterSlug: 'apokefish' }), version: 2 })).status, 400);
  assert.equal((await owner.call(`/api/coordinates/${entry.id}/`, 'DELETE', { version: 1 })).status, 409);
  assert.equal((await owner.call(`/api/coordinates/${entry.id}/`, 'DELETE', { version: 2 })).status, 200);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM coordinate_tags').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM coordinate_owners').get().n, 0);
  assert.equal((await f.request(`/api/coordinates/${entry.id}/`)).status, 404);
});

test('coordinate attachments share the posting profile quota and interlock atomically with file deletion', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER);
  const { image } = await (await upload(f, user)).json();
  const { image: foreign } = await (await upload(f, other, gif, 'apokefish')).json();
  assert.equal((await user.call('/api/coordinates/', 'POST', entryData({ imageId: foreign.id }))).status, 409);
  const response = await user.call('/api/coordinates/', 'POST', entryData({ imageId: image.id, imageAlt: 'The farm' })); assert.equal(response.status, 201);
  const entry = await response.json(); assert.equal(entry.image.url, image.url);
  assert.equal(f.sqlite.prepare("SELECT bytes FROM media_usage WHERE slug='uaiden'").get().bytes, gif.length);
  assert.equal((await user.call(`/api/players/uaiden/images/${image.id}/`, 'DELETE')).status, 409);
  const privateBody = entryData({ access: 'private', imageId: image.id, version: 1 }); for (const field of ['dimension', 'x', 'y', 'z']) delete privateBody[field];
  assert.equal((await user.call(`/api/coordinates/${entry.id}/`, 'PUT', privateBody)).status, 200);
  assert.equal((await user.call(`/api/players/uaiden/images/${image.id}/`, 'DELETE')).status, 409);
  assert.equal((await user.call(`/api/coordinates/${entry.id}/`, 'DELETE', { version: 2 })).status, 200);
  assert.equal(f.objects.has(`uaiden/${image.id}`), true);
  assert.equal((await user.call(`/api/players/uaiden/images/${image.id}/`, 'DELETE')).status, 200);
  assert.equal((await user.call('/api/coordinates/', 'POST', entryData({ imageId: image.id }))).status, 409);
});

test('coordinate validation and mutations enforce shape, CSRF, and guild membership', async t => {
  const f = fixture(t), user = await f.login();
  for (const extra of [{ name: '' }, { tags: [] }, { tags: ['x'.repeat(25)] }, { x: 0.5 }, { z: null }, { dimension: 'other' }, { owners: ['unknown'] }]) assert.equal((await user.call('/api/coordinates/', 'POST', entryData(extra))).status, 400);
  assert.equal((await user.call('/api/coordinates/', 'POST', entryData(), { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await user.call('/api/coordinates/', 'POST', entryData(), { Origin: 'https://evil.test' })).status, 403);
  f.memberships.delete(MEMBER);
  assert.equal((await user.call('/api/coordinates/', 'POST', entryData())).status, 403);
});

test('coordinate login return paths are allowlisted and tied to single-use OAuth state', async t => {
  const f = fixture(t);
  for (const [destination, expected] of [['/coordinates/', '/coordinates/'], ['/music/', '/music/'], ['/music/create/', '/music/create/'], ['/mapart/', '/mapart/'], ['/mapart/create/', '/mapart/create/'], ['/wiki/players/jobansz/', '/wiki/players/jobansz/'], ['/wiki/players/../account/', '/account/'], ['/wiki/players/%2f%2fevil.test/', '/account/'], ['https://evil.test', '/account/'], ['//evil.test', '/account/']]) {
    const start = await f.request('/auth/login/?returnTo=' + encodeURIComponent(destination));
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    const cookie = start.headers.get('Set-Cookie').split(';')[0];
    const callback = await f.request(`/auth/callback/?code=${MEMBER}&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(callback.headers.get('Location'), f.env.SITE_ORIGIN + expected);
  }
});

test('verified players comment on any profile with public IGN attribution and private Discord IDs', async t => {
  const f = fixture(t), user = await f.login();
  const version = f.sqlite.prepare("SELECT version FROM players WHERE slug='apokefish'").get().version;
  const response = await user.call('/api/players/apokefish/comments/', 'POST', { posterSlug: 'uaiden', body: 'Nice base!\nSee you there.' });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.poster.name, 'uaiden'); assert.equal(created.canDelete, true);
  assert.equal(created.poster.image, '/images/players/uaiden.png');
  const publicResponse = await f.request('/api/players/apokefish/comments/');
  const list = await publicResponse.json();
  assert.equal(publicResponse.status, 200); assert.equal(list.comments[0].body, 'Nice base!\nSee you there.');
  assert.equal(list.comments[0].poster.image, created.poster.image);
  assert.equal(JSON.stringify(list).includes(MEMBER), false); assert.equal(Object.hasOwn(list.comments[0], 'canDelete'), false);
  const context = await (await user.call('/api/players/apokefish/comments/context/')).json();
  assert.deepEqual(context.postingPlayers.map(player => player.slug), ['uaiden']);
  assert.equal(context.comments[0].canDelete, true);
  assert.equal(f.sqlite.prepare("SELECT version FROM players WHERE slug='apokefish'").get().version, version);
  assert.equal((await f.request('/api/players/uaiden/comments/')).status, 200);
  assert.equal((await f.request('/api/players/missing/comments/')).status, 404);
  assert.equal((await user.call('/api/players/missing/comments/', 'POST', { posterSlug: 'uaiden', body: 'Test' })).status, 404);
});

test('comment posting denies anonymous users, forged identities, missing roles, CSRF, and invalid text', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const path = '/api/players/apokefish/comments/', body = { posterSlug: 'uaiden', body: 'Hello' };
  assert.equal((await f.request(path, { method: 'POST' })).status, 401);
  assert.equal((await user.call(path, 'POST', { ...body, posterSlug: 'apokefish' })).status, 403);
  assert.equal((await owner.call(path, 'POST', { ...body, posterSlug: 'apokefish' })).status, 403);
  for (const invalid of ['', '  \n ', 'x'.repeat(2001), '\0bad', 42]) assert.equal((await user.call(path, 'POST', { ...body, body: invalid })).status, 400);
  assert.equal((await user.call(path, 'POST', body, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await user.call(path, 'POST', body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await user.call(path, 'PUT', body)).status, 405);
  f.memberships.set(MEMBER, []);
  assert.equal((await user.call(path, 'POST', body)).status, 403);
  f.memberships.delete(MEMBER);
  assert.equal((await user.call(path, 'POST', body)).status, 403);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM profile_comments').get().n, 0);
});

test('comment deletion checks both the author account and current role, with owner moderation', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER), owner = await f.login(OWNER);
  const path = '/api/players/apokefish/comments/';
  const comment = await (await user.call(path, 'POST', { posterSlug: 'uaiden', body: 'Test' })).json();
  const deletion = `${path}${comment.id}/`;
  assert.equal((await other.call(deletion, 'DELETE')).status, 403);
  f.memberships.set(OTHER, ['role-uaiden']);
  assert.equal((await other.call(deletion, 'DELETE')).status, 403);
  assert.equal((await user.call(`/api/players/uaiden/comments/${comment.id}/`, 'DELETE')).status, 404);
  f.memberships.set(MEMBER, []);
  assert.equal((await user.call(deletion, 'DELETE')).status, 403);
  assert.equal((await owner.call(deletion, 'DELETE')).status, 200);
  assert.equal((await owner.call(deletion, 'DELETE')).status, 404);
  f.memberships.set(MEMBER, ['role-uaiden']);
  const own = await (await user.call(path, 'POST', { posterSlug: 'uaiden', body: 'Another' })).json();
  assert.equal((await user.call(`${path}${own.id}/`, 'DELETE')).status, 200);
});

test('comment limits and pagination bound public responses, with HTML escaped as plain text', async t => {
  const f = fixture(t), user = await f.login(), path = '/api/players/apokefish/comments/';
  const body = '<script>alert(1)</script> **plain** & text';
  for (let i = 0; i < 5; i++) assert.equal((await user.call(path, 'POST', { posterSlug: 'uaiden', body })).status, 201);
  assert.equal((await user.call(path, 'POST', { posterSlug: 'uaiden', body: 'Too many' })).status, 429);
  for (let i = 0; i < 30; i++) f.sqlite.prepare('INSERT INTO profile_comments(id,profile_slug,poster_slug,author_id,body,created) VALUES(?,?,?,?,?,?)').run(`seed-${i}`, 'apokefish', 'uaiden', MEMBER, `Seed ${i}`, '2020-01-01');
  const first = await (await f.request(path)).json(), second = await (await f.request(path + '?page=2')).json();
  assert.equal(first.comments.length, 30); assert.equal(first.hasMore, true);
  assert.equal(second.comments.length, 5); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.comments, ...second.comments].map(comment => comment.id)).size, 35);
  const html = commentsSection('apokefish', first);
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; **plain** &amp; text'));
  assert.equal(html.includes('class="delete-comment"'), false);
});

const trackData = (extra = {}) => ({ id: crypto.randomUUID(), title: 'My song', artist: 'A player', posterSlug: 'uaiden', sourceUrl: '', ...extra });
test('public music search covers all pages, title, artist and player with literal matching', async t => {
  const f = fixture(t);
  const insert = f.sqlite.prepare("INSERT INTO music_submissions(id,poster_slug,author_id,title,artist,source_kind,source_url,status,created,updated) VALUES(?,?,?,?,?,'youtube','https://www.youtube.com/watch?v=dQw4w9WgXcQ',?,?,?)");
  for (let i = 0; i < 34; i++) insert.run(crypto.randomUUID(), i === 31 ? 'apokefish' : 'uaiden', i < 20 ? MEMBER : OTHER, i === 0 ? 'Needle 100%_song' : `Song ${i}`, i === 0 ? 'Hidden Artist' : i === 33 ? 'Private artist' : 'Band', i < 32 ? 'approved' : 'pending', String(i).padStart(3, '0'), 'now');
  const list = async query => (await f.request('/api/music/?' + new URLSearchParams(query))).json();
  assert.equal((await list({})).tracks.length, 30);
  assert.equal((await list({ page: '2' })).tracks.length, 2);
  for (const q of ['NEEDLE', 'hidden artist', '%_']) {
    const result = await list({ q, page: '9' });
    assert.equal(result.total, 1); assert.equal(result.page, 1); assert.equal(result.tracks[0].title, 'Needle 100%_song');
    assert.equal(result.tracks[0].playbackUrl, undefined);
  }
  assert.equal((await list({ q: 'UAIDEN' })).total, 31);
  assert.equal((await list({ q: "' OR 1=1 --" })).total, 0);
  assert.equal((await list({ q: 'Song 33' })).total, 0);
  const filtered = await list({ q: 'song', artist: 'Band', uploader: 'uaiden', page: '2' });
  assert.equal(filtered.total, 30); assert.equal(filtered.page, 1);
  assert.ok(filtered.tracks.every(track => track.artist === 'Band' && track.poster.slug === 'uaiden'));
  assert.deepEqual(filtered.artists, ['Band', 'Hidden Artist']);
  assert.deepEqual(filtered.uploaders.map(player => player.slug), ['apokefish', 'uaiden']);
  const second = await list({ artist: 'Band', page: '2' });
  assert.equal(second.total, 31); assert.equal(second.tracks.length, 1);
  const empty = await list({ artist: 'Hidden Artist', uploader: 'apokefish' });
  assert.equal(empty.total, 0); assert.deepEqual(empty.artists, filtered.artists);
  assert.match(musicListHtml(empty), /No songs match your search or filters/);
  assert.equal((await list({ artist: 'Hidden' })).total, 0);
  assert.equal((await list({ uploader: "' OR 1=1 --" })).total, 0);
  const unsafe = await list({ artist: '<script>"&', uploader: 'apokefish' });
  assert.match(musicFilterOptionsHtml(unsafe, 'artist'), /&lt;script&gt;&quot;&amp;/);
  assert.match(musicFilterOptionsHtml(empty, 'artist'), /value="Hidden Artist" selected/);
  const links = musicPaginationHtml({ ...filtered, pages: 2 });
  assert.match(links, /q=song&amp;artist=Band&amp;uploader=uaiden&amp;page=2/);
});

test('artist filters split collaboration credits, deduplicate names and paginate exact artist matches', async t => {
  const f = fixture(t);
  const insert = f.sqlite.prepare("INSERT INTO music_submissions(id,poster_slug,author_id,title,artist,source_kind,source_url,status,created,updated) VALUES(?,?,?,?,?,'youtube','https://www.youtube.com/watch?v=dQw4w9WgXcQ',?,?,?)");
  for (let i = 0; i < 34; i++) {
    const credit = i === 0 ? 'Band, Guest, Élan, ÉLAN' : i === 31 ? 'Bandit' : i === 32 ? 'Band & Friends' : i === 33 ? 'Secret, Private' : i % 2 ? ' Guest , band , , ' : 'Band,Guest';
    insert.run(crypto.randomUUID(), i === 30 ? 'apokefish' : 'uaiden', i < 20 ? MEMBER : OTHER, `Song ${i}`, credit, i === 33 ? 'pending' : 'approved', String(i).padStart(3, '0'), 'now');
  }
  const list = async params => (await f.request('/api/music/?' + new URLSearchParams(params))).json();
  const first = await list({ artist: 'Band' });
  assert.equal(first.total, 31); assert.equal(first.pages, 2); assert.equal(first.tracks.length, 30);
  assert.deepEqual(first.artists.map(artist => artist.toLowerCase()).sort(), ['band', 'band & friends', 'bandit', 'guest', 'élan'].sort());
  assert.ok(first.artists.every(artist => !artist.includes(',')));
  const second = await list({ artist: 'Band', page: '2' });
  assert.equal(second.tracks.length, 1); assert.equal(second.tracks[0].artist, 'Band, Guest, Élan, ÉLAN');
  assert.equal((await list({ artist: 'Guest' })).total, 31);
  const legacy = await list({ artist: 'Band, Guest' });
  assert.equal(legacy.total, 31); assert.equal(legacy.filters.artist.toLowerCase(), 'band');
  assert.equal((await list({ artist: 'ÉLAN' })).total, 1);
  assert.equal((await list({ artist: 'Ban' })).total, 0);
  assert.equal((await list({ artist: 'Band & Friends' })).total, 1);
  assert.equal((await list({ artist: 'Private' })).total, 0);
  const combined = await list({ artist: ' band ', uploader: 'apokefish', q: 'Song 30', page: '2' });
  assert.equal(combined.total, 1); assert.equal(combined.page, 1); assert.equal(combined.tracks[0].title, 'Song 30');
  assert.equal(combined.tracks[0].artist, 'Band,Guest');
});

test('public music playback requires approved ready audio and supports seeking and HEAD', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const { track } = await createMusic(f, user);
  const path = `/api/music/${track.id}/play/`;
  await uploadMusic(f, user, track.id);
  assert.equal((await f.request(path)).status, 404);
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', { status: 'approved', version: 2, note: '' })).status, 200);
  assert.equal((await (await f.request('/api/music/')).json()).tracks[0].playbackUrl, path);
  const head = await f.request(path, { method: 'HEAD', headers: { Range: 'bytes=0-3' } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(wav.length)); assert.equal(await head.text(), '');
  const full = await f.request(path);
  assert.equal(full.status, 200); assert.equal(full.headers.get('Content-Type'), 'audio/wav');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), wav);
  for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=8-', 8, 47], ['bytes=-4', 44, 47], ['bytes=40-100', 40, 47]]) {
    const response = await f.request(path, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/48`);
    assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wav.slice(start, end + 1));
  }
  for (const range of ['bytes=48-', 'bytes=9-2', 'bytes=-0']) {
    const response = await f.request(path, { headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), 'bytes */48');
  }
  assert.equal((await f.request(path, { headers: { Range: 'bytes=0-3', 'If-Range': '"old"' } })).status, 200);
  assert.equal((await f.request(`/api/music/${track.id}/audio/`)).status, 401);
  f.sqlite.prepare("UPDATE music_submissions SET status='released' WHERE id=?").run(track.id);
  assert.equal((await f.request(path)).status, 200);
  for (const state of ['uploading', 'deleting', 'deleted']) {
    f.sqlite.prepare('UPDATE music_files SET state=? WHERE submission_id=?').run(state, track.id);
    assert.equal((await f.request(path)).status, 404);
  }
  f.sqlite.prepare("UPDATE music_files SET state='ready' WHERE submission_id=?").run(track.id);
  for (const status of ['rejected', 'deleted']) {
    f.sqlite.prepare('UPDATE music_submissions SET status=? WHERE id=?').run(status, track.id);
    assert.equal((await f.request(path)).status, 404);
  }
  assert.equal((await f.request(`/api/music/${crypto.randomUUID()}/play/`)).status, 404);
});
const wav = new Uint8Array(48);
wav.set(new TextEncoder().encode('RIFF'), 0); wav.set(new TextEncoder().encode('WAVE'), 8);
async function uploadMusic(f, user, id, bytes = wav, headers = {}) {
  const form = new FormData(); form.append('file', new File([bytes], 'song.wav', { type: 'text/html' }));
  return f.request(`/api/music/${id}/audio/`, { method: 'POST', headers: { Cookie: user.cookie, Origin: f.env.SITE_ORIGIN, 'X-CSRF-Token': user.csrf, ...headers }, body: form });
}
async function createMusic(_f, user, extra = {}) {
  const data = trackData(extra), response = await user.call('/api/music/', 'POST', data);
  assert.equal(response.status, 201); return { data, track: await response.json() };
}
function bridge(f, path, body) {
  if (body && path === 'report/' && body.catalogueVersion === undefined) body = { catalogueVersion: f.sqlite.prepare('SELECT catalogue_version FROM music_delivery WHERE id=1').get().catalogue_version, ...body };
  f.env.MUSIC_BRIDGE_KEY = 'test-only-music-bridge-key-123456789012345';
  return f.request('/api/music/bridge/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${f.env.MUSIC_BRIDGE_KEY}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('music sources accept individual canonical tracks, reject arbitrary fetch destinations and playlists', () => {
  assert.deepEqual(musicSource('https://youtu.be/dQw4w9WgXcQ?t=30'), { kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(musicSource('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=123').kind, 'youtube');
  assert.equal(musicSource('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=test').url, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  for (const source of ['http://youtu.be/dQw4w9WgXcQ', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://youtube.com@evil.test/', 'https://youtube.com:123/watch?v=dQw4w9WgXcQ', 'https://open.spotify.com/playlist/4uLU6hMCjMI75M1A2tKUQC', 'https://www.youtube.com/playlist?list=123', 'https://127.0.0.1/song.mp3']) assert.throws(() => musicSource(source));
  assert.equal(audioType(wav).mime, 'audio/wav');
  assert.throws(() => audioType(new TextEncoder().encode('<html>not audio</html>')));
});

test('Spotify metadata requires sign-in and CSRF, only fetches canonical track embeds, and returns title and every artist', async t => {
  const f = fixture(t), user = await f.login();
  const id = '4uLU6hMCjMI75M1A2tKUQC';
  f.spotifyResponses.set(`/embed/track/${id}`, () => new Response(`<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { type: 'track', id, title: 'A & B <song>', artists: [{ name: 'First artist' }, { name: 'Second artist' }], audioPreview: { url: 'private-preview' } } } } } } })}</script>`));
  const body = { sourceUrl: `https://open.spotify.com/intl-de/track/${id}?si=tracking` };
  assert.equal((await f.request('/api/music/metadata/', { method: 'POST' })).status, 401);
  assert.equal((await user.call('/api/music/metadata/', 'POST', body, { 'X-CSRF-Token': 'bad' })).status, 403);
  for (const sourceUrl of ['https://evil.test/track/123', 'https://open.spotify.com/playlist/123', 'https://open.spotify.com/album/123']) assert.equal((await user.call('/api/music/metadata/', 'POST', { sourceUrl })).status, 400);
  assert.equal(f.spotifyCalls.length, 0);
  const response = await user.call('/api/music/metadata/', 'POST', body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sourceUrl: `https://open.spotify.com/track/${id}`, title: 'A & B <song>', artist: 'First artist, Second artist' });
  assert.equal(f.spotifyCalls[0].url.href, `https://open.spotify.com/embed/track/${id}`);
  assert.equal(f.spotifyCalls[0].options.redirect, 'manual');
  assert.equal(f.spotifyCalls[0].options.headers.Authorization, undefined);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM music_submissions').get().n, 0);
});

test('Spotify artwork is optional and restricted to the provider image CDN', async t => {
  const f = fixture(t), user = await f.login(), id = '4uLU6hMCjMI75M1A2tKUQC';
  for (const [images, expected] of [[[{ url: 'https://image-cdn-ak.spotifycdn.com/image/album' }], 'https://image-cdn-ak.spotifycdn.com/image/album'], [[{ url: 'https://i.scdn.co/image/album' }], 'https://i.scdn.co/image/album'], [[{ url: 'https://evil.test/cover' }], undefined], [{ bad: true }, undefined]]) {
    f.spotifyResponses.set(`/embed/track/${id}`, () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { type: 'track', id, title: 'Song', artists: [{ name: 'Artist' }], visualIdentity: { image: images } } } } } } })}</script>`));
    const result = await (await user.call('/api/music/metadata/', 'POST', { sourceUrl: `https://open.spotify.com/track/${id}` })).json();
    assert.equal(result.title, 'Song'); assert.equal(result.coverUrl, expected);
  }
});

test('cover edits enforce ownership, CSRF and versions without changing installed audio releases', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER), owner = await f.login(OWNER);
  for (const coverUrl of ['javascript:alert(1)', 'data:image/png;base64,abc', 'http://images.test/a.jpg', 'https://user:pass@images.test/a.jpg']) {
    assert.equal((await user.call('/api/music/', 'POST', trackData({ coverUrl }))).status, 400);
  }
  const { data, track } = await createMusic(f, user, { coverUrl: 'https://images.test/album.jpg' });
  assert.equal(track.coverUrl, data.coverUrl);
  assert.equal((await user.call('/api/music/', 'POST', data)).status, 200);
  assert.equal((await user.call('/api/music/', 'POST', { ...data, coverUrl: 'https://images.test/other.jpg' })).status, 409);
  await uploadMusic(f, user, track.id);
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', { status: 'approved', version: 2, note: '' })).status, 200);
  const manifest = await (await bridge(f, 'manifest/')).json();
  assert.equal((await bridge(f, 'report/', { status: 'installed', releaseId: manifest.releaseId, catalogueVersion: manifest.catalogueVersion })).status, 200);
  const installed = await (await bridge(f, 'manifest/')).json();
  const version = installed.tracks[0].version, path = `/api/music/${track.id}/cover/`, body = { coverUrl: 'https://images.test/new.jpg', version };
  assert.equal((await other.call(path, 'POST', body)).status, 403);
  assert.equal((await user.call(path, 'POST', body, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await user.call(path, 'POST', body)).status, 200);
  assert.equal((await user.call(path, 'POST', body)).status, 409);
  const after = await (await bridge(f, 'manifest/')).json();
  assert.equal(after.releaseId, installed.releaseId); assert.equal(after.catalogueVersion, installed.catalogueVersion);
  const publicResult = await (await f.request('/api/music/')).json();
  assert.equal(publicResult.tracks[0].coverUrl, body.coverUrl); assert.equal(publicResult.tracks[0].status, 'released');
  assert.match(musicListHtml(publicResult), /referrerpolicy="no-referrer"/);
  assert.equal((await owner.call(path, 'POST', { coverUrl: '', version: version + 1 })).status, 200);
  assert.equal((await (await f.request('/api/music/')).json()).tracks[0].coverUrl, null);
});

test('Spotify metadata failures and oversized or changed pages allow manual entry without leaking provider content', async t => {
  const f = fixture(t), user = await f.login(), id = '4uLU6hMCjMI75M1A2tKUQC';
  for (const reply of [new Response('redirect', { status: 302, headers: { Location: 'https://evil.test/' } }), new Response('provider secret', { status: 429 }), new Response('x'.repeat(262145)), new Response('<script>changed page</script>')]) {
    f.spotifyResponses.set(`/embed/track/${id}`, () => reply);
    const response = await user.call('/api/music/metadata/', 'POST', { sourceUrl: `https://open.spotify.com/track/${id}` });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Could not load Spotify details. Enter the title and artist manually.' });
  }
});

test('YouTube links autofill video title and channel without fetching audio or forwarding credentials', async t => {
  const f = fixture(t), user = await f.login();
  f.youtubeResponses.set('/oembed', () => Response.json({ provider_name: 'YouTube', title: 'Song title', author_name: 'A performer - Topic', html: '<iframe>not returned</iframe>' }));
  const response = await user.call('/api/music/metadata/', 'POST', { sourceUrl: 'https://youtu.be/dQw4w9WgXcQ?t=5' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Song title', artist: 'A performer', artistIsChannel: true, coverUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' });
  assert.equal(f.youtubeCalls[0].url.searchParams.get('url'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(f.youtubeCalls[0].options.redirect, 'manual');
  assert.equal(f.youtubeCalls[0].options.headers.Authorization, undefined);
  for (const [thumbnail, expected] of [
    ['https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg'],
    ['https://evil.test/cover.jpg', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
    ['https://i.ytimg.com/vi/other-video/hqdefault.jpg', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
    ['javascript:alert(1)', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
  ]) {
    f.youtubeResponses.set('/oembed', () => Response.json({ provider_name: 'YouTube', title: 'Song', author_name: 'Artist', thumbnail_url: thumbnail }));
    const details = await (await user.call('/api/music/metadata/', 'POST', { sourceUrl: 'https://youtu.be/dQw4w9WgXcQ' })).json();
    assert.equal(details.coverUrl, expected);
  }
  f.youtubeResponses.set('/oembed', () => new Response('', { status: 404 }));
  assert.equal((await user.call('/api/music/metadata/', 'POST', { sourceUrl: 'https://youtu.be/dQw4w9WgXcQ' })).status, 502);
});

test('Spotify matching searches trusted metadata, offers bounded individual recordings, and rate limits searches', async t => {
  const f = fixture(t), user = await f.login(), id = '4uLU6hMCjMI75M1A2tKUQC';
  f.spotifyResponses.set(`/embed/track/${id}`, () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { id, type: 'track', title: 'Song', artists: [{ name: 'Artist' }], duration: 214000 } } } } } })}</script>`));
  const video = (videoId, length, title = 'Artist Song') => ({ videoRenderer: { videoId, title: { runs: [{ text: title }] }, lengthText: { simpleText: length }, ownerText: { runs: [{ text: 'Artist' }] } } });
  f.youtubeResponses.set('/results', () => new Response(`<script>var ytInitialData = ${JSON.stringify({ contents: [video('dQw4w9WgXcQ', '3:34'), video('jNQXAC9IVRw', '0:19', 'Unrelated'), video('dQw4w9WgXcQ', '3:34'), video('aaaaaaaaaaa', '20:00'), video('bbbbbbbbbbb', 'LIVE'), video('../invalid', '1:00')] })};</script>`));
  const body = { sourceUrl: `https://open.spotify.com/track/${id}`, title: 'Ignore caller query' };
  assert.equal((await f.request('/api/music/matches/', { method: 'POST' })).status, 401);
  const response = await user.call('/api/music/matches/', 'POST', body);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates.find(candidate => candidate.url.endsWith('aaaaaaaaaaa')).durationSeconds, 1200);
  assert.equal(result.candidates[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(result.candidates[0].durationSeconds, 214);
  assert.equal(f.youtubeCalls[0].url.searchParams.get('search_query'), 'Artist Song official audio');
  assert.equal(f.youtubeCalls[0].options.headers.Authorization, undefined);
  for (let i = 0; i < 4; i++) assert.equal((await user.call('/api/music/matches/', 'POST', body)).status, 200);
  assert.equal((await user.call('/api/music/matches/', 'POST', body)).status, 429);
});

test('confirmed Spotify recordings reach the bridge and fetched audio is charged to the original member', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const sourceUrl = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', audioSourceUrl = 'https://youtu.be/dQw4w9WgXcQ';
  for (const changes of [{ audioSourceUrl }, { audioSourceUrl: 'https://evil.test/audio', audioSourceConfirmed: true }, { audioSourceUrl: sourceUrl, audioSourceConfirmed: true }]) {
    assert.equal((await user.call('/api/music/', 'POST', trackData({ sourceUrl, ...changes }))).status, 400);
  }
  const { track, data } = await createMusic(f, user, { sourceUrl, audioSourceUrl, audioSourceConfirmed: true });
  assert.equal(track.audioSourceUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal((await user.call('/api/music/', 'POST', data)).status, 200);
  assert.equal((await user.call('/api/music/', 'POST', { ...data, audioSourceUrl: 'https://youtu.be/jNQXAC9IVRw' })).status, 409);
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', { status: 'approved', version: 1, note: '' })).status, 200);
  const manifest = await (await bridge(f, 'manifest/')).json();
  assert.equal(manifest.tracks[0].sourceUrl, sourceUrl);
  assert.equal(manifest.tracks[0].audioSourceUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal((await bridge(f, 'report/', { releaseId: manifest.releaseId, status: 'installed' })).status, 409);
  const form = new FormData(); form.append('file', new File([wav], 'converted.wav'));
  assert.equal((await f.request(`/api/music/bridge/${track.id}/audio/`, { method: 'POST', headers: { Authorization: `Bearer ${f.env.MUSIC_BRIDGE_KEY}` }, body: form })).status, 200);
  assert.equal((await (await user.call('/api/music/context/')).json()).usage.used, wav.length);
  const updated = await (await bridge(f, 'manifest/')).json();
  assert.notEqual(updated.releaseId, manifest.releaseId);
  assert.equal((await bridge(f, 'report/', { releaseId: updated.releaseId, status: 'installed' })).status, 200);
});

test('only the member or owner can change an unapproved recording, with version and active-file checks', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER), owner = await f.login(OWNER);
  const { track } = await createMusic(f, user, { sourceUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' });
  const body = { audioSourceUrl: 'https://youtu.be/dQw4w9WgXcQ', audioSourceConfirmed: true, version: 1 };
  assert.equal((await other.call(`/api/music/${track.id}/source/`, 'POST', body)).status, 403);
  assert.equal((await user.call(`/api/music/${track.id}/source/`, 'POST', { ...body, audioSourceConfirmed: false })).status, 400);
  assert.equal((await user.call(`/api/music/${track.id}/source/`, 'POST', body)).status, 200);
  assert.equal((await user.call(`/api/music/${track.id}/source/`, 'POST', body)).status, 409);
  await uploadMusic(f, user, track.id);
  assert.equal(f.sqlite.prepare('SELECT audio_source_url FROM music_submissions WHERE id=?').get(track.id).audio_source_url, null);
  assert.equal((await owner.call(`/api/music/${track.id}/source/`, 'POST', { ...body, version: 3 })).status, 409);
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', { status: 'approved', version: 3, note: '' })).status, 200);
  assert.equal((await owner.call(`/api/music/${track.id}/source/`, 'POST', { ...body, version: 4 })).status, 409);
});

test('music libraries require a current IGN role, isolate authors, and save idempotently without publishing', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER), owner = await f.login(OWNER);
  assert.equal((await f.request('/api/music/', { method: 'POST' })).status, 401);
  assert.equal((await user.call('/api/music/', 'POST', trackData({ posterSlug: 'apokefish' }))).status, 403);
  assert.equal((await owner.call('/api/music/', 'POST', trackData({ posterSlug: 'apokefish' }))).status, 403);
  const { data, track } = await createMusic(f, user);
  assert.equal((await user.call('/api/music/', 'POST', data)).status, 200);
  assert.equal((await user.call('/api/music/', 'POST', { ...data, title: 'Different' })).status, 409);
  assert.equal((await (await f.request('/api/music/')).json()).total, 0);
  const context = await (await user.call('/api/music/context/')).json();
  assert.equal(context.submissions.length, 1); assert.equal(context.usage.used, 0);
  assert.equal(JSON.stringify(context).includes(MEMBER), false);
  assert.equal((await (await other.call('/api/music/context/')).json()).submissions.length, 0);
  assert.equal((await other.call('/api/music/context/?scope=all')).status, 403);
  assert.equal((await (await owner.call('/api/music/context/')).json()).submissions.length, 0);
  assert.equal((await (await owner.call('/api/music/context/?scope=all')).json()).submissions.length, 1);
  assert.equal((await other.call(`/api/music/${track.id}/`, 'DELETE', { version: 1 })).status, 403);
  f.memberships.set(MEMBER, []);
  assert.equal((await uploadMusic(f, user, track.id)).status, 403);
  assert.equal((await (await user.call('/api/music/context/')).json()).submissions.length, 0);
});

test('music files are private, sniff actual bytes, charge separate quotas, and reuse a confirmed upload on retry', async t => {
  const f = fixture(t), user = await f.login(), other = await f.login(OTHER);
  const { track } = await createMusic(f, user);
  assert.equal((await uploadMusic(f, user, track.id, wav, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await uploadMusic(f, user, track.id, new TextEncoder().encode('<script>bad</script>'))).status, 415);
  assert.equal((await uploadMusic(f, user, track.id)).status, 200);
  assert.equal((await uploadMusic(f, user, track.id)).status, 200);
  assert.equal(f.objects.size, 1);
  const context = await (await user.call('/api/music/context/')).json();
  assert.equal(context.usage.used, wav.length); assert.equal(context.submissions[0].hasAudio, true);
  assert.equal((await f.request(`/api/music/${track.id}/audio/`)).status, 401);
  assert.equal((await other.call(`/api/music/${track.id}/audio/`)).status, 403);
  const response = await user.call(`/api/music/${track.id}/audio/`);
  assert.equal(response.headers.get('Content-Type'), 'audio/wav');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wav);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM media').get().count, 0);
});

test('owner review requires audio for Spotify/files, allows queued YouTube conversion, and checks versions', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const { track } = await createMusic(f, user, { sourceUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' });
  const review = { status: 'approved', version: 1, note: '' };
  assert.equal((await user.call(`/api/music/${track.id}/review/`, 'POST', review)).status, 403);
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', review)).status, 409);
  await uploadMusic(f, user, track.id);
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', review)).status, 409);
  const approved = await owner.call(`/api/music/${track.id}/review/`, 'POST', { ...review, version: 2 }); assert.equal(approved.status, 200);
  assert.equal((await user.call(`/api/music/${track.id}/`, 'DELETE', { version: 3 })).status, 409);
  assert.equal((await uploadMusic(f, user, track.id)).status, 409);
  const publicList = await (await f.request('/api/music/')).json();
  assert.equal(publicList.total, 1); assert.equal(publicList.tracks[0].status, 'approved');
  assert.equal(JSON.stringify(publicList).includes('filename'), false); assert.equal(JSON.stringify(publicList).includes(MEMBER), false);
  const youtube = await createMusic(f, user, { sourceUrl: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal((await owner.call(`/api/music/${youtube.track.id}/review/`, 'POST', review)).status, 200);
});

test('the music bridge is scoped to approved files and installation acknowledgement preserves existing discs', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const { track } = await createMusic(f, user);
  await uploadMusic(f, user, track.id);
  assert.equal((await f.request('/api/music/bridge/manifest/')).status, 401);
  assert.equal((await bridge(f, `${track.id}/audio/`)).status, 404);
  await owner.call(`/api/music/${track.id}/review/`, 'POST', { status: 'approved', version: 2, note: '' });
  const manifest = await (await bridge(f, 'manifest/')).json();
  assert.equal(manifest.tracks.length, 1); assert.equal(manifest.tracks[0].libraryId, MEMBER);
  assert.equal((await bridge(f, 'report/', { releaseId: manifest.releaseId, status: 'waiting', message: 'Players online' })).status, 200);
  assert.equal(f.sqlite.prepare('SELECT state FROM music_delivery WHERE id=1').get().state, 'waiting');
  assert.equal((await (await bridge(f, 'manifest/')).json()).tracks[0].status, 'approved');
  assert.equal((await bridge(f, `${track.id}/audio/`)).status, 200);
  assert.equal((await bridge(f, 'report/', { releaseId: '0'.repeat(64), status: 'installed' })).status, 409);
  assert.equal((await bridge(f, 'report/', { releaseId: manifest.releaseId, status: 'installed' })).status, 200);
  const next = await (await bridge(f, 'manifest/')).json();
  assert.equal(next.releaseId, manifest.releaseId); assert.equal(next.tracks[0].status, 'released');
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', { version: 4, status: 'rejected', note: '' })).status, 409);
  assert.equal((await owner.call(`/api/music/${track.id}/`, 'DELETE', { version: 4 })).status, 409);
  assert.equal((await (await f.request('/api/music/')).json()).tracks[0].status, 'released');
});

test('server-side YouTube conversion stores audio in the submitter library and cannot modify other sources', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const youtube = await createMusic(f, user, { sourceUrl: 'https://youtu.be/dQw4w9WgXcQ' });
  await owner.call(`/api/music/${youtube.track.id}/review/`, 'POST', { version: 1, status: 'approved', note: '' });
  const manifest = await (await bridge(f, 'manifest/')).json();
  assert.equal((await bridge(f, 'report/', { status: 'installed', releaseId: manifest.releaseId })).status, 409);
  const form = new FormData(); form.append('file', new File([wav], 'converted.wav'));
  const response = await f.request(`/api/music/bridge/${youtube.track.id}/audio/`, { method: 'POST', headers: { Authorization: `Bearer ${f.env.MUSIC_BRIDGE_KEY}` }, body: form });
  assert.equal(response.status, 200);
  const context = await (await user.call('/api/music/context/')).json();
  assert.equal(context.usage.used, wav.length); assert.equal(context.submissions[0].hasAudio, true);
  const updated = await (await bridge(f, 'manifest/')).json(); assert.notEqual(updated.releaseId, manifest.releaseId);
  const pending = await createMusic(f, user);
  const denied = await f.request(`/api/music/bridge/${pending.track.id}/audio/`, { method: 'POST', headers: { Authorization: `Bearer ${f.env.MUSIC_BRIDGE_KEY}` }, body: form });
  assert.equal(denied.status, 404);
});

test('music deletion frees storage, failed storage operations retain reservations, and cleanup retries', async t => {
  const f = fixture(t), user = await f.login();
  const { track } = await createMusic(f, user); await uploadMusic(f, user, track.id);
  assert.equal((await user.call(`/api/music/${track.id}/`, 'DELETE', { version: 1 })).status, 409);
  assert.equal((await user.call(`/api/music/${track.id}/`, 'DELETE', { version: 2 })).status, 200);
  assert.equal((await (await user.call('/api/music/context/')).json()).usage.used, 0); assert.equal(f.objects.size, 0);
  const second = await createMusic(f, user);
  const originalPut = f.env.MEDIA.put, originalDelete = f.env.MEDIA.delete;
  f.env.MEDIA.put = async () => { throw new Error('Storage failed'); };
  f.env.MEDIA.delete = async () => { throw new Error('Deletion failed'); };
  assert.equal((await uploadMusic(f, user, second.track.id)).status, 503);
  assert.equal((await (await user.call('/api/music/context/')).json()).usage.used, wav.length);
  f.sqlite.prepare("UPDATE music_files SET created=? WHERE state='uploading'").run(Date.now() - 7200000);
  f.env.MEDIA.put = originalPut; f.env.MEDIA.delete = originalDelete;
  await cleanupMusic(f.env);
  assert.equal((await (await user.call('/api/music/context/')).json()).usage.used, 0);
  assert.equal((await uploadMusic(f, user, second.track.id)).status, 200);
});

test('music quota reservations are atomic across player profiles and public music escapes user text', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const first = await createMusic(f, user, { title: '<script>bad</script>', artist: 'A & B' });
  for (let i = 0; i < 5; i++) {
    const data = trackData();
    f.sqlite.prepare('INSERT INTO music_submissions(id,poster_slug,author_id,title,source_kind,created,updated) VALUES(?,?,?,?,?,?,?)').run(data.id, 'uaiden', MEMBER, 'Reserved', 'file', 'now', 'now');
    f.sqlite.prepare("INSERT INTO music_files VALUES(?,?,?,'source.mp3','audio/mpeg','mp3',20971520,?,'ready',?)").run(crypto.randomUUID(), data.id, MEMBER, '0'.repeat(64), Date.now());
  }
  assert.equal((await uploadMusic(f, user, first.track.id)).status, 413);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM music_files WHERE state!='deleted'").get().count, 5);
  f.sqlite.exec("UPDATE music_files SET state='deleted'");
  await uploadMusic(f, user, first.track.id);
  await owner.call(`/api/music/${first.track.id}/review/`, 'POST', { status: 'approved', version: 2, note: '' });
  const html = musicListHtml(await (await f.request('/api/music/')).json());
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;')); assert.equal(html.includes('<script>'), false); assert.ok(html.includes('A &amp; B'));
});

test('members can replace an unapproved audio file, while deletion blocks approval and retains quota until storage confirms', async t => {
  const f = fixture(t), user = await f.login(), owner = await f.login(OWNER);
  const { track } = await createMusic(f, user);
  await uploadMusic(f, user, track.id);
  assert.equal((await user.call(`/api/music/${track.id}/audio/`, 'DELETE', { version: 1 })).status, 409);
  const originalDelete = f.env.MEDIA.delete;
  f.env.MEDIA.delete = async () => { throw new Error('Unavailable'); };
  const pending = await (await user.call(`/api/music/${track.id}/audio/`, 'DELETE', { version: 2 })).json();
  assert.equal(pending.deletionPending, true);
  assert.equal((await owner.call(`/api/music/${track.id}/review/`, 'POST', { status: 'approved', version: 2, note: '' })).status, 409);
  assert.equal((await (await user.call('/api/music/context/')).json()).usage.used, wav.length);
  f.env.MEDIA.delete = originalDelete;
  await cleanupMusic(f.env);
  assert.equal((await (await user.call('/api/music/context/')).json()).usage.used, 0);
  assert.equal((await uploadMusic(f, user, track.id)).status, 200);
  assert.equal((await user.call(`/api/music/${track.id}/audio/`, 'DELETE', { version: 3 })).status, 200);
  assert.equal((await (await user.call('/api/music/context/')).json()).usage.used, 0);
});

function mapartFixture(t) {
  const f = fixture(t);
  f.env.MAPART_ENABLED = 'true'; f.env.MAPART_BRIDGE_KEY = 'mapart-bridge-test-key-with-more-than-32-characters';
  f.sqlite.prepare("UPDATE players SET minecraft_id=?,edition='java',version=version+1 WHERE slug='uaiden'").run(`java:${'a'.repeat(32)}`);
  f.bridge = (path, method = 'POST', body = {}, lease, limits) => f.request(`/api/mapart/bridge/${path}`, {
    method, headers: { Authorization: `Bearer ${f.env.MAPART_BRIDGE_KEY}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(lease ? { 'X-Mapart-Lease': lease } : {}), ...(limits ? { 'X-Mapart-Max-Tiles': String(limits.tiles), 'X-Mapart-Max-Side': String(limits.side) } : {}) },
    ...(method === 'GET' ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  return f;
}
const mapartSubmission = (extra = {}) => ({ id: crypto.randomUUID(), posterSlug: 'uaiden', title: 'My mapart', columns: 2, rows: 1, fit: 'crop', horizontalAlignment: 'right', verticalAlignment: 'bottom', dither: true, ...extra });
async function mapartUpload(f, user, id, bytes = gif) {
  const form = new FormData(); form.set('file', new File([bytes], 'private.gif'));
  return f.request(`/api/mapart/${id}/source/`, { method: 'POST', headers: { Cookie: user.cookie, Origin: f.env.SITE_ORIGIN, 'X-CSRF-Token': user.csrf }, body: form });
}
function mapartResult(columns = 2, rows = 1) {
  const form = new FormData(), png = new Uint8Array(readFileSync('public/images/players/0480.png'));
  new DataView(png.buffer).setUint32(16, columns * 128); new DataView(png.buffer).setUint32(20, rows * 128);
  form.set('pixels', new File([new Uint8Array(columns * rows * 16384).fill(34)], 'pixels'));
  form.set('preview', new File([png], 'preview.png'));
  return form;
}
async function queuedMapart(f, user, extra = {}) {
  const fields = mapartSubmission(extra), response = await user.call('/api/mapart/', 'POST', fields);
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  if (!fields.mediaId) assert.equal((await mapartUpload(f, user, fields.id)).status, 200);
  return fields;
}

test('mapart geometry handles all anchors, crop overflow, odd remainders, and validation', () => {
  for (const horizontalAlignment of ['left','center','right']) for (const verticalAlignment of ['top','center','bottom']) {
    const settings = mapartFields({ title:'Test',columns:2,rows:3,horizontalAlignment,verticalAlignment });
    const layout = mapartLayout(600,100,settings);
    assert.equal(layout.resizedWidth,256); assert.equal(layout.resizedHeight,43);
    assert.equal(layout.y, {top:0,center:170,bottom:341}[verticalAlignment]);
    const crop = mapartLayout(600,100,{...settings,fit:'crop'});
    assert.equal(crop.x,{left:0,center:-1024,right:-2048}[horizontalAlignment]);
  }
  assert.equal(mapartLayout(129,128,mapartFields({title:'Test',fit:'crop'})).x,-1);
  assert.throws(() => mapartFields({ title:'Test',horizontalAlignment:'near' }));
  for (const [columns,rows] of [[9,9],[16,16],[32,8],[64,4],[4,64]]) assert.equal(mapartFields({title:'Test',columns,rows}).columns,columns);
  for (const [columns,rows] of [[17,16],[65,1],[0,1],[1.5,1],[Number.MAX_SAFE_INTEGER,1]]) assert.throws(() => mapartFields({title:'Test',columns,rows}));
  assert.throws(() => mapartFields({ title:'Test',dither:'true' }));
});

test('mapart accepts larger layouts and results while enforcing the total tile budget', async t => {
  const f=mapartFixture(t), user=await f.login();
  assert.equal((await user.call('/api/mapart/','POST',mapartSubmission({columns:17,rows:16}))).status,400);
  const fields=await queuedMapart(f,user,{columns:32,rows:8});
  const small=await queuedMapart(f,user);
  assert.equal((await(await f.bridge('lease/')).json()).job.id,small.id);
  assert.equal((await(await f.bridge('lease/')).json()).job,null);
  const job=(await(await f.bridge('lease/','POST',{},undefined,{tiles:256,side:64})).json()).job;
  assert.equal(job.id,fields.id);
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(16,16),job.lease)).status,400);
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(32,8),job.lease)).status,200);
  const result=await(await user.call(`/api/mapart/${fields.id}/`)).json();
  assert.equal(result.status,'ready');
  const pixels=await f.bridge(`${fields.id}/pixels/`,'GET');
  assert.equal((await pixels.arrayBuffer()).byteLength,4*1024*1024);
});

test('mapart is private, role-gated, CSRF-protected, and disabled until explicitly enabled', async t => {
  const f = mapartFixture(t), user = await f.login(), other = await f.login(OTHER);
  assert.equal((await f.request('/api/mapart/context/')).status,200);
  assert.equal((await f.request('/api/mapart/',{method:'POST'})).status,401);
  assert.equal((await other.call('/api/mapart/','POST',mapartSubmission())).status,403);
  assert.equal((await user.call('/api/mapart/','POST',mapartSubmission(),{'X-CSRF-Token':'wrong'})).status,403);
  f.env.MAPART_ENABLED='false';
  assert.equal((await user.call('/api/mapart/','POST',mapartSubmission())).status,503);
  f.env.MAPART_ENABLED='true';
  const fields = await queuedMapart(f,user);
  assert.equal((await other.call(`/api/mapart/${fields.id}/`)).status,403);
  assert.equal((await other.call(`/api/mapart/${fields.id}/`,'DELETE')).status,403);
  const context = await (await user.call('/api/mapart/context/')).json();
  assert.equal(context.artworks.length,1); assert.equal(JSON.stringify(context).includes(MEMBER),false);
  assert.equal(context.artworks[0].settings.horizontalAlignment,'right');
  assert.equal(context.artworks[0].posterName,'uaiden');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM media').get().n,0);
  f.memberships.set(MEMBER,[]);
  assert.equal((await user.call(`/api/mapart/${fields.id}/`)).status,403);
});

test('temporary mapart uploads retry without duplicate jobs and reject spoofed or oversized files', async t => {
  const f=mapartFixture(t),user=await f.login(),fields=mapartSubmission();
  assert.equal((await user.call('/api/mapart/','POST',fields)).status,201);
  assert.equal((await user.call('/api/mapart/','POST',fields)).status,200);
  assert.equal((await user.call('/api/mapart/','POST',{...fields,title:'Different'})).status,409);
  assert.equal((await mapartUpload(f,user,fields.id,new Uint8Array([1,2,3]))).status,415);
  assert.equal((await mapartUpload(f,user,fields.id,new Uint8Array(5*1024*1024+1))).status,413);
  const put=f.env.MEDIA.put; f.env.MEDIA.put=async()=>{throw new Error('offline');};
  assert.equal((await mapartUpload(f,user,fields.id)).status,503);
  f.env.MEDIA.put=put;
  assert.equal((await mapartUpload(f,user,fields.id)).status,200);
  assert.equal((await mapartUpload(f,user,fields.id)).status,200);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM mapart_jobs').get().n,1);
  assert.equal(f.objects.size,1);
});

test('only one concurrent source upload can write a mapart job', async t => {
  const f=mapartFixture(t),user=await f.login(),fields=mapartSubmission();
  await user.call('/api/mapart/','POST',fields);
  const put=f.env.MEDIA.put; let release,started;
  const writing=new Promise(resolve=>{started=resolve;});
  f.env.MEDIA.put=async(...args)=>{started();await new Promise(resolve=>{release=resolve;});return put(...args);};
  const first=mapartUpload(f,user,fields.id); await writing;
  assert.equal((await mapartUpload(f,user,fields.id)).status,409);
  release(); assert.equal((await first).status,200);
});

test('a timed-out upload cannot overwrite or delete a newer successful source', async t => {
  const f=mapartFixture(t),user=await f.login(),fields=mapartSubmission();
  await user.call('/api/mapart/','POST',fields);
  const put=f.env.MEDIA.put; let release,started,writes=0;
  const writing=new Promise(resolve=>{started=resolve;});
  f.env.MEDIA.put=async(...args)=>{if(++writes===1){started();await new Promise(resolve=>{release=resolve;});}return put(...args);};
  const first=mapartUpload(f,user,fields.id); await writing;
  f.sqlite.prepare('UPDATE mapart_jobs SET updated=0 WHERE id=?').run(fields.id);
  const replacement=new Uint8Array(gif); replacement[17]=254;
  assert.equal((await mapartUpload(f,user,fields.id,replacement)).status,200);
  release(); assert.equal((await first).status,503);
  const {job}=await(await f.bridge('lease/')).json();
  const source=await f.bridge(`${fields.id}/source/`,'GET',{},job.lease);
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()),replacement);
  assert.equal(f.objects.size,1);
});

test('Bedrock mapart claims bind to the verified XUID rather than a Java UUID or player name', async t => {
  const f=mapartFixture(t),user=await f.login(),identity='bedrock:2533274800000000';
  f.sqlite.prepare("UPDATE players SET minecraft_id=?,edition='bedrock',version=version+1 WHERE slug='uaiden'").run(identity);
  const fields=await queuedMapart(f,user),{job}=await(await f.bridge('lease/')).json();
  await f.bridge(`${fields.id}/result/`,'POST',mapartResult(),job.lease);
  const code=(await(await user.call(`/api/mapart/${fields.id}/`)).json()).command.split(' ').at(-1);
  assert.equal((await f.bridge('claim/','POST',{code,identity})).status,200);
  assert.equal((await f.bridge('claim/','POST',{code,identity:'uaiden'})).status,403);
  assert.equal((await f.bridge('claim/','POST',{code,identity:`java:${'a'.repeat(32)}`})).status,403);
});

test('mapart leases exclude concurrent consumers, expire safely, and reject stale reports', async t => {
  const f=mapartFixture(t),user=await f.login(),fields=await queuedMapart(f,user);
  assert.equal((await f.request('/api/mapart/bridge/lease/',{method:'POST'})).status,401);
  const first=await(await f.bridge('lease/')).json(); assert.equal(first.job.id,fields.id);
  assert.equal((await(await f.bridge('lease/')).json()).job,null);
  f.sqlite.prepare('UPDATE mapart_jobs SET lease_until=0 WHERE id=?').run(fields.id);
  const next=await(await f.bridge('lease/')).json(); assert.notEqual(next.job.lease,first.job.lease);
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(),first.job.lease)).status,409);
  const source=await f.bridge(`${fields.id}/source/`,'GET',{},next.job.lease);
  assert.equal(source.status,200); assert.equal(source.headers.get('X-Content-SHA256').length,64);
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()),new Uint8Array(gif));
});

test('successful mapart conversion deletes its temporary original, keeps private results, and authorizes repeat claims freshly', async t => {
  const f=mapartFixture(t),user=await f.login(),other=await f.login(OTHER),fields=await queuedMapart(f,user);
  const {job}=await(await f.bridge('lease/')).json();
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(1,1),job.lease)).status,400);
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(),job.lease)).status,200);
  assert.equal([...f.objects.keys()].some(key=>key.endsWith('/source')),false);
  const artwork=await(await user.call(`/api/mapart/${fields.id}/`)).json(); assert.equal(artwork.status,'ready');
  assert.equal((await user.call(artwork.previewUrl)).headers.get('Cache-Control'),'no-store');
  assert.equal((await other.call(artwork.previewUrl)).status,403);
  const code=artwork.command.split(' ').at(-1),identity=`java:${'a'.repeat(32)}`;
  assert.equal((await f.bridge('claim/','POST',{code,identity:`java:${'b'.repeat(32)}`})).status,403);
  const first=await(await f.bridge('claim/','POST',{code,identity})).json();
  const next=await(await f.bridge('claim/','POST',{code,identity})).json(); assert.equal(next.id,first.id); assert.equal(next.sha256,first.sha256);
  assert.equal((await f.bridge(`${fields.id}/pixels/`,'GET')).status,200);
  f.memberships.set(MEMBER,[]); assert.equal((await f.bridge('claim/','POST',{code,identity})).status,403);
  f.memberships.set(MEMBER,['role-uaiden']); f.failDiscord(); assert.equal((await f.bridge('claim/','POST',{code,identity})).status,503);
});

test('library sources are pinned during conversion, reusable on create retries, and independent after conversion', async t => {
  const f=mapartFixture(t),user=await f.login();
  const image=(await(await upload(f,user)).json()).image;
  const fields=await queuedMapart(f,user,{mediaId:image.id});
  assert.equal((await user.call(`/api/players/uaiden/images/${image.id}/`,'DELETE')).status,409);
  const {job}=await(await f.bridge('lease/')).json();
  assert.equal((await f.bridge(`${fields.id}/source/`,'GET',{},job.lease)).status,200);
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(),job.lease)).status,200);
  assert.equal((await user.call('/api/mapart/','POST',fields)).status,200);
  assert.equal((await user.call(`/api/players/uaiden/images/${image.id}/`,'DELETE')).status,200);
  assert.equal((await f.bridge(`${fields.id}/pixels/`,'GET')).status,200);
});

test('mapart cleanup retries failed deletions, expires sources, and revokes deleted artwork claims', async t => {
  const f=mapartFixture(t),user=await f.login(),fields=await queuedMapart(f,user);
  const {job}=await(await f.bridge('lease/')).json();
  const remove=f.env.MEDIA.delete; f.env.MEDIA.delete=async()=>{throw new Error('offline');};
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(),job.lease)).status,200);
  assert.equal([...f.objects.keys()].some(key=>key.endsWith('/source')),true);
  f.env.MEDIA.delete=remove; await cleanupMapart(f.env);
  assert.equal([...f.objects.keys()].some(key=>key.endsWith('/source')),false);
  const art=await(await user.call(`/api/mapart/${fields.id}/`)).json();
  assert.equal((await user.call(`/api/mapart/${fields.id}/`,'DELETE')).status,200);
  assert.equal((await f.bridge('claim/','POST',{code:art.command.split(' ').at(-1),identity:`java:${'a'.repeat(32)}`})).status,403);
  assert.equal(f.objects.size,0);
  const expired=await queuedMapart(f,user); f.sqlite.prepare('UPDATE mapart_jobs SET expires=0 WHERE id=?').run(expired.id);
  await cleanupMapart(f.env);
  assert.equal((await(await user.call(`/api/mapart/${expired.id}/`)).json()).canRetry,false);
  assert.equal(f.objects.size,0);
});

test('mapart pending quotas prevent concurrent retry overflow', async t => {
  const f=mapartFixture(t),user=await f.login();
  f.sqlite.prepare('UPDATE mapart_limits SET pending_limit=1').run();
  const first=await queuedMapart(f,user);
  assert.equal((await user.call('/api/mapart/','POST',mapartSubmission())).status,413);
  const {job}=await(await f.bridge('lease/')).json(); await f.bridge(`${first.id}/failed/`,'POST',{},job.lease);
  await queuedMapart(f,user);
  assert.equal((await user.call(`/api/mapart/${first.id}/retry/`,'POST',{})).status,413);
});

test('mapart allows more than 25 completed artworks and charges actual retained bytes', async t => {
  const f=mapartFixture(t),user=await f.login();
  for (let i=0;i<26;i++) {
    f.sqlite.exec('DELETE FROM rate_limits');
    const fields=await queuedMapart(f,user),{job}=await(await f.bridge('lease/')).json();
    assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(),job.lease)).status,200);
  }
  const result=await(await user.call('/api/mapart/context/')).json();
  assert.equal(result.artworks.length,26);
  assert.equal(Object.hasOwn(result.limits,'saved'),false);
  assert.equal(result.usage.limit,100*1024*1024);
  assert.equal(result.usage.used,[...f.objects.values()].reduce((sum,value)=>sum+value.length,0));
  assert.ok(result.usage.used>0 && result.usage.used<result.usage.limit);
});

test('mapart reserves bytes before concurrent uploads and releases them only after deletion succeeds', async t => {
  const f=mapartFixture(t),user=await f.login();
  const bytes=gif.length;
  f.sqlite.prepare('UPDATE mapart_limits SET storage_limit_bytes=?').run(bytes);
  const fields=[mapartSubmission(),mapartSubmission()];
  for (const art of fields) assert.equal((await user.call('/api/mapart/','POST',art)).status,201);
  const responses=await Promise.all(fields.map(art=>mapartUpload(f,user,art.id)));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,413]);
  const winner=fields[responses.findIndex(r=>r.status===200)],loser=fields[responses.findIndex(r=>r.status===413)];
  assert.equal(f.objects.size,1);
  assert.equal((await(await user.call('/api/mapart/context/')).json()).usage.used,bytes);
  const remove=f.env.MEDIA.delete;f.env.MEDIA.delete=async()=>{throw new Error('offline');};
  await user.call(`/api/mapart/${winner.id}/`,'DELETE');
  assert.equal((await(await user.call('/api/mapart/context/')).json()).usage.used,bytes);
  assert.equal((await mapartUpload(f,user,loser.id)).status,413);
  f.env.MEDIA.delete=remove;await cleanupMapart(f.env);
  assert.equal((await(await user.call('/api/mapart/context/')).json()).usage.used,0);
  assert.equal((await mapartUpload(f,user,loser.id)).status,200);
});

test('mapart output quotas fail clearly, retry after space is available, and measure legacy files', async t => {
  const f=mapartFixture(t),user=await f.login();
  const image=(await(await upload(f,user)).json()).image;
  const fields=await queuedMapart(f,user,{mediaId:image.id});
  const output=mapartResult(),size=output.get('pixels').size+output.get('preview').size;
  f.sqlite.prepare('UPDATE mapart_limits SET storage_limit_bytes=?').run(size-1);
  let {job}=await(await f.bridge('lease/')).json();
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',output,job.lease)).status,413);
  const failed=await(await user.call(`/api/mapart/${fields.id}/`)).json();
  assert.equal(failed.status,'failed');assert.match(failed.error,/storage is full/);assert.equal(failed.canRetry,true);
  assert.equal([...f.objects.keys()].filter(key=>key.startsWith('mapart/')).length,0);
  f.sqlite.prepare('UPDATE mapart_limits SET storage_limit_bytes=?').run(size);
  assert.equal((await user.call(`/api/mapart/${fields.id}/retry/`,'POST',{})).status,200);
  ({job}=await(await f.bridge('lease/')).json());
  assert.equal((await f.bridge(`${fields.id}/result/`,'POST',mapartResult(),job.lease)).status,200);
  assert.equal((await(await user.call('/api/mapart/context/')).json()).usage.used,size);
  // Emulate the conservative charges assigned to pre-migration objects.
  f.sqlite.prepare('UPDATE mapart_limits SET storage_limit_bytes=104857600').run();
  f.sqlite.prepare('UPDATE mapart_attempts SET bytes=11534336,size_checked=0').run();
  assert.equal((await(await user.call('/api/mapart/context/')).json()).usage.used,size);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM mapart_attempts WHERE size_checked=0').get().n,0);
});


test('server status reports expose the full roster, distinguish empty/offline/stale, and require a separate credential', async t => {
  const f = fixture(t); f.env.SERVER_STATUS_KEY = 'status-only-test-secret-12345678901234567890';
  const report = (body, key=f.env.SERVER_STATUS_KEY) => f.request('/api/server-status/report/', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  assert.equal((await (await f.request('/api/server-status/')).json()).availability, 'unavailable');
  const players = ['.Bedrock player', ...Array.from({length: 18}, (_,i) => `Java${i}`)];
  assert.equal((await report({availability:'online',players,capacity:20}, 'wrong-key')).status,401);
  assert.equal((await report({availability:'online',players,capacity:20, uuid:'private',ip:'private'})).status,200);
  const response = await f.request('/api/server-status/'), value = await response.json();
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(value.online,19); assert.deepEqual(new Set(value.players),new Set(players));
  assert.equal(JSON.stringify(value).includes('private'),false);
  assert.equal((await bridge(f,'heartbeat/',{})).status,200);
  assert.equal((await report({availability:'online',players:[],capacity:20},f.env.MUSIC_BRIDGE_KEY)).status,401);
  await report({availability:'online',players:[],capacity:20});
  assert.equal((await (await f.request('/api/server-status/')).json()).online,0);
  await report({availability:'offline',players:[],capacity:20});
  assert.equal((await (await f.request('/api/server-status/')).json()).availability,'offline');
  f.sqlite.prepare('UPDATE server_status SET received=?').run(Date.now()-46000);
  const stale = await (await f.request('/api/server-status/')).json();
  assert.equal(stale.availability,'unavailable'); assert.equal(stale.online,null);
});

test('track progress is public, does not change catalogue revisions, and rejects stale attempts', async t => {
  const f=fixture(t),user=await f.login(),owner=await f.login(OWNER);
  const {track}=await createMusic(f,user,{sourceUrl:'https://youtu.be/dQw4w9WgXcQ'});
  await owner.call(`/api/music/${track.id}/review/`,'POST',{status:'approved',version:1,note:''});
  const manifest=await(await bridge(f,'manifest/')).json();
  const body={releaseId:manifest.releaseId,catalogueVersion:manifest.catalogueVersion,trackId:track.id,phase:'failed',reason:'youtube_access_blocked'};
  assert.equal((await bridge(f,'progress/',body)).status,200);
  assert.equal((await(await bridge(f,'manifest/')).json()).catalogueVersion,manifest.catalogueVersion);
  const result=await(await f.request('/api/music/')).json();
  assert.equal(result.tracks[0].delivery.reason,'youtube_access_blocked');
  assert.ok(musicListHtml(result).includes('Audio download blocked by YouTube'));
  assert.equal(musicListHtml(result).includes('data-music-claim='),false);
  assert.equal((await bridge(f,'progress/',{...body,reason:'raw provider stderr'})).status,400);
  assert.equal((await bridge(f,'progress/',{...body,trackId:crypto.randomUUID()})).status,409);
  await owner.call(`/api/music/${track.id}/review/`,'POST',{status:'approved',version:2,note:'same source new approval'});
  const next=await(await bridge(f,'manifest/')).json();
  assert.equal(next.releaseId,manifest.releaseId); assert.notEqual(next.catalogueVersion,manifest.catalogueVersion);
  assert.equal((await bridge(f,'progress/',body)).status,409);
  assert.equal((await bridge(f,'report/',{...body,status:'failed'})).status,409);
  assert.equal((await(await f.request('/api/music/')).json()).tracks[0].delivery,undefined);
});

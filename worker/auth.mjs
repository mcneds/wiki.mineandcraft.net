const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
export class HttpError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; Object.assign(this, details); }
}
export const random = () => crypto.randomUUID() + crypto.randomUUID();
export const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
async function key(env) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(env.SESSION_KEY)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), encoder.encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function unseal(value, env) {
  const [iv, ciphertext] = value.split('.');
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) }, await key(env), unbase64(ciphertext))));
}
export function configured(env) {
  return ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_OWNER_ID'].every(name => /^\d{17,20}$/.test(env[name] || '')) &&
    Boolean(env.DISCORD_CLIENT_SECRET && env.DISCORD_BOT_TOKEN && env.SESSION_KEY?.length >= 32);
}
const cookieName = (env, kind) => `${env.SITE_ORIGIN.startsWith('https:') ? '__Host-' : ''}mac_${kind}`;
export function cookie(env, kind, value, age) {
  return `${cookieName(env, kind)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${env.SITE_ORIGIN.startsWith('https:') ? '; Secure' : ''}`;
}
export function readCookie(request, env, kind) {
  const name = cookieName(env, kind);
  return (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
}
export function checkOrigin(request, env) {
  if (request.headers.get('Origin') !== env.SITE_ORIGIN) throw new HttpError(403, 'Reload the editor and try again.');
}
export async function limit(env, bucket, maximum, seconds) {
  const window = Math.floor(now() / seconds);
  const row = await env.DB.prepare('INSERT INTO rate_limits(bucket,count,expires) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count')
    .bind(`${bucket}:${window}`, (window + 1) * seconds).first();
  if (row.count > maximum) throw new HttpError(429, 'Too many requests. Please try again shortly.');
}
async function provider(fetcher, url, options) {
  const endpoint = url.includes('/oauth2/token') ? 'oauth-token' : url.endsWith('/roles') ? 'guild-roles' : url.includes('/members/') ? 'guild-member' : 'user-identity';
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(10000) }); }
    catch {
      console.warn('Discord request failed', { endpoint, status: 'network' });
      throw new HttpError(503, 'Discord is unavailable. Please try again shortly.', { code: 'DISCORD_UNAVAILABLE' });
    }
    if (!response.ok) console.warn('Discord request failed', { endpoint, status: response.status });
    if (response.status !== 429) return response;
    let data;
    try { data = await response.clone().json(); } catch { /* Retry-After may still be available. */ }
    const header = response.headers.get('Retry-After');
    const waits = [header === null ? NaN : Number(header), typeof data?.retry_after === 'number' ? data.retry_after : NaN].filter(value => Number.isFinite(value) && value >= 0);
    const delay = waits.length ? Math.max(...waits) : null;
    // Retry only reads, once, for a short Discord-specified delay. Never replay
    // an OAuth authorization-code exchange or an editor mutation automatically.
    if (attempt === 0 && (!options?.method || options.method === 'GET') && delay !== null && delay <= 2) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, delay * 1000 + 50));
      continue;
    }
    const retryAfter = delay === null ? undefined : Math.max(1, Math.ceil(delay));
    throw new HttpError(503, retryAfter ? `Discord is limiting requests. Try again in ${retryAfter} seconds.` : 'Discord is limiting requests. Please try again shortly.', { code: 'DISCORD_RATE_LIMITED', retryAfter });
  }
}
export async function tokenRequest(env, fetcher, fields) {
  const response = await provider(fetcher, 'https://discord.com/api/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, ...fields }),
  });
  if (response.status >= 500) throw new HttpError(503, 'Discord sign-in is temporarily unavailable. Please try again shortly.', { code: 'DISCORD_UNAVAILABLE' });
  if (!response.ok) throw new HttpError(401, 'Please sign in with Discord again.', { code: 'SIGN_IN_REQUIRED' });
  const data = await response.json();
  if (!data.access_token || !data.refresh_token) throw new HttpError(503, 'Discord sign-in could not be completed.');
  return { access: data.access_token, refresh: data.refresh_token, expires: now() + Number(data.expires_in || 3600) };
}
export async function session(request, env) {
  if (!configured(env)) return null;
  const token = readCookie(request, env, 'session');
  if (!token || token.length > 150) return null;
  return env.DB.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').bind(await hash(token), now()).first();
}
export async function authorize(request, env, fetcher) {
  const current = await session(request, env);
  if (!current) throw new HttpError(401, 'Sign in with Discord to edit your page.');
  await limit(env, `requests:${current.user_id}`, 120, 60);
  let credentials;
  try { credentials = await unseal(current.credentials, env); }
  catch { throw new HttpError(401, 'Please sign in with Discord again.'); }
  if (credentials.expires <= now() + 30) {
    credentials = await tokenRequest(env, fetcher, { grant_type: 'refresh_token', refresh_token: credentials.refresh });
    await env.DB.prepare('UPDATE sessions SET credentials=? WHERE token_hash=?').bind(await seal(credentials, env), current.token_hash).run();
  }
  // Fresh membership and role names on every privileged request: role removal takes effect on the next save.
  const [member, roles] = await Promise.all([
    provider(fetcher, `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${current.user_id}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } }),
    provider(fetcher, `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/roles`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } }),
  ]);
  if (member.status === 404) {
    const error = await member.clone().json().catch(() => ({}));
    if (error.code === 10007) throw new HttpError(403, 'You must be a member of the server Discord to edit.', { code: 'DISCORD_MEMBERSHIP_REQUIRED' });
  }
  if ([401, 403, 404].includes(member.status) || [401, 403, 404].includes(roles.status)) throw new HttpError(503, 'The wiki bot cannot access the Discord server. The owner needs to check its configuration.', { code: 'DISCORD_BOT_CONFIGURATION' });
  if (!member.ok || !roles.ok) throw new HttpError(503, 'Discord permission checks are temporarily unavailable. Please try again shortly.', { code: 'DISCORD_UNAVAILABLE' });
  let membership, guildRoles;
  try { membership = await member.json(); guildRoles = await roles.json(); } catch { /* Fail closed on malformed upstream responses. */ }
  if (membership?.user?.id !== current.user_id || !Array.isArray(membership?.roles) || !membership.roles.every(id => typeof id === 'string') || !Array.isArray(guildRoles) || !guildRoles.every(role => typeof role.id === 'string' && typeof role.name === 'string')) throw new HttpError(503, 'Discord returned an unreadable permission check. Please try again shortly.', { code: 'DISCORD_UNAVAILABLE' });
  const ids = new Set(membership.roles);
  const names = guildRoles.filter(role => role.id !== env.DISCORD_GUILD_ID && ids.has(role.id)).map(role => role.name);
  return { ...current, owner: current.user_id === env.DISCORD_OWNER_ID, roles: names };
}
export const mayEdit = (user, player) => user.owner || user.roles.some(role => role.toLowerCase() === player.name.toLowerCase());
export function checkCsrf(request, user) {
  if (request.headers.get('X-CSRF-Token') !== user.csrf) throw new HttpError(403, 'Reload the editor and try again.');
}
const returnPath = value => value === '/coordinates/' || /^\/wiki\/players\/[a-z0-9_-]{1,50}\/$/.test(value || '') ? value : '/account/';

export async function login(request, env) {
  if (!configured(env)) throw new HttpError(503, 'Discord editing is not configured yet.');
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  await limit(env, `login:${await hash(address)}`, 10, 600);
  const state = random();
  const requestedReturn = new URL(request.url).searchParams.get('returnTo');
  const returnTo = returnPath(requestedReturn);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires<?').bind(now()),
    env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now()),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(now()),
    env.DB.prepare('INSERT INTO oauth_states(token_hash,expires,return_to) VALUES (?,?,?)').bind(await hash(state), now() + 600, returnTo),
  ]);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify guilds.members.read', redirect_uri: `${env.SITE_ORIGIN}/auth/callback/`, state }).toString();
  return new Response(null, { status: 302, headers: { Location: url.href, 'Set-Cookie': cookie(env, 'oauth', state, 600), 'Cache-Control': 'no-store' } });
}
export async function callback(request, env, fetcher) {
  if (!configured(env)) throw new HttpError(503, 'Discord editing is not configured yet.');
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state || state !== readCookie(request, env, 'oauth')) throw new HttpError(400, 'Sign-in expired. Please try again.');
  const consumed = await env.DB.prepare('DELETE FROM oauth_states WHERE token_hash=? AND expires>? RETURNING token_hash,return_to').bind(await hash(state), now()).first();
  if (!consumed) throw new HttpError(400, 'Sign-in expired. Please try again.');
  if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new HttpError(400, 'Discord sign-in was cancelled.');
  const credentials = await tokenRequest(env, fetcher, { grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${env.SITE_ORIGIN}/auth/callback/` });
  const response = await provider(fetcher, 'https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${credentials.access}` } });
  if (!response.ok) throw new HttpError(503, 'Discord sign-in could not be completed.');
  const user = await response.json();
  if (!/^\d{17,20}$/.test(user.id)) throw new HttpError(503, 'Discord sign-in could not be completed.');
  const token = random();
  const csrf = random();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,display_name,credentials,csrf,expires) VALUES (?,?,?,?,?,?)')
    .bind(await hash(token), user.id, user.global_name || user.username, await seal(credentials, env), csrf, now() + 86400 * 7).run();
  const headers = new Headers({ Location: `${env.SITE_ORIGIN}${returnPath(consumed.return_to)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  headers.append('Set-Cookie', cookie(env, 'session', token, 86400 * 7));
  headers.append('Set-Cookie', cookie(env, 'oauth', '', 0));
  return new Response(null, { status: 302, headers });
}

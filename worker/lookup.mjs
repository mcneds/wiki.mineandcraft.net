import { HttpError } from './auth.mjs';

async function json(fetcher, url) {
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(10000) }); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'Player lookup is unavailable. Please try again shortly.'); }
  if (response.status === 404 || response.status === 204) throw new HttpError(404, 'Player not found. Check the name and edition.');
  if (!response.ok) throw new HttpError(503, 'Player lookup is unavailable. Please try again shortly.');
  try { return await response.json(); }
  catch { throw new HttpError(503, 'Player lookup returned an unreadable response. Please try again shortly.'); }
}
async function javaProfile(query, fetcher) {
  try { return await json(fetcher, `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(query)}`); }
  catch (error) {
    // Mojang's edge blocks some Cloudflare egress IPs with HTTP 403. Retain
    // authoritative not-found results, but fall back on availability failures.
    if (!(error instanceof HttpError) || error.status !== 503) throw error;
    const cached = await json(async (url, options) => {
      const response = await fetcher(url, { ...options, headers: { 'User-Agent': 'mineandcraft.net Wiki (https://wiki.mineandcraft.net)' } });
      if (response.status === 400) throw new HttpError(404, 'Player not found. Check the name and edition.');
      return response;
    }, `https://playerdb.co/api/player/minecraft/${encodeURIComponent(query)}`);
    const player = cached.success === true && cached.data?.player;
    if (!player || typeof player.username !== 'string' || player.username.toLowerCase() !== query.toLowerCase()) throw new HttpError(503, 'The Java name could not be verified. Please try again shortly.');
    return { name: player.username, id: player.raw_id || player.id?.replaceAll('-', '') };
  }
}
export function png(bytes) {
  if (bytes.length < 24 || bytes.length > 262144 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) throw new HttpError(400, 'Choose a PNG image smaller than 256 KB.');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!data.getUint32(16) || !data.getUint32(20) || data.getUint32(16) > 2048 || data.getUint32(20) > 2048) throw new HttpError(400, 'The head image must be no larger than 1024 × 1024.');
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.slice(i, i + 8192));
  return btoa(result);
}
export async function lookup(input, fetcher) {
  const edition = input.edition;
  const query = String(input.name || '').trim();
  let name, id, headId;
  if (edition === 'java') {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(query)) throw new HttpError(400, 'Enter a Java username with 3–16 letters, numbers, or underscores.');
    const profile = await javaProfile(query, fetcher);
    if (!/^[A-Za-z0-9_]{3,16}$/.test(profile.name) || !/^[a-f0-9]{32}$/i.test(profile.id)) throw new HttpError(404, 'Player not found.');
    name = profile.name; id = profile.id.toLowerCase(); headId = id;
  } else if (edition === 'bedrock') {
    if (!/^[A-Za-z0-9 _]{1,16}$/.test(query)) throw new HttpError(400, 'Enter the Bedrock Xbox gamertag without the Floodgate prefix.');
    const profile = await json(fetcher, `https://api.geysermc.org/v2/xbox/xuid/${encodeURIComponent(query)}`);
    if (!/^\d{1,20}$/.test(String(profile.xuid))) throw new HttpError(404, 'Bedrock player not found.');
    id = String(profile.xuid);
    const canonical = await json(fetcher, `https://api.geysermc.org/v2/xbox/gamertag/${id}`);
    if (typeof canonical.gamertag !== 'string' || !/^[A-Za-z0-9 _]{1,16}$/.test(canonical.gamertag)) throw new HttpError(503, 'The Bedrock name could not be verified. Try again later.');
    name = canonical.gamertag;
    const skin = await json(fetcher, `https://api.geysermc.org/v2/skin/${id}`);
    if (!skin.texture_id) throw new HttpError(404, 'No Bedrock skin is available yet. Ask the player to join through Geyser first, then retry.');
    headId = BigInt(id).toString(16).padStart(32, '0');
  } else throw new HttpError(400, 'Choose Java or Bedrock.');
  let head;
  try { head = await fetcher(`https://mc-heads.net/head/${headId}/256`, { signal: AbortSignal.timeout(10000) }); }
  catch { throw new HttpError(503, 'The player head could not be fetched. Please try again shortly.'); }
  if (!head.ok || !head.headers.get('Content-Type')?.includes('image/png')) throw new HttpError(503, 'The player head could not be fetched.');
  const image = png(new Uint8Array(await head.arrayBuffer()));
  return { name, edition, minecraft_id: `${edition}:${id}`, head_png: image, preview: `data:image/png;base64,${image}` };
}

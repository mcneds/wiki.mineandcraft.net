import { HttpError, hash } from './auth.mjs';
const json = value => Response.json(value, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export async function serverStatus(request, env, body) {
  if (request.method === 'GET' && new URL(request.url).pathname === '/api/server-status/') {
    const row = await env.DB.prepare('SELECT availability,players,capacity,received FROM server_status WHERE id=1').first();
    if (!row || Date.now() - row.received > 45000) return json({ availability: 'unavailable', players: [], online: null, capacity: null, updated: row?.received ?? null });
    const players = row.availability === 'online' ? JSON.parse(row.players) : [];
    return json({ availability: row.availability, players, online: row.availability === 'online' ? players.length : null, capacity: row.capacity, updated: row.received });
  }
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/server-status/report/') throw new HttpError(405, 'Unsupported status action.');
  const token = request.headers.get('Authorization')?.match(/^Bearer (.{32,256})$/)?.[1];
  if (!token || !env.SERVER_STATUS_KEY || await hash(token) !== await hash(env.SERVER_STATUS_KEY)) throw new HttpError(401, 'Status authentication failed.');
  if (!['online', 'offline', 'unavailable'].includes(body.availability) || !Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 10000 || !Array.isArray(body.players) || body.players.length > 10000 || body.players.some(name => typeof name !== 'string' || !name.length || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) || (body.availability !== 'online' && body.players.length)) throw new HttpError(400, 'Invalid server status.');
  const players = [...body.players].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  await env.DB.prepare('INSERT INTO server_status(id,availability,players,capacity,received) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET availability=excluded.availability,players=excluded.players,capacity=excluded.capacity,received=excluded.received').bind(body.availability, JSON.stringify(players), body.capacity, Date.now()).run();
  return json({ recorded: true });
}

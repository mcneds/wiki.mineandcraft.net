import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot, writeSnapshot } from '../worker/live-snapshots.mjs';
import { serverStatus } from '../worker/server-status.mjs';

function storage() {
  const objects = new Map();
  return { MEDIA: {
    async put(key, value) { objects.set(key, value); },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
  } };
}
const quota = () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit."); };

test('live snapshots survive the write cap and switch back to newer database reports', async () => {
  const env = storage();
  for (const name of ['server-status', 'player-stats']) {
    const row = { received: 20, players: '["Player"]' };
    await writeSnapshot(env, name, row, quota);
    assert.deepEqual(await readSnapshot(env, name, async () => ({ received: 10 })), row);
    assert.deepEqual(await readSnapshot(env, name, async () => null), row);
    const next = { received: 30, players: '[]' };
    let saved;
    await writeSnapshot(env, name, next, async () => { saved = next; });
    assert.deepEqual(await readSnapshot(env, name, async () => saved), next);
  }
});

test('unrelated storage failures are not disguised as quota errors', async () => {
  await assert.rejects(writeSnapshot(storage(), 'server-status', {}, () => { throw new Error('no such table'); }), /no such table/);
  await assert.rejects(writeSnapshot({}, 'server-status', {}, quota), /daily row write limit/);
});

test('authenticated status reports stay live during the quota outage and still expire', async () => {
  const env = { ...storage(), SERVER_STATUS_KEY: 'status-key-for-regression-test-1234567890',
    DB: { prepare: () => ({ first: async () => null, bind: () => ({ run: quota }) }) } };
  const body = { availability: 'online', players: ['Tester'], capacity: 20 };
  const post = key => new Request('https://wiki.test/api/server-status/report/', { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
  await assert.rejects(serverStatus(post('incorrect'), env, body), /authentication/);
  await serverStatus(post(env.SERVER_STATUS_KEY), env, body);
  const get = () => serverStatus(new Request('https://wiki.test/api/server-status/'), env);
  assert.equal((await (await get()).json()).availability, 'online');
  await writeSnapshot(env, 'server-status', { ...body, players: JSON.stringify(body.players), received: Date.now() - 46000 }, quota);
  assert.equal((await (await get()).json()).availability, 'unavailable');
});

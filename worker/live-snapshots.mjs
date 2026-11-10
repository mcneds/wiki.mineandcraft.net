// Status snapshots can survive D1's daily write cap in the existing R2 bucket.
// Always select the newest copy so normal D1 reporting resumes after the reset.
export async function readSnapshot(env, name, readDatabase) {
  const row = await readDatabase();
  const object = await env.MEDIA?.get(`live-snapshots/${name}.json`);
  const fallback = object ? await new Response(object.body).json() : null;
  return fallback && (!row || fallback.received > row.received) ? fallback : row;
}

export async function writeSnapshot(env, name, row, writeDatabase) {
  try {
    await writeDatabase();
  } catch (error) {
    const message = `${error} ${error?.cause || ''}`;
    if (!env.MEDIA || !/daily.*(?:row.*)?write.*limit/i.test(message)) throw error;
    await env.MEDIA.put(`live-snapshots/${name}.json`, new TextEncoder().encode(JSON.stringify(row)), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
  }
}

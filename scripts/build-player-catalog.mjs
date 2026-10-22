import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}
const root = path.resolve('src/content/articles');
const catalog = [];
for (const file of await walk(root)) {
  if (!file.endsWith('.md')) continue;
  const text = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
  if (/^draft: true$/m.test(header) || /^category: "Players"$/m.test(header)) continue;
  const field = name => header.match(new RegExp(`^${name}: "(.*)"$`, 'm'))?.[1];
  const id = path.relative(root, file).split(path.sep).join('/').replace(/\.md$/, '');
  catalog.push({ title: field('title'), description: field('description'), url: `/wiki/${id}/` });
}
await mkdir('worker', { recursive: true });
await writeFile('worker/catalog.generated.json', JSON.stringify(catalog));
console.log(`Prepared ${catalog.length} static articles for the live player index.`);

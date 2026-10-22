import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : path.join(dir, entry.name)));
  return files.flat();
}
const files = (await walk(root)).filter(f => f.endsWith('.html'));
const cache = new Map();
const errors = [];
const workerRoutes = new Set(['/auth/login/']);
for (const file of files) cache.set(file, await readFile(file, 'utf8'));
for (const [file, html] of cache) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const url = new URL(relative.endsWith('index.html') ? relative.slice(0, -10) : relative, 'https://local.test/');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(?:https?:|mailto:|data:|javascript:|\/\/)/.test(match[1])) continue;
    const link = new URL(match[1].replaceAll('&amp;', '&'), url);
    if (workerRoutes.has(link.pathname) && !link.hash) continue;
    let target = path.join(root, decodeURIComponent(link.pathname));
    try { if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html'); await stat(target); }
    catch { errors.push(`${relative}: missing ${match[1]}`); continue; }
    if (link.hash && target.endsWith('.html')) {
      const body = cache.get(target) ?? await readFile(target, 'utf8');
      const id = decodeURIComponent(link.hash.slice(1));
      if (!body.includes(`id="${id}"`)) errors.push(`${relative}: missing anchor ${match[1]}`);
    }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`Verified internal links, images, and anchors in ${files.length} HTML pages.`);

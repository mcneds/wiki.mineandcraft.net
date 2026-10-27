// Import recipe data and render the mod's cuboid inventory models with their own textures.
// Usage: node scripts/import-copper-speakers.mjs MOD_PROJECT MINECRAFT_CLIENT_JAR
// Requires Python (ZIP reading only) and Playwright's Chromium or installed Edge.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const [project, jar] = process.argv.slice(2);
if (!project || !jar) throw new Error('Provide the Copper Speakers project and Minecraft client JAR paths.');
const root = fileURLToPath(new URL('../', import.meta.url));
const resources = resolve(project, 'src/main/resources');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const models = { copper_wire: 'block/wire_15', speaker: 'block/speaker', wall_plate: 'item/wall_plate' };
const recipesPath = resolve(root, 'src/data/recipes.json');
const catalog = readJson(recipesPath);
const vanilla = JSON.parse(execFileSync('python', ['-c',
  'import sys,json,base64,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({p:base64.b64encode(z.read(p)).decode() for p in json.loads(sys.argv[2])}))',
  resolve(jar), JSON.stringify([
    'assets/minecraft/models/block/block.json',
    ...['note_block', 'copper_block', 'resin_block', 'black_concrete', 'iron_block'].map(name => `assets/minecraft/textures/block/${name}.png`),
  ])], { encoding: 'utf8' }));
const parent = JSON.parse(Buffer.from(vanilla['assets/minecraft/models/block/block.json'], 'base64'));
const nice = id => id.split(':')[1].split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
const item = id => ({ item: id, name: nice(id) });

for (const name of ['paper', 'note_block']) {
  const source = `${catalog.renderSource.repository.replace('github.com', 'raw.githubusercontent.com')}/${catalog.renderSource.commit}/item-assets/${name.toUpperCase()}.png`;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Cannot download ${name}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${name}`);
  writeFileSync(resolve(root, `public/images/items/${name}.png`), bytes);
}

const browserServer = await chromium.launchServer({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true });
const browser = await chromium.connect(browserServer.wsEndpoint());
try {
  const page = await browser.newPage();
  for (const [name, modelPath] of Object.entries(models)) {
    const model = readJson(resolve(resources, `assets/copper_speakers/models/${modelPath}.json`));
    const textures = {};
    for (const value of Object.values(model.textures).filter(value => !value.startsWith('#'))) {
      const [namespace, path] = value.split(':');
      const asset = `assets/${namespace}/textures/${path}.png`;
      textures[value] = `data:image/png;base64,${namespace === 'minecraft' ? vanilla[asset] : readFileSync(resolve(resources, asset)).toString('base64')}`;
    }
    const png = await page.evaluate(async ({ model, textures, gui }) => {
      // Orthographic rasterization with a depth buffer, nearest-neighbor UV sampling,
      // and the model's actual GUI rotation/scale. No generated or substituted artwork.
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      const output = context.createImageData(size, size);
      const depth = new Float64Array(size * size).fill(-Infinity);
      const pixels = {};
      for (const [id, url] of Object.entries(textures)) {
        const image = new Image(); image.src = url; await image.decode();
        const texture = document.createElement('canvas'); texture.width = image.width; texture.height = image.height;
        const ctx = texture.getContext('2d'); ctx.drawImage(image, 0, 0);
        pixels[id] = { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
      }
      const radians = (gui.rotation || [0, 0, 0]).map(value => value * Math.PI / 180);
      const rotate = ([x, y, z]) => {
        const [rx, ry, rz] = radians;
        [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
        [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
        return [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz), z];
      };
      const projectRaw = point => {
        const p = rotate(point.map((value, i) => (value - 8) * (gui.scale?.[i] ?? 1)));
        return [size / 2 + (p[0] + (gui.translation?.[0] ?? 0)) * size / 16,
          size / 2 - (p[1] + (gui.translation?.[1] ?? 0)) * size / 16, p[2]];
      };
      // Fit the visible model to a centered wiki icon, including very flat wire.
      const bounds = model.elements.flatMap(({ from, to }) =>
        [from[0], to[0]].flatMap(x => [from[1], to[1]].flatMap(y => [from[2], to[2]].map(z => projectRaw([x, y, z])))));
      const minX = Math.min(...bounds.map(p => p[0])), maxX = Math.max(...bounds.map(p => p[0]));
      const minY = Math.min(...bounds.map(p => p[1])), maxY = Math.max(...bounds.map(p => p[1]));
      const fit = (size - 12) / Math.max(maxX - minX, maxY - minY);
      const project = point => {
        const [x, y, z] = projectRaw(point);
        return [(x - (minX + maxX) / 2) * fit + size / 2, (y - (minY + maxY) / 2) * fit + size / 2, z];
      };
      const normals = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
      for (const element of model.elements) {
        if (element.rotation) throw new Error('Rotated model elements require extending the renderer.');
        const [x0, y0, z0] = element.from, [x1, y1, z1] = element.to;
        // Top-left, top-right, bottom-left vertices and Minecraft's default face UVs.
        const faces = {
          north: [[[x1,y1,z0],[x0,y1,z0],[x1,y0,z0]], [16-x1,16-y1,16-x0,16-y0]],
          south: [[[x0,y1,z1],[x1,y1,z1],[x0,y0,z1]], [x0,16-y1,x1,16-y0]],
          east: [[[x1,y1,z1],[x1,y1,z0],[x1,y0,z1]], [16-z1,16-y1,16-z0,16-y0]],
          west: [[[x0,y1,z0],[x0,y1,z1],[x0,y0,z0]], [z0,16-y1,z1,16-y0]],
          up: [[[x0,y1,z0],[x1,y1,z0],[x0,y1,z1]], [x0,z0,x1,z1]],
          down: [[[x0,y0,z1],[x1,y0,z1],[x0,y0,z0]], [x0,16-z1,x1,16-z0]],
        };
        for (const [side, face] of Object.entries(element.faces)) {
          const normal = rotate(normals[side]);
          if (normal[2] <= 0) continue;
          if (face.rotation) throw new Error('Rotated UVs require extending the renderer.');
          let texture = face.texture;
          while (texture.startsWith('#')) texture = model.textures[texture.slice(1)];
          const tex = pixels[texture];
          const [vertices, defaults] = faces[side];
          const [a, b, c] = vertices.map(project);
          const u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
          const det = u[0] * v[1] - u[1] * v[0];
          const uv = face.uv || defaults;
          const shade = Math.min(1, Math.max(0.55, 0.75 + normal[1] * 0.2 - normal[0] * 0.15));
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const dx = x + 0.5 - a[0], dy = y + 0.5 - a[1];
            const s = (dx * v[1] - dy * v[0]) / det, t = (dy * u[0] - dx * u[1]) / det;
            if (s < 0 || s >= 1 || t < 0 || t >= 1) continue;
            const z = a[2] + s * u[2] + t * v[2], index = y * size + x;
            if (z < depth[index]) continue;
            const tx = Math.max(0, Math.min(tex.width - 1, Math.floor((uv[0] + s * (uv[2] - uv[0])) / 16 * tex.width)));
            const ty = Math.max(0, Math.min(tex.height - 1, Math.floor((uv[1] + t * (uv[3] - uv[1])) / 16 * tex.height)));
            const offset = (ty * tex.width + tx) * 4;
            if (!tex.data[offset + 3]) continue;
            depth[index] = z;
            for (let channel = 0; channel < 3; channel++) output.data[index * 4 + channel] = tex.data[offset + channel] * shade;
            output.data[index * 4 + 3] = tex.data[offset + 3];
          }
        }
      }
      context.putImageData(output, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { model, textures, gui: model.display?.gui || parent.display.gui });
    writeFileSync(resolve(root, `public/images/items/${name}.png`), Buffer.from(png, 'base64'));

    const source = `data/copper_speakers/recipe/${name}.json`;
    const recipe = readJson(resolve(resources, source));
    const slots = Array(9).fill(null);
    recipe.pattern.forEach((row, y) => [...row].forEach((key, x) => { if (key !== ' ') slots[y * 3 + x] = item(recipe.key[key]); }));
    const result = { ...item(recipe.result.id), count: recipe.result.count ?? 1 };
    const counts = new Map();
    slots.filter(Boolean).forEach(slot => counts.set(slot.name, (counts.get(slot.name) || 0) + 1));
    catalog.recipes[`copper_speakers:${name}`] = {
      type: recipe.type.replace('minecraft:', ''), group: 'Copper Speakers', slots, result,
      summary: [...counts].map(([name, count]) => `${count} ${name}`).join(', ') + ` → ${result.count} ${result.name}`,
      source,
    };
    console.log(`Imported ${name}: recipe and 128px inventory render`);
  }
  catalog.modSources = { ...catalog.modSources, copper_speakers: { name: 'Copper Speakers', version: '0.1.7', minecraft: '26.3', recipes: 'Bundled recipe JSON', images: 'Inventory model JSON, Minecraft textures, and the mod speaker-front texture' } };
  writeFileSync(recipesPath, JSON.stringify(catalog, null, 2).replace(/[^\x00-\x7f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
  console.log('Saved recipe catalog.');
} finally { await browserServer.kill(); }

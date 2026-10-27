"""Derive crafting grids from the owner's ZIP and cache original item renders.

Usage: python scripts/import-recipes.py PATH_TO_ZIP
Images are copied unchanged from a pinned mc-assets commit, never hotlinked.
"""
from pathlib import Path
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RENDER_COMMIT = '798494f03c20bbb577dd7fcd10e8737dbc0dfc0a'
RENDER_BASE = f'https://raw.githubusercontent.com/Owen1212055/mc-assets/{RENDER_COMMIT}/item-assets'
archive = Path(sys.argv[1]).resolve()
recipes = {}
icons = set()

def nice(item):
    return item.split(':')[-1].replace('_', ' ').title()

def group_for(path):
    if '/slabs/' in path and path.startswith('data/minecraft/'): return 'Double Slabs'
    namespace = path.split('/')[1]
    groups = {
        'rotten_flesh_to_leather': 'Rotten Flesh to Leather',
        'craftable_notch_apples': 'Enchanted Golden Apples',
        'flint_to_gravel': 'Craftable Gravel',
        'uncraftable_ice': 'Unpackable Ice',
        'wool_to_string': 'Unpackable Wool',
        'slabs_stairs_to_block': 'Back to Blocks',
        'powder_to_glass': 'Powder to Glass',
    }
    if namespace in groups: return groups[namespace]
    if path.endswith('_stairs.json'): return 'More Stairs'
    if path.endswith('_trapdoor.json'): return 'More Trapdoors'
    if path.endswith('/packed_ice.json'): return 'Unpackable Ice'
    return 'More Bricks'

with zipfile.ZipFile(archive) as bundle:
    def ingredient(value):
        if isinstance(value, list):
            choices = [ingredient(v) for v in value]
            return choices[0] if len(choices) == 1 else {
                **choices[0], 'name': ' or '.join(v['name'] for v in choices),
                'alternatives': [v['item'] for v in choices],
            }
        if isinstance(value, dict):
            return ingredient(value.get('item') or '#' + value['tag'])
        if value.startswith('#'):
            tag = value[1:]
            if tag == 'minecraft:wool':
                item = 'minecraft:white_wool'
                icons.add('white_wool')
                return {'item': item, 'name': 'Any wool', 'tag': tag}
            namespace, name = tag.split(':')
            tag_data = json.loads(bundle.read(f'data/{namespace}/tags/item/{name}.json'))
            resolved = ingredient(tag_data['values'])
            return {**resolved, 'tag': tag}
        item = value if ':' in value else 'minecraft:' + value
        icons.add(item.split(':')[-1])
        return {'item': item, 'name': nice(item)}

    for path in bundle.namelist():
        if '/recipe/' not in path or not path.endswith('.json'): continue
        data = json.loads(bundle.read(path))
        namespace = path.split('/')[1]
        recipe_id = namespace + ':' + path.split('/recipe/')[1].removesuffix('.json')
        kind = data['type'].replace('minecraft:', '')
        slots = [None] * 9
        if kind == 'crafting_shaped':
            for row, line in enumerate(data['pattern']):
                for col, char in enumerate(line):
                    if char != ' ': slots[row * 3 + col] = ingredient(data['key'][char])
        elif kind == 'crafting_shapeless':
            for index, value in enumerate(data['ingredients']): slots[index] = ingredient(value)
        elif kind == 'smelting': slots[0] = ingredient(data['ingredient'])
        else: raise ValueError(f'Unsupported recipe type: {kind}')
        result = {**ingredient(data['result']['id']), 'count': data['result'].get('count', 1)}
        counts = Counter(slot['name'] for slot in slots if slot)
        recipes[recipe_id] = {
            'type': kind, 'group': group_for(path), 'slots': slots, 'result': result,
            'summary': ', '.join(f'{count} {name}' for name, count in counts.items()) + f' → {result["count"]} {result["name"]}',
            'source': path,
        }
        for key in ['experience', 'cookingtime']:
            if key in data: recipes[recipe_id][key] = data[key]

assert len(recipes) == 409, f'Review changed archive: {len(recipes)} recipes.'

def item(name, count=1):
    icons.add(name)
    return {'item': 'minecraft:' + name, 'name': nice(name), 'count': count}

processes = {
    'conversion:cauldron-concrete': {
        'type': 'conversion', 'method': 'Drop into a water cauldron',
        'inputs': [item('white_concrete_powder')], 'station': item('cauldron'),
        'result': item('white_concrete'), 'summary': 'White Concrete Powder → White Concrete',
    },
    'conversion:cauldron-mud': {
        'type': 'conversion', 'method': 'Drop into a water cauldron',
        'inputs': [item('dirt')], 'station': item('cauldron'),
        'result': item('mud'), 'summary': 'Dirt → Mud',
    },
    'conversion:loadstone': {
        'type': 'conversion', 'method': 'Drop a nether star above a placed lodestone',
        'inputs': [item('nether_star')], 'station': item('lodestone'),
        'result': {**item('lodestone'), 'name': 'Loadstone'},
        'summary': 'Nether Star + placed Lodestone → Loadstone',
    },
}
icons.update(['furnace'])
target = ROOT / 'src/data/recipes.json'
existing = json.loads(target.read_text(encoding='utf-8')) if target.exists() else {}
mod_sources = existing.get('modSources', {})
mod_recipes = {key: value for key, value in existing.get('recipes', {}).items()
               if key.split(':')[0] in mod_sources}
payload = {
    'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'renderSource': {'repository': 'https://github.com/Owen1212055/mc-assets', 'commit': RENDER_COMMIT},
    'recipes': {**recipes, **processes, **mod_recipes},
}
if mod_sources:
    payload['modSources'] = mod_sources
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')

image_dir = ROOT / 'public/images/items'
image_dir.mkdir(parents=True, exist_ok=True)
def download(name):
    path = image_dir / f'{name}.png'
    if path.exists(): return
    request = urllib.request.Request(f'{RENDER_BASE}/{name.upper()}.png', headers={'User-Agent': 'mineandcraft-wiki'})
    image = urllib.request.urlopen(request, timeout=30).read()
    if not image.startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError(f'Not a PNG: {name}')
    path.write_bytes(image)

with ThreadPoolExecutor(max_workers=6) as pool:
    list(pool.map(download, sorted(icons)))

order = ['Double Slabs', 'Rotten Flesh to Leather', 'More Bricks', 'More Stairs', 'More Trapdoors', 'Enchanted Golden Apples', 'Unpackable Ice', 'Unpackable Wool', 'Craftable Gravel', 'Back to Blocks', 'Powder to Glass']
reference = '''---
title: "Recipe reference"
description: "Crafting grids, furnace recipes, ingredients, and output quantities."
category: "Crafting"
updated: "2026-10-22"
---
[Crafting tweaks](/wiki/crafting-tweaks/) explains each change. Shapeless ingredients can be placed anywhere in the crafting grid. Hover over an item to see its name.

For copper wire, speakers, and wall plates, see the [Copper Speakers crafting recipes](/wiki/copper-speakers/#crafting).

'''
for group in order:
    entries = sorted(((key, data) for key, data in recipes.items() if data['group'] == group), key=lambda pair: (pair[1]['result']['name'], pair[0]))
    reference += f'## {group}\n\n'
    for key, data in entries:
        reference += f'```recipe\n{key}\n```\n\n'
(ROOT / 'src/content/articles/recipe-reference.md').write_text(reference.rstrip() + '\n', encoding='utf-8')
print(f'Prepared {len(recipes)} recipe grids, {len(processes)} conversions, and {len(icons)} local item renders.')

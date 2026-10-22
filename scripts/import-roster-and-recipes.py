"""Import the owner's PNG roster and derive recipe documentation from their ZIP.

Usage: python scripts/import-roster-and-recipes.py PATH_TO_MACNET
Existing player biographies are preserved. Recipe reference is regenerated.
"""
from pathlib import Path
from collections import Counter
import sys
import json
import shutil
import zipfile
import hashlib

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]).resolve()
heads = root / 'public' / 'images' / 'players'
players = root / 'src' / 'content' / 'articles' / 'players'
heads.mkdir(parents=True, exist_ok=True)
players.mkdir(parents=True, exist_ok=True)
for image in sorted(source.glob('*.png')):
    ign = image.stem
    if not ign.replace('_', '').isalnum():
        raise ValueError(f'Check player filename: {image.name}')
    shutil.copy2(image, heads / image.name)
    target = players / f'{ign}.md'
    if target.exists():
        continue
    target.write_text(f'''---
title: "{ign}"
description: "{ign}'s player page on mineandcraft.net."
category: "Players"
updated: "2026-10-22"
image: "/images/players/{ign}.png"
facts:
  - label: "In-game name"
    value: "{ign}"
  - label: "Community"
    value: "mineandcraft.net"
---
**{ign}** is a player in the mineandcraft.net community.

## About

This player's story has not been recorded yet.

## Builds & projects

No builds or projects have been documented here yet.

## Lore

No events have been linked to this player yet. Visit [Lore](/lore/) for the server's shared history.

## See also

- [All players](/players/)
- [Getting started](/wiki/getting-started/)

*In-game name and head image supplied by the server owner.*
''', encoding='utf-8')

archive = source / 'VanillaTweaks_c223234_MC26.3.zip'
def friendly(value):
    if isinstance(value, list):
        return ' or '.join(friendly(v) for v in value)
    if isinstance(value, dict):
        return friendly(value.get('item', value.get('tag', str(value))))
    tag = value.startswith('#')
    value = value.lstrip('#').replace('minecraft:', '').replace('_', ' ')
    return ('any ' if tag else '') + value

rows = []
with zipfile.ZipFile(archive) as bundle:
    selected = bundle.read('Selected Packs.txt').decode().split('Packs:')[1].strip().splitlines()
    for name in bundle.namelist():
        if '/recipe/' not in name or not name.endswith('.json'):
            continue
        data = json.loads(bundle.read(name))
        output = data['result']
        result = f"{output.get('count', 1)} {friendly(output['id'])}"
        kind = data['type'].replace('minecraft:', '')
        pattern = ''
        if kind == 'crafting_shaped':
            counts = Counter(''.join(data['pattern']).replace(' ', ''))
            ingredients = ', '.join(f'{count} {friendly(data["key"][key])}' for key, count in counts.items())
            symbols = {key: chr(65+i) for i, key in enumerate(counts)}
            pattern = ' / '.join(''.join(symbols.get(c, '.') for c in line) for line in data['pattern'])
            legend = '; '.join(f'{symbols[key]} = {friendly(data["key"][key])}' for key in counts)
            arrangement = f'`{pattern}` ({legend}; `.` = empty)'
        elif kind == 'crafting_shapeless':
            counts = Counter(friendly(v) for v in data['ingredients'])
            ingredients = ', '.join(f'{count} {item}' for item, count in counts.items())
            arrangement = 'Any arrangement'
        else:
            ingredients = f"1 {friendly(data['ingredient'])}"
            arrangement = 'Furnace' if kind == 'smelting' else kind
        rows.append((result, ingredients, arrangement, name))
    assert len(rows) == 409, f'Archive changed: expected 409 recipes, found {len(rows)}. Review summaries.'
    assert len(selected) == 11, 'Archive selection changed. Review crafting-tweaks.md.'

content = '''---
title: "Recipe reference"
description: "Every recipe in the supplied Vanilla Tweaks crafting bundle, including exact ingredients and arrangements."
category: "Crafting"
updated: "2026-10-22"
---
This reference lists **409 recipe definitions** from the owner-supplied crafting bundle. For the shorter player guide, see [Crafting tweaks](/wiki/crafting-tweaks/).

## Reading the recipes

Quantities are per crafting operation. In a shaped recipe, `/` separates rows and `.` marks an empty slot. Letters stand for the ingredients given beside the pattern. Shapeless recipes accept any arrangement. “Any” before an ingredient indicates an item tag.

These are definitions in the supplied archive, not a report from a running server. A definition only works if its input and output items are available and the pack loads successfully in the installed game version.

## Recipes

'''
# Group by output initial so a long reference has usable contents anchors.
for initial in sorted(set(r[0].split(' ', 1)[1][0].upper() for r in rows)):
    content += f'### {initial}\n\n| Output | Ingredients | Arrangement | Recipe file |\n| --- | --- | --- | --- |\n'
    for result, ingredients, arrangement, name in sorted(rows, key=lambda r: (r[0].split(' ', 1)[1], r[3])):
        if result.split(' ', 1)[1][0].upper() == initial:
            content += f'| {result} | {ingredients} | {arrangement} | `{name}` |\n'
    content += '\n'
content += f'''## Source

Derived from `VanillaTweaks_c223234_MC26.3.zip`, provided by the owner. Original packs by [Vanilla Tweaks](https://vanillatweaks.net/).

Archive SHA-256: `{hashlib.sha256(archive.read_bytes()).hexdigest()}`.
'''
(root / 'src/content/articles/recipe-reference.md').write_text(content, encoding='utf-8')
print(f'Imported {len(list(source.glob("*.png")))} player heads; documented {len(rows)} recipe definitions.')

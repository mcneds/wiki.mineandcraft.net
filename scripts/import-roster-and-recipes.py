"""Import the owner's PNG roster and derive recipe documentation from their ZIP.

Usage: python scripts/import-roster-and-recipes.py PATH_TO_MACNET
Existing player biographies are preserved. Recipe reference is regenerated.
"""
from pathlib import Path
import sys
import shutil
import subprocess

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
---
## About

This player's story has not been recorded yet.

## Builds & projects

No builds or projects have been documented here yet.

## See also

- [All players](/players/)
- [Getting started](/wiki/getting-started/)
''', encoding='utf-8')

subprocess.run([
    sys.executable, str(root / 'scripts/import-recipes.py'),
    str(source / 'VanillaTweaks_c223234_MC26.3.zip'),
], check=True)
print(f'Imported {len(list(source.glob("*.png")))} player heads.')

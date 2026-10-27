"""Create vanilla command functions for a manual listening comparison in a lab world."""
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'src/main/resources/data/synclab/function'
root.mkdir(parents=True, exist_ok=True)
build = ['# Run while standing at the desired origin; only changes this local scene.',
         'fill ~-1 ~-1 ~2 ~15 ~-1 ~4 minecraft:copper_block']
for i in range(8):
    block = 'jukebox' if i == 0 else 'note_block'
    build.append(f'setblock ~{i * 2} ~ ~3 minecraft:{block}')
(root / 'build_demo.mcfunction').write_text('\n'.join(build) + '\n')
stop = [f'stopsound @a record synclab:{mode}' for mode in ('streamed', 'buffered', 'preloaded')]
(root / 'stop.mcfunction').write_text('\n'.join(stop) + '\n')
for mode in ('streamed', 'buffered', 'preloaded'):
    commands = ['function synclab:stop']
    commands += [f'playsound synclab:{mode} record @a ~{i * 2} ~ ~3 4 1' for i in range(8)]
    (root / f'start_{mode}.mcfunction').write_text('\n'.join(commands) + '\n')

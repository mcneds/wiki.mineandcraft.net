#!/usr/bin/env python3
"""Build against the exact installed Geyser jar; writes only to --output."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile


def build(server, source, output, javac):
    output.mkdir(parents=True, exist_ok=True)
    geyser = server / 'mods/Geyser-Fabric.jar'
    dependencies = [geyser, *sorted((server / 'libraries').rglob('*.jar'))]
    nested = output / 'dependencies'
    nested.mkdir(exist_ok=True)
    # Fabric may put dependencies inside the mod jar rather than on its root.
    with zipfile.ZipFile(geyser) as jar:
        for index, name in enumerate(jar.namelist()):
            if name.endswith('.jar'):
                path = nested / f'{index}.jar'
                path.write_bytes(jar.read(name))
                dependencies.append(path)
    classpath = os.pathsep.join(map(str, dependencies))
    (output / 'classpath.txt').write_text(classpath)
    classes = output / 'classes'
    classes.mkdir(exist_ok=True)
    result = subprocess.run([str(javac), '--release', '21', '-cp', classpath, '-d', str(classes),
                             *map(str, sorted((source / 'src').rglob('*.java')))])
    if result.returncode: raise SystemExit(result.returncode)
    catalogue = json.loads((server / 'config/copper-speakers/tails/catalog.json').read_text())
    events = []
    for original, track in sorted(catalogue['tracks'].items()):
        for entry in track['entries']:
            key = entry['event'].replace(':', '\\:')
            events.append(f'{key}={original}|{entry["offsetSeconds"]}')
    (classes / 'audio-events.properties').write_text('\n'.join(events) + '\n', encoding='ascii')
    shutil.copy2(source / 'extension.yml', classes / 'extension.yml')
    target = output / 'CopperBedrock-0.1.0.jar'
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as jar:
        for path in sorted(classes.rglob('*')):
            if path.is_file(): jar.write(path, path.relative_to(classes).as_posix())
    print(f'Built {target} with {len(events)} prepared-audio events')
    tests = sorted((source / 'test').rglob('*.java'))
    if tests:
        test_classes = output / 'test-classes'
        test_classes.mkdir(exist_ok=True)
        test_cp = str(classes) + os.pathsep + classpath
        result = subprocess.run([str(javac), '--release', '21', '-cp', test_cp, '-d', str(test_classes), *map(str, tests)])
        if result.returncode: raise SystemExit(result.returncode)
        subprocess.run([str(javac.with_name('java')), '-cp', str(test_classes) + os.pathsep + test_cp,
                        'net.mineandcraft.bedrockspeakers.ProtocolSmoke'], check=True)
    return classpath, classes


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--javac', type=Path, default=Path(shutil.which('javac') or 'javac'))
    args = parser.parse_args()
    build(args.server, args.source, args.output, args.javac)

#!/usr/bin/env python3
"""Build and test the standalone head extension against the installed Geyser."""
import argparse
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
    with zipfile.ZipFile(geyser) as jar:
        for index, name in enumerate(jar.namelist()):
            if name.endswith('.jar'):
                path = nested / f'{index}.jar'
                path.write_bytes(jar.read(name))
                dependencies.append(path)
    classpath = os.pathsep.join(map(str, dependencies))
    classes, tests = output / 'classes', output / 'test-classes'
    classes.mkdir(exist_ok=True)
    tests.mkdir(exist_ok=True)
    subprocess.run([str(javac), '--release', '21', '-cp', classpath, '-d', str(classes),
                    *map(str, sorted((source / 'src').rglob('*.java')))], check=True)
    test_cp = str(classes) + os.pathsep + classpath
    subprocess.run([str(javac), '--release', '21', '-cp', test_cp, '-d', str(tests),
                    *map(str, sorted((source / 'test').rglob('*.java')))], check=True)
    subprocess.run([str(javac.with_name('java')), '-cp', str(tests) + os.pathsep + test_cp,
                    'net.mineandcraft.heads.geyser.ProtocolSmoke'], check=True)
    shutil.copy2(source / 'extension.yml', classes / 'extension.yml')
    target = output / 'MineAndCraftHeads-1.0.0.jar'
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as jar:
        for path in sorted(classes.rglob('*')):
            if path.is_file():
                jar.write(path, path.relative_to(classes).as_posix())
    print(f'Built {target}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--javac', type=Path, default=Path(shutil.which('javac') or 'javac'))
    args = parser.parse_args()
    build(args.server, args.source, args.output, args.javac)

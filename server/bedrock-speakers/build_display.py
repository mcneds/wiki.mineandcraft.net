#!/usr/bin/env python3
"""Compile pinned GeyserDisplayEntity source against the installed Fabric jar.

Requires the upstream release jar and source ZIP as local inputs. Applies namespace
relocation and the scoped Copper display patch; the source ZIP stays unmodified.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile
from patch_display import patch_source, patch_pack

COMMIT = '847d7a9a08b49b503c9d4e828de8e3dc7eb384e9'


def build(source_zip, release_jar, classpath, output, javac, display_models):
    output.mkdir(parents=True, exist_ok=True)
    source, classes = output / 'src', output / 'classes'
    source.mkdir(exist_ok=True); classes.mkdir(exist_ok=True)
    with zipfile.ZipFile(source_zip) as archive:
        for name in archive.namelist():
            if '/src/main/java/' not in name or not name.endswith('.java'): continue
            if not name.startswith('GeyserDisplayEntity-' + COMMIT + '/'):
                raise ValueError('Use the source archive pinned to ' + COMMIT)
            relative = name.split('/src/main/java/', 1)[1]
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            text = archive.read(name).decode('utf-8-sig')
            text = text.replace('org.cloudburstmc.protocol.', 'org.geysermc.geyser.shaded.org.cloudburstmc.protocol.')
            text = text.replace('org.spongepowered.configurate.', 'me.geyserextensionists.geyserdisplayentity.libs.configurate.')
            text = patch_source(relative, text)
            target.write_text(text)
    result = subprocess.run([str(javac), '--release', '21', '-cp', classpath + ':' + str(release_jar),
                             '-d', str(classes), *map(str, sorted(source.rglob('*.java')))])
    if result.returncode: raise SystemExit(result.returncode)
    target = output / 'GeyserDisplayEntity-1.0.14-mineandcraft.jar'
    with zipfile.ZipFile(release_jar) as original, zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as jar:
        for name in original.namelist():
            if name.startswith('me/geyserextensionists/geyserdisplayentity/') and '/libs/' not in name and name.endswith('.class'): continue
            jar.writestr(name, original.read(name))
        for path in sorted(classes.rglob('*.class')): jar.write(path, path.relative_to(classes).as_posix())
        models = json.loads(display_models.read_text())
        properties = '\n'.join(key.replace(':', '\\:') + '=' + str(value) for key, value in models['indices'].items())
        jar.writestr('copper-display-models.properties', properties)
    patch_pack(output / 'GeyserDisplayEntityPack.mcpack', models)
    (output / 'provenance.json').write_text(json.dumps({'repository': 'https://github.com/GeyserExtensionists/GeyserDisplayEntity',
        'commit': COMMIT, 'sourceZipSha256': hashlib.sha256(source_zip.read_bytes()).hexdigest(),
        'releaseJarSha256': hashlib.sha256(release_jar.read_bytes()).hexdigest(),
        'builtJarSha256': hashlib.sha256(target.read_bytes()).hexdigest()}, indent=2))
    print('Built', target)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-zip', type=Path, required=True)
    parser.add_argument('--release-jar', type=Path, required=True)
    parser.add_argument('--classpath-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--javac', type=Path, required=True)
    parser.add_argument('--display-models', type=Path, required=True)
    args = parser.parse_args()
    build(args.source_zip, args.release_jar, args.classpath_file.read_text(), args.output, args.javac, args.display_models)

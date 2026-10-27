#!/usr/bin/env python3
"""Load an unshaded copy of the staged bundle in an isolated Standalone Geyser.

Production is Fabric (relocated protocol classes); this harness recompiles only
the namespace difference against the same upstream Standalone build. It checks
registration/startup, not Bedrock client rendering or audio playback.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import time
import zipfile


def smoke(stage):
    root = stage / 'smoke'
    compiler = '/usr/lib/jvm/temurin-24-jdk-arm64/bin/javac'
    java = '/usr/lib/jvm/temurin-24-jdk-arm64/bin/java'
    standalone = root / 'Geyser-Standalone.jar'
    dependencies = (stage / 'build/classpath.txt').read_text()
    for kind, source, original in [
        ('audio', stage / 'source/src', stage / 'build/CopperBedrock-0.1.0.jar'),
        ('display', stage / 'display/src', stage / 'display/GeyserDisplayEntity-1.0.14-mineandcraft.jar')]:
        src, classes = root / (kind + '-src'), root / (kind + '-classes')
        src.mkdir(exist_ok=True); classes.mkdir(exist_ok=True)
        sources = []
        for path in source.rglob('*.java'):
            target = src / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(path.read_text().replace('org.geysermc.geyser.shaded.org.cloudburstmc.protocol.', 'org.cloudburstmc.protocol.'))
            sources.append(target)
        subprocess.run([compiler, '--release', '21', '-cp', str(standalone) + ':' + dependencies + ':' + str(original),
                        '-d', str(classes), *map(str, sources)], check=True)
        target = root / 'extensions' / ('CopperBedrock-0.1.0.jar' if kind == 'audio' else 'GeyserDisplayEntity.jar')
        prefix = 'net/mineandcraft/bedrockspeakers/' if kind == 'audio' else 'me/geyserextensionists/geyserdisplayentity/'
        with zipfile.ZipFile(original) as archive, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as built:
            for name in archive.namelist():
                if name.startswith(prefix) and name.endswith('.class') and '/libs/' not in name: continue
                built.writestr(name, archive.read(name))
            for path in classes.rglob('*.class'): built.write(path, path.relative_to(classes).as_posix())
    for name in ['copper-speakers-blocks.json', 'copper-speakers-items.json']:
        shutil.copy2(stage / name, root / 'custom_mappings' / name)
    shutil.copy2(stage / 'copper-speakers-bedrock.mcpack', root / 'packs/copper-speakers-bedrock.mcpack')
    shutil.copy2(stage / 'display/GeyserDisplayEntityPack.mcpack', root / 'packs/GeyserDisplayEntityPack.mcpack')
    log = root / 'smoke.log'
    with log.open('w') as output:
        process = subprocess.Popen([java, '-Xmx1G', '-jar', str(standalone)], cwd=root,
                                   stdin=subprocess.PIPE, stdout=output, stderr=subprocess.STDOUT, text=True)
        try:
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                content = log.read_text(errors='replace')
                if process.poll() is not None: raise RuntimeError('Smoke Geyser exited: ' + content[-6000:])
                if 'Copper Speakers Bedrock audio enabled' in content and 'Run /geyser help' in content:
                    if any(message in content for message in ['Error in load', "Couldn't load", 'Exception', 'ERROR']):
                        raise RuntimeError('Smoke startup reported an error: ' + content[-10000:])
                    print(content[-5000:]); print('PASS: isolated bundle startup', flush=True)
                    return
                time.sleep(1)
            raise RuntimeError('Smoke startup timed out: ' + log.read_text(errors='replace')[-6000:])
        finally:
            if process.poll() is None:
                process.stdin.write('stop\n'); process.stdin.flush()
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=10)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    smoke(parser.parse_args().stage.resolve())

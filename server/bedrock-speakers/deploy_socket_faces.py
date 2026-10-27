#!/usr/bin/env python3
"""Install the tested Copper Speakers socket-face patch with rollback."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import time
import zipfile


def identity(path):
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None: raise RuntimeError('Corrupt jar: ' + path.name)
        value = json.loads(archive.read('fabric.mod.json'))
        if value['id'] != 'copper_speakers': raise RuntimeError('Unexpected mod: ' + path.name)
        return value['version']


def deploy(stage, artifact):
    version = identity(artifact)
    server = Path('/var/lib/pufferpanel/servers/1fc61e68')
    installed = list((server / 'mods').glob('copper-speakers-*.jar'))
    if len(installed) != 1: raise RuntimeError('Expected exactly one installed Copper Speakers jar')
    old = installed[0]
    old_version = identity(old)
    destination = old.with_name(artifact.name)
    if destination != old and destination.exists(): raise RuntimeError('Destination already exists')
    # The saved compatibility jar must already contain the tested plate sender.
    compatibility = server / 'config/Geyser-Fabric/extensions/CopperBedrock-0.1.0.jar'
    if compatibility.read_bytes() != (stage / 'build/CopperBedrock-0.1.0.jar').read_bytes():
        raise RuntimeError('Saved Bedrock compatibility jar differs from the tested build')
    spec = importlib.util.spec_from_file_location('panel', '/opt/mineandcraft-music/music-panel-refresh.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    config = json.loads(Path('/etc/mineandcraft-music/config.json').read_text())
    panel = module.Panel(json.loads(Path(config['panel_credentials']).read_text()),
                        config.get('panel_origin', 'http://127.0.0.1:8080'), config['panel_server_id'])

    def stopped():
        if panel.api('status').get('running'): panel.api('stop', b'')
        deadline = time.monotonic() + 120
        while panel.api('status').get('running'):
            if time.monotonic() >= deadline: raise RuntimeError('Server did not stop; inspect before changing jars')
            time.sleep(1)

    backup = stage / ('socket-faces-backup-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir()
    saved = backup / old.name
    shutil.copy2(old, saved)
    print('Installing Copper Speakers', old_version, '->', version, flush=True)
    print('Backup:', backup, flush=True)
    cursor, _ = panel.console()
    stopped()
    account = pwd.getpwnam('pufferpanel')
    try:
        temporary = destination.with_name(destination.name + '.staged')
        shutil.copy2(artifact, temporary); os.chown(temporary, account.pw_uid, account.pw_gid)
        os.replace(temporary, destination)
        if destination != old: old.unlink()
        panel.api('start', b'')
        logs = ''; deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            time.sleep(2); cursor, update = panel.console(cursor)
            logs = (logs + '\n' + update)[-512000:]
            if ('copper_speakers ' + version in logs and 'Copper Speakers Bedrock audio enabled with ' in logs
                    and '[geyserdisplayentity] Done' in logs and 'Run /geyser help' in logs):
                receipt = {'installedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                           'version': version, 'previousVersion': old_version, 'backup': str(backup),
                           'jar': str(destination), 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
                           'startup': 'passed', 'clientVerification': 'pending'}
                (stage / 'socket-faces-install.json').write_text(json.dumps(receipt, indent=2))
                print('Socket-face mod and Bedrock compatibility loaded successfully.', flush=True)
                return
        raise RuntimeError('Updated startup was not confirmed within four minutes')
    except Exception:
        stopped()
        if destination != old: destination.unlink(missing_ok=True)
        shutil.copy2(saved, old); os.chown(old, account.pw_uid, account.pw_gid)
        panel.api('start', b'')
        print('Restored the previous mod and restarted the server.', flush=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True, type=Path)
    parser.add_argument('--artifact', required=True, type=Path)
    args = parser.parse_args()
    deploy(args.stage.resolve(), args.artifact.resolve())

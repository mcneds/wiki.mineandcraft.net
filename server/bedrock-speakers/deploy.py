#!/usr/bin/env python3
"""Install a staged compatibility bundle during an empty-server restart."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import time
import zipfile


def deploy(stage, wait_minutes, restart_occupied=False):
    server = Path('/var/lib/pufferpanel/servers/1fc61e68')
    geyser = server / 'config/Geyser-Fabric'
    config = json.loads(Path('/etc/mineandcraft-music/config.json').read_text())
    spec = importlib.util.spec_from_file_location('panel', '/opt/mineandcraft-music/music-panel-refresh.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    panel = module.Panel(json.loads(Path(config['panel_credentials']).read_text()),
                         config.get('panel_origin', 'http://127.0.0.1:8080'), config['panel_server_id'])
    files = {
        stage / 'build/CopperBedrock-0.1.0.jar': geyser / 'extensions/CopperBedrock-0.1.0.jar',
        stage / 'display/GeyserDisplayEntity-1.0.14-mineandcraft.jar': geyser / 'extensions/GeyserDisplayEntity.jar',
        stage / 'display/GeyserDisplayEntityPack.mcpack': geyser / 'packs/GeyserDisplayEntityPack.mcpack',
        stage / 'copper-speakers-bedrock.mcpack': geyser / 'packs/copper-speakers-bedrock.mcpack',
        stage / 'copper-speakers-blocks.json': geyser / 'custom_mappings/copper-speakers-blocks.json',
        stage / 'copper-speakers-items.json': geyser / 'custom_mappings/copper-speakers-items.json',
    }
    for source in files:
        if source.suffix in ('.jar', '.mcpack'):
            with zipfile.ZipFile(source) as archive:
                if archive.testzip() is not None: raise RuntimeError('Corrupt archive: ' + source.name)
        else: json.loads(source.read_text())
    # Avoid two display extensions registering the same entity definitions.
    for other in (geyser / 'extensions').glob('*.jar'):
        if 'displayentity' in other.name.lower() and other not in files.values():
            raise RuntimeError('Another display extension is already installed: ' + other.name)
    deadline = time.monotonic() + wait_minutes * 60
    while not restart_occupied and panel.players():
        if time.monotonic() >= deadline: raise RuntimeError('Server remained occupied; nothing installed or restarted.')
        print('Waiting for an empty-server window.', flush=True)
        time.sleep(15)
    if not restart_occupied: panel.require_empty()
    cursor, _ = panel.console()
    panel.api('stop', b'')
    deadline = time.monotonic() + 120
    while panel.api('status').get('running'):
        if time.monotonic() >= deadline: raise RuntimeError('Server did not stop; nothing installed.')
        time.sleep(1)
    backup = stage / ('backup-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir()
    account = pwd.getpwnam('pufferpanel')
    originals = {}
    try:
        for source, destination in files.items():
            saved = backup / destination.relative_to(geyser)
            originals[destination] = saved if destination.exists() else None
            if destination.exists():
                saved.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(destination, saved)
            if not destination.parent.exists():
                destination.parent.mkdir(parents=True); os.chown(destination.parent, account.pw_uid, account.pw_gid)
            shutil.copy2(source, destination)
            os.chown(destination, account.pw_uid, account.pw_gid)
        panel.api('start', b'')
        deadline = time.monotonic() + 180
        logs = ''
        while time.monotonic() < deadline:
            time.sleep(2)
            cursor, update = panel.console(cursor)
            logs = (logs + '\n' + update)[-512000:]
            if 'Copper Speakers Bedrock audio enabled with ' in logs and '[geyserdisplayentity] Done' in logs:
                print('Compatibility extensions and visual mappings loaded successfully.', flush=True)
                print('Backup:', backup, flush=True)
                return
            if any(message in logs for message in ["Couldn't load CopperBedrock", "Couldn't load GeyserDisplayEntity", '[geyserdisplayentity] Error in load']):
                raise RuntimeError('A compatibility extension failed during startup.')
        raise RuntimeError('Compatibility startup was not confirmed within three minutes.')
    except Exception:
        if panel.api('status').get('running'):
            panel.api('stop', b'')
            deadline = time.monotonic() + 120
            while panel.api('status').get('running'):
                if time.monotonic() >= deadline: raise RuntimeError('Rollback waiting for server to stop; inspect before changing files.')
                time.sleep(1)
        for destination, saved in originals.items():
            if saved is None: destination.unlink(missing_ok=True)
            else:
                shutil.copy2(saved, destination); os.chown(destination, account.pw_uid, account.pw_gid)
        panel.api('start', b'')
        print('Restored previous files and started the original server.', flush=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--wait-minutes', type=int, default=0)
    parser.add_argument('--restart-occupied', action='store_true', help='Use only for an authorized restart of connected players.')
    args = parser.parse_args()
    deploy(args.stage.resolve(), args.wait_minutes, args.restart_occupied)

#!/usr/bin/env python3
"""Install a prepared chat release on the VPS during an empty-server window.

Run as root. Uses the existing music operation lock and panel credentials.
The release directory contains bot scripts, its service example, and the JAR.
"""
import argparse
import asyncio
from contextlib import contextmanager, ExitStack
import datetime
import grp
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import time
from urllib.request import Request, urlopen


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def command(*args):
    subprocess.run(list(args), check=True, timeout=40)


def wait_bridge(key, minecraft=False):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            request = Request('http://127.0.0.1:25586/bridge/health', headers={'Authorization': 'Bearer ' + key})
            with urlopen(request, timeout=3) as response:
                health = json.load(response)
            if health['discordReady'] and health['channelReady'] and (not minecraft or health['minecraftConnected']):
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Chat bridge did not confirm a healthy connection.')


def management_player_count(path):
    """Read an authenticated roster instead of parsing console command output."""
    async def check():
        from websockets.asyncio.client import connect
        props = dict(line.split('=', 1) for line in path.read_text().splitlines()
                     if '=' in line and not line.startswith('#'))
        if props.get('management-server-host') != '127.0.0.1' or props.get('management-server-enabled') != 'true':
            raise ValueError('Private management API is required.')
        port = int(props['management-server-port'])
        async with connect(f'ws://127.0.0.1:{port}',
                           additional_headers={'Authorization': 'Bearer ' + props['management-server-secret']},
                           subprotocols=['minecraft-v1'], open_timeout=3) as ws:
            for request_id, method in enumerate(('minecraft:server/status', 'minecraft:players'), 1):
                await ws.send(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method}))
                while True:
                    value = json.loads(await ws.recv())
                    if value.get('id') == request_id:
                        result = value.get('result')
                        if request_id == 1:
                            if not isinstance(result, dict) or result.get('started') is not True:
                                raise ValueError('Server has not started.')
                        elif isinstance(result, list):
                            return len(result)
                        else:
                            raise ValueError('Invalid player roster.')
                        break
    try:
        return asyncio.run(asyncio.wait_for(check(), timeout=8))
    except Exception:
        raise RuntimeError('Could not verify that Minecraft is empty. No restart was attempted.') from None


@contextmanager
def empty_server_window(music, panel_module, config, game, wait):
    """Release the operation lock between checks; never retry a failed install."""
    while True:
        with ExitStack() as locks:
            try:
                locks.enter_context(music.service_lock(Path(config['state_dir']) / 'operations'))
            except RuntimeError as error:
                if not wait or str(error) != 'Another music service is already using this state directory.':
                    raise
                print('Waiting for the current server operation to finish.', flush=True)
                time.sleep(30)
                continue
            panel = panel_module.Panel(json.loads(Path(config['panel_credentials']).read_text()),
                                       config['panel_origin'], config['panel_server_id'])
            panel.management_properties = game / 'server.properties'
            # Panel.restart also uses this fresh check immediately before stop.
            panel.players = lambda: (management_player_count(panel.management_properties)
                                     if panel.api('status').get('running') else 0)
            try:
                panel.require_empty()
            except RuntimeError as error:
                startup_check = str(error) == 'Could not verify that Minecraft is empty. No restart was attempted.'
                if not wait or not (isinstance(error, panel_module.Waiting) or startup_check):
                    raise
                print(str(error), flush=True)
            else:
                yield panel
                return
        time.sleep(30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--guild', required=True)
    parser.add_argument('--channel', required=True)
    parser.add_argument('--wait-empty', action='store_true', help='Wait without holding the operation lock while players are online.')
    parser.add_argument('--music-config', type=Path, default=Path('/etc/mineandcraft-music/config.json'))
    args = parser.parse_args()
    if os.geteuid() != 0 or not all(re.fullmatch(r'\d{17,20}', value) for value in (args.guild, args.channel)):
        raise ValueError('Run as root with valid Discord guild and channel IDs.')
    release = args.release.resolve(strict=True)
    names = ['discord-status.py', 'discord_bridge.py', 'discord-status.service.example', 'mineandcraft-chat-1.0.0.jar']
    if not all((release / name).is_file() for name in names):
        raise ValueError('The prepared release is incomplete.')
    for name in names[:2]:
        compile((release / name).read_text(), name, 'exec')
    config = json.loads(args.music_config.read_text())
    game = Path(config['datapacks_dir']).resolve().parent.parent
    if not (game / 'server.properties').is_file() or not (game / 'mods').is_dir():
        raise ValueError('Could not identify the configured Minecraft directory.')
    music = module('music_chat_install', '/opt/mineandcraft-music/music-server.py')
    panel_module = module('panel_chat_install', '/opt/mineandcraft-music/music-panel-refresh.py')
    bot = Path('/opt/mineandcraft-discord')
    private = Path('/etc/mineandcraft-discord')
    service = Path('/etc/systemd/system/mineandcraft-discord-status.service')
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/var/backups/mineandcraft-chat') / timestamp
    targets = [bot / 'discord-status.py', bot / 'discord_bridge.py', private / 'status.env',
               private / 'chat.key', service, game / 'config/mineandcraft-chat.json',
               game / 'mods/mineandcraft-chat-1.0.0.jar']
    with empty_server_window(music, panel_module, config, game, args.wait_empty) as panel:
        backup.mkdir(parents=True, mode=0o700)
        backup.parent.chmod(0o700)
        existed = []
        for index, target in enumerate(targets):
            existed.append(target.exists())
            if target.exists():
                shutil.copy2(target, backup / str(index))
        (backup / 'paths.json').write_text(json.dumps([str(p) for p in targets]))
        command('systemctl', 'stop', 'mineandcraft-music.service')
        try:
            group = grp.getgrnam('pufferpanel').gr_gid
            os.chown(private, 0, group)
            private.chmod(0o750)
            key_path = private / 'chat.key'
            key = key_path.read_text().strip() if key_path.exists() else secrets.token_urlsafe(48)
            if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', key):
                raise ValueError('Invalid existing chat key.')
            # Private directory is not world-readable.
            key_path.write_text(key + '\n')
            os.chown(key_path, 0, group); key_path.chmod(0o640)
            env = private / 'status.env'
            lines = [line for line in env.read_text().splitlines() if not line.startswith(('CHAT_BRIDGE_', 'CHAT_MEMBER_AUTOCOMPLETE='))]
            lines += ['CHAT_BRIDGE_GUILD_ID=' + args.guild, 'CHAT_BRIDGE_CHANNEL_ID=' + args.channel,
                      'CHAT_BRIDGE_KEY=' + key, 'CHAT_MEMBER_AUTOCOMPLETE=1']
            pending = env.with_suffix('.new')
            pending.write_text('\n'.join(lines) + '\n'); pending.chmod(0o600); pending.replace(env)
            for name in names[:2]:
                pending = bot / (name + '.new')
                shutil.copyfile(release / name, pending); pending.chmod(0o644); pending.replace(bot / name)
            shutil.copyfile(release / names[2], service); service.chmod(0o644)
            chat_config = game / 'config/mineandcraft-chat.json'
            chat_config.write_text(json.dumps({'enabled': True, 'key_file': str(key_path)}, indent=2) + '\n')
            chat_config.chmod(0o644)
            jar = game / 'mods' / names[3]
            shutil.copyfile(release / names[3], jar); jar.chmod(0o644)
            command('systemctl', 'daemon-reload')
            command('systemctl', 'restart', 'mineandcraft-discord-status.service')
            wait_bridge(key)
            # The panel takes another fresh player check immediately before stop.
            panel.start_or_restart()
            wait_bridge(key, minecraft=True)
            print('Chat companion installed and Minecraft startup confirmed. Backup: ' + str(backup), flush=True)
        except Exception:
            for index, target in enumerate(targets):
                if existed[index]:
                    shutil.copy2(backup / str(index), target)
                elif target.exists():
                    target.unlink()
            command('systemctl', 'daemon-reload')
            command('systemctl', 'restart', 'mineandcraft-discord-status.service')
            # Do not force a second restart if someone joined or startup is slow.
            print('Files restored after installation failure. Check Minecraft status before any further restart.', flush=True)
            raise
        finally:
            command('systemctl', 'start', 'mineandcraft-music.service')


if __name__ == '__main__':
    main()

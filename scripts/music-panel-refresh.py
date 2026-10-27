#!/usr/bin/env python3
"""Refresh one PufferPanel-managed server during an empty-server window."""
import argparse
import asyncio
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
import zipfile

PACK_REVISION = 3  # Must match the generated datapack contract in music-server.py.

class Waiting(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('PufferPanel redirected a private request. Check its local address.')


def management_ready(path):
    if not path or not Path(path).is_file():
        return False
    async def check():
        from websockets.asyncio.client import connect
        props = dict(line.split('=', 1) for line in Path(path).read_text().splitlines() if '=' in line and not line.startswith('#'))
        if props.get('management-server-host') != '127.0.0.1' or props.get('management-server-enabled') != 'true':
            return False
        async with connect('ws://127.0.0.1:' + props['management-server-port'], additional_headers={'Authorization': 'Bearer ' + props['management-server-secret']}, subprotocols=['minecraft-v1'], open_timeout=3) as ws:
            await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'minecraft:server/status'}))
            while True:
                value = json.loads(await ws.recv())
                if value.get('id') == 1:
                    if not value.get('result', {}).get('started'):
                        return False
                    await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'minecraft:players'}))
                elif value.get('id') == 2:
                    return isinstance(value.get('result'), list)
    try:
        return asyncio.run(asyncio.wait_for(check(), timeout=5))
    except Exception:
        return False


class Panel:
    def __init__(self, credentials, origin='http://127.0.0.1:8080', server_id='1fc61e68'):
        url = urlparse(origin)
        if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost') or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError('The music service must use PufferPanel on localhost.')
        if not re.fullmatch('[a-zA-Z0-9_-]{1,64}', server_id):
            raise ValueError('Invalid PufferPanel server ID.')
        self.origin, self.server_id, self.opener = origin.rstrip('/'), server_id, build_opener(NoRedirect())
        body = urlencode({'grant_type': 'client_credentials', 'client_id': credentials['client_id'], 'client_secret': credentials['client_secret']}).encode()
        self.token = self.request('/oauth2/token', body, 'application/x-www-form-urlencoded')['access_token']

    def request(self, path, data=None, content_type='application/json'):
        headers = {'Content-Type': content_type}
        if hasattr(self, 'token'):
            headers['Authorization'] = 'Bearer ' + self.token
        try:
            with self.opener.open(Request(self.origin + path, data=data, headers=headers), timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise RuntimeError('The panel response exceeded the allowed size.')
                return json.loads(raw) if raw else None
        except HTTPError as error:
            raise RuntimeError(f'PufferPanel rejected the music service (HTTP {error.code}).') from None

    def api(self, endpoint, data=None):
        return self.request(f'/proxy/daemon/server/{self.server_id}/{endpoint}', data)

    def command(self, command):
        # PufferPanel 2.x forwards the raw body to stdin, including JSON quotes.
        self.api('console', command.encode())

    def console(self, cursor=None):
        result = self.api('console' + (f'?time={int(cursor)}' if cursor is not None else ''))
        text = re.sub(r'\x1b\[[0-9;]*m|§.', '', result.get('logs', ''))
        # Chat is not command feedback, and must not spoof an installation check.
        lines = '\n'.join(line for line in text.splitlines() if '<' not in line)
        return result.get('epoch', cursor or 0), lines

    def players(self):
        if not self.api('status').get('running'):
            raise Waiting('The Minecraft server is offline. Publishing will wait until it is running.')
        cursor, _ = self.console()
        self.command('list')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            time.sleep(.5)
            cursor, logs = self.console(cursor)
            match = re.search(r'(?:^|\]: (?:System chat: )?)There are (\d+) of a max of \d+ players online', logs, re.MULTILINE)
            if match:
                return int(match[1])
        raise RuntimeError('Could not verify that Minecraft is empty. No restart was attempted.')

    def require_empty(self):
        count = self.players()
        if count:
            raise Waiting(f'Publishing is waiting for an empty server ({count} players online).')

    def restart(self):
        self.require_empty()
        cursor, _ = self.console()
        self.api('stop', b'')
        deadline = time.monotonic() + 120
        while self.api('status').get('running'):
            if time.monotonic() >= deadline:
                raise RuntimeError('Minecraft did not finish stopping. The service did not kill it.')
            time.sleep(1)
        self.api('start', b'')
        return self.wait_start(cursor)

    def start_or_restart(self):
        if self.api('status').get('running'):
            return self.restart()
        cursor, _ = self.console()
        self.api('start', b'')
        return self.wait_start(cursor)

    def wait_start(self, cursor):
        deadline = time.monotonic() + 180
        collected = ''
        while time.monotonic() < deadline:
            time.sleep(1)
            cursor, logs = self.console(cursor)
            collected = (collected + '\n' + logs)[-256000:]
            if re.search(r'Done \([\d.,]+s\)!', collected) or management_ready(getattr(self, 'management_properties', None)):
                return cursor, collected
        raise RuntimeError('Minecraft did not confirm a completed startup within three minutes.')


def verify_music(panel, cursor, logs, manifest, pack_path):
    if re.search(r'(?:Failed to load function|Failed to parse|Error loading).*mineandcraft_music', logs, re.IGNORECASE):
        raise RuntimeError('Minecraft reported an error loading the music datapack.')
    release = manifest['releaseId']
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        panel.command('data get storage mineandcraft_music:delivery')
        time.sleep(1)
        cursor, output = panel.console(cursor)
        if (release in output and 'following contents' in output
                and re.search(r'pack_revision:\s*' + str(PACK_REVISION) + r'\b', output)):
            break
    else:
        raise RuntimeError('Minecraft did not confirm the expected music datapack release.')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            with zipfile.ZipFile(pack_path) as pack:
                sounds = json.loads(pack.read('assets/mineandcraft_music/sounds.json'))
                names = {'disc_' + track['id'].replace('-', '') for track in manifest['tracks']}
                expected = names | {'buffered.' + name for name in names}
                buffered = all(sounds.get('buffered.' + name) == {'sounds': [{
                    'name': 'mineandcraft_music:music/' + name, 'type': 'file', 'stream': False, 'preload': False
                }]} for name in names)
                audio_present = all('assets/mineandcraft_music/sounds/music/' + name + '.ogg' in pack.namelist() for name in names)
                if set(sounds) == expected and buffered and audio_present and pack.testzip() is None:
                    return
        except (OSError, KeyError, zipfile.BadZipFile, json.JSONDecodeError):
            pass
        time.sleep(1)
    raise RuntimeError('Polymer did not finish building the expected music resource pack.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--bootstrap', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    credentials = json.loads(Path(config['panel_credentials']).read_text(encoding='utf-8'))
    panel = Panel(credentials, config.get('panel_origin', 'http://127.0.0.1:8080'), config['panel_server_id'])
    panel.management_properties = Path(config['datapacks_dir']).parent.parent / 'server.properties'
    if args.check:
        panel.require_empty()
        print('The server is empty; music publishing may proceed.')
        return
    state = Path(config['state_dir'])
    pending = state / 'pending-install.json'
    manifest = json.loads(pending.read_text(encoding='utf-8')) if not args.bootstrap else None
    if manifest is not None and not re.fullmatch('[a-f0-9]{64}', manifest.get('releaseId', '')):
        raise ValueError('The pending music release is invalid.')
    cursor, logs = panel.start_or_restart() if args.bootstrap else panel.restart()
    if manifest is not None:
        verify_music(panel, cursor, logs, manifest, Path(config['polymer_pack']))
    print('Minecraft finished restarting' + (' and confirmed the music pack.' if manifest else '.'))


if __name__ == '__main__':
    try:
        main()
    except Waiting as error:
        print(str(error))
        raise SystemExit(75)
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)

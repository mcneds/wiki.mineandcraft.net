#!/usr/bin/env python3
"""Private Minecraft management events -> name-only wiki status snapshots.

Uses the existing music venv's websockets package. No console polling, public
management listener, player UUIDs in reports, or dependency on music downloads.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import socket
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.parse import urlparse


def properties(path):
    return dict(line.split('=', 1) for line in Path(path).read_text().splitlines() if '=' in line and not line.startswith('#'))


class Roster:
    def __init__(self):
        self.players = {}
        self.ready = False

    def snapshot(self, result):
        self.players = {player['id']: player['name'] for player in result['players']}
        self.ready = bool(result['started'])

    def event(self, method, params):
        if method not in ('minecraft:notification/players/joined', 'minecraft:notification/players/left'):
            return False
        values = params if isinstance(params, list) else [params]
        for player in values:
            if method.endswith('/joined'):
                self.players[player['id']] = player['name']
            else:
                self.players.pop(player['id'], None)
        return True

    def report(self, capacity):
        return {'availability': 'online' if self.ready else 'unavailable', 'capacity': capacity,
                'players': sorted(self.players.values(), key=str.casefold) if self.ready else []}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Status endpoint redirected.')


def publish(origin, key, value):
    request = Request(origin + '/api/server-status/report/', data=json.dumps(value).encode(), headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'mineandcraft-status/1.0'})
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError('Status report rejected.')
        response.read(1024)


def reachable(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            return True
    except ConnectionRefusedError:
        return False
    except OSError:
        return None


async def collect(config):
    from websockets.asyncio.client import connect
    origin = config['site_origin'].rstrip('/')
    parsed = urlparse(origin)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('Status site_origin must be an HTTPS origin.')
    key = os.environ['SERVER_STATUS_KEY']
    if len(key) < 32:
        raise ValueError('Missing status reporting credential.')
    roster, changed = Roster(), asyncio.Event()
    capacity, game_port = 20, 25565
    async def report_loop():
        while True:
            changed.clear()
            connection = await asyncio.to_thread(reachable, game_port)
            value = roster.report(capacity)
            if connection is False:
                value = {'availability': 'offline', 'players': [], 'capacity': capacity}
            elif connection is None:
                value = {'availability': 'unavailable', 'players': [], 'capacity': capacity}
            try:
                await asyncio.to_thread(publish, origin, key, value)
            except Exception as error:
                print('Status report will retry (' + type(error).__name__ + ').', flush=True)
            try:
                await asyncio.wait_for(changed.wait(), timeout=15)
            except asyncio.TimeoutError:
                pass
    publisher = asyncio.create_task(report_loop())
    try:
        while True:
            try:
                props = properties(config['server_properties'])
                capacity, game_port = int(props.get('max-players', 20)), int(props.get('server-port', 25565))
                if props.get('management-server-host') != '127.0.0.1' or props.get('management-server-tls-enabled') != 'false':
                    raise ValueError('Management must be explicitly bound to loopback.')
                port = int(props['management-server-port'])
                async with connect(f'ws://127.0.0.1:{port}', additional_headers={'Authorization': 'Bearer ' + props['management-server-secret']}, subprotocols=['minecraft-v1'], open_timeout=10, ping_interval=15, ping_timeout=10, max_size=2 * 1024 * 1024) as websocket:
                    roster.ready = False
                    await websocket.send(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'minecraft:server/status'}))
                    async def receive():
                        async for raw in websocket:
                            message = json.loads(raw)
                            if roster.event(message.get('method'), message.get('params', [])):
                                changed.set()
                    await asyncio.wait_for(initial_receive(websocket, roster, changed), timeout=15)
                    await receive()
            except Exception as error:
                print('Management connection will retry (' + type(error).__name__ + ').', flush=True)
            roster.ready = False
            roster.players.clear()
            changed.set()
            await asyncio.sleep(5)
    finally:
        publisher.cancel()


async def initial_receive(websocket, roster, changed):
    # Consume messages in wire order, including notifications around the initial
    # full snapshot. Reconnect always obtains a new snapshot before going live.
    started = False
    while not roster.ready:
        message = json.loads(await websocket.recv())
        if message.get('id') == 1:
            if 'error' in message:
                raise RuntimeError('Management status query rejected.')
            started = bool(message['result']['started'])
            if not started:
                raise RuntimeError('Minecraft has not finished starting.')
            await websocket.send(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'minecraft:players'}))
        elif message.get('id') == 2:
            if 'error' in message:
                raise RuntimeError('Management roster query rejected.')
            roster.snapshot({'started': started, 'players': message['result']})
        else:
            roster.event(message.get('method'), message.get('params', []))
    changed.set()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    asyncio.run(collect(json.loads(args.config.read_text())))

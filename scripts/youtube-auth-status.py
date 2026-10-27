#!/usr/bin/env python3
"""Persist Lavalink's authorized session locally without printing credentials.

Run as root on the VPS. A systemd timer can call this while account linking is
pending, ensuring a completed sign-in survives a Lavalink restart.
"""
import argparse
import json
import os
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def capture(config_path):
    config = json.loads(config_path.read_text())
    port = config['server']['port']
    if config['server']['address'] != '127.0.0.1' or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError('Lavalink must be bound to loopback.')
    request = Request(f'http://127.0.0.1:{port}/youtube',
                      headers={'Authorization': config['lavalink']['server']['password']})
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        data = response.read(65537)
    if len(data) > 65536:
        raise ValueError('Unexpected sign-in response.')
    token = json.loads(data).get('refreshToken')
    if not token:
        return False
    if not isinstance(token, str) or not 20 <= len(token) <= 8192:
        raise ValueError('Unexpected sign-in response.')
    oauth = config['plugins']['youtube']['oauth']
    if oauth.get('refreshToken') != token:
        oauth.update(enabled=True, skipInitialization=True, refreshToken=token)
        pending = config_path.with_suffix('.pending')
        stat = config_path.stat()
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(config, output)
            output.flush()
            os.fsync(output.fileno())
        pending.chmod(0o600)
        os.chown(pending, stat.st_uid, stat.st_gid)
        os.replace(pending, config_path)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    try:
        ready = capture(args.config)
        print('Google session saved privately on the VPS.' if ready else 'Waiting for Google sign-in.')
    except Exception:
        print('Sign-in status is unavailable; credentials were not printed.')
        raise SystemExit(1)


if __name__ == '__main__':
    main()

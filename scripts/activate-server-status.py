#!/usr/bin/env python3
"""One controlled empty-server restart to activate private management settings.

Run as root from a temporary systemd timer. Shares the music operation lock,
stops the idle music service, and takes fresh player checks before restarting.
The completion marker prevents any further restarts from this activation task.
"""
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def main():
    music = module('music_activation', 'music-server.py')
    panel_module = module('panel_activation', 'music-panel-refresh.py')
    config = json.loads(Path(sys.argv[1]).read_text())
    state = Path(config['state_dir'])
    marker = state / 'status-management-active'
    if marker.exists():
        return
    try:
        with socket.create_connection(('127.0.0.1', 25585), timeout=2):
            marker.touch()
            return
    except OSError:
        pass
    try:
        with music.service_lock(state / 'operations'):
            panel = panel_module.Panel(json.loads(Path(config['panel_credentials']).read_text()), config['panel_origin'], config['panel_server_id'])
            panel.management_properties = Path(config['datapacks_dir']).parent.parent / 'server.properties'
            if not panel.api('status').get('running'):
                print('Status activation waits for Minecraft to be running.', flush=True)
                return
            panel.require_empty()
            subprocess.run(['systemctl', 'stop', 'mineandcraft-music.service'], check=True, timeout=30)
            try:
                panel.restart()  # Fresh second check immediately before stop.
            finally:
                subprocess.run(['systemctl', 'start', 'mineandcraft-music.service'], check=True, timeout=30)
            with socket.create_connection(('127.0.0.1', 25585), timeout=5):
                marker.touch()
            print('Private management activated during an empty-server window.', flush=True)
    except (panel_module.Waiting, RuntimeError) as error:
        print('Status activation deferred: ' + str(error), flush=True)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Relay the VPS's YouTube downloads through this computer over private SSH.

Requires Python 3 and PuTTY's plink. Uses a previously trusted PuTTY session.
No browser profiles, Google accounts, or website credentials are accessed.
"""
import argparse
import http.server
import ipaddress
from pathlib import Path
import re
import select
import shutil
import socket
import subprocess
import threading
import time


def youtube_host(host):
    return host in ('www.google.com', 'consent.google.com') or any(host == domain or host.endswith('.' + domain)
               for domain in ('youtube.com', 'googlevideo.com', 'ytimg.com'))


class Relay(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Do not log signed media URLs or connection details.

    def do_CONNECT(self):
        try:
            host, port = self.path.rsplit(':', 1)
            if port != '443' or not youtube_host(host):
                if getattr(self.server, 'verbose', False) and re.fullmatch(r'[a-zA-Z0-9.-]{1,253}', host):
                    print(f'Relay refused destination: {host}', flush=True)
                self.send_error(403)
                return
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not addresses or not all(ipaddress.ip_address(a[4][0]).is_global for a in addresses):
                self.send_error(403)
                return
            # Connect to the validated address without a second DNS lookup.
            family, socktype, proto, _, address = addresses[0]
            with socket.socket(family, socktype, proto) as upstream:
                upstream.settimeout(20)
                upstream.connect(address)
                self.send_response(200)
                self.end_headers()
                deadline = time.monotonic() + 240
                while time.monotonic() < deadline:
                    ready, _, _ = select.select([self.connection, upstream], [], [], 20)
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.connection else self.connection).sendall(data)
        except (OSError, ValueError):
            return


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args):
        self.slots = threading.BoundedSemaphore(24)
        super().__init__(*args)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        request.settimeout(30)
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', required=True, help='Existing trusted PuTTY SSH session')
    parser.add_argument('--ssh-user', default='ubuntu')
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--port', type=int, default=18443)
    parser.add_argument('--duration', type=int, default=0, help='Optional lifetime in seconds; zero runs until stopped')
    parser.add_argument('--verbose', action='store_true', help='Show refused destination hostnames for troubleshooting')
    args = parser.parse_args()
    plink = shutil.which('plink')
    if not plink or not args.key_file.is_file() or not 1024 <= args.port <= 65535 or args.duration < 0:
        parser.error('Install plink, supply an existing private key, and choose a port from 1024 to 65535.')
    with Server(('127.0.0.1', args.port), Relay) as server:
        server.verbose = args.verbose
        threading.Thread(target=server.serve_forever, daemon=True).start()
        command = [plink, '-batch', '-noagent', '-load', args.session, '-l', args.ssh_user,
                   '-i', str(args.key_file.resolve()), '-N', '-R',
                   f'127.0.0.1:{args.port}:127.0.0.1:{args.port}']
        deadline = time.monotonic() + args.duration if args.duration else float('inf')
        child = None
        print('YouTube relay running. Keep this computer connected for new imports. Ctrl+C stops it.', flush=True)
        try:
            while time.monotonic() < deadline:
                child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                while child.poll() is None and time.monotonic() < deadline:
                    time.sleep(1)
                if time.monotonic() < deadline:
                    print('SSH connection ended; retrying in 15 seconds. Check the saved PuTTY session if this persists.', flush=True)
                    time.sleep(min(15, max(0, deadline - time.monotonic())))
        except KeyboardInterrupt:
            pass
        finally:
            if child and child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            server.shutdown()


if __name__ == '__main__':
    main()

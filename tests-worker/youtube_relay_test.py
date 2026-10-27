import importlib.util
import http.client
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('youtube_relay', Path(__file__).resolve().parents[1] / 'scripts/youtube-relay.py')
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class RelayTests(unittest.TestCase):
    def test_only_youtube_hosts_are_allowed(self):
        for host in ('youtube.com', 'www.youtube.com', 'rr1.googlevideo.com', 'i.ytimg.com', 'www.google.com', 'consent.google.com'):
            self.assertTrue(relay.youtube_host(host))
        for host in ('youtube.com.evil.test', 'notyoutube.com', '127.0.0.1', 'localhost', 'accounts.google.com'):
            self.assertFalse(relay.youtube_host(host))

    def test_relay_denies_other_hosts_ports_and_private_dns_addresses(self):
        with relay.Server(('127.0.0.1', 0), relay.Relay) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                for target in ('example.com:443', 'www.youtube.com:80', 'www.youtube.com:443'):
                    conn = http.client.HTTPConnection(*server.server_address, timeout=2)
                    conn.connect()
                    with patch.object(relay.socket, 'getaddrinfo', return_value=[
                            (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]):
                        conn.request('CONNECT', target)
                        self.assertEqual(conn.getresponse().status, 403)
                        conn.close()
            finally:
                server.shutdown()


if __name__ == '__main__':
    unittest.main()

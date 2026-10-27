import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('youtube_auth', Path(__file__).resolve().parents[1] / 'scripts/youtube-auth-status.py')
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


class AuthTests(unittest.TestCase):
    def test_pending_login_does_not_change_config_and_authorized_session_is_persisted(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'application.yml'
            config = {'server': {'address': '127.0.0.1', 'port': 2333},
                      'lavalink': {'server': {'password': 'a' * 40}},
                      'plugins': {'youtube': {'oauth': {'enabled': True, 'skipInitialization': False}}}}
            path.write_text(json.dumps(config))
            original = path.read_bytes()
            opener = MagicMock()
            opener.open.return_value = io.BytesIO(b'{"refreshToken":null}')
            with patch.object(auth, 'build_opener', return_value=opener):
                self.assertFalse(auth.capture(path))
            self.assertEqual(path.read_bytes(), original)
            token = 'test-refresh-token-' * 4
            opener.open.return_value = io.BytesIO(json.dumps({'refreshToken': token}).encode())
            with patch.object(auth, 'build_opener', return_value=opener), patch.object(auth.os, 'chown', create=True):
                self.assertTrue(auth.capture(path))
            saved = json.loads(path.read_text())['plugins']['youtube']['oauth']
            self.assertEqual(saved, {'enabled': True, 'skipInitialization': True, 'refreshToken': token})
            self.assertFalse(path.with_suffix('.pending').exists())


if __name__ == '__main__':
    unittest.main()

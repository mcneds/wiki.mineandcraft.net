import importlib.util
from contextlib import asynccontextmanager, contextmanager
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch


spec = importlib.util.spec_from_file_location('chat_install', Path(__file__).parents[1] / 'scripts/install-chat-bridge.py')
installer = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'grp': SimpleNamespace()} if sys.platform == 'win32' else {}):
    spec.loader.exec_module(installer)


class Waiting(RuntimeError):
    pass


class InstallWindowTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.game = Path(self.temp.name)
        credentials = self.game / 'credentials.json'
        credentials.write_text('{}')
        self.config = dict(state_dir=self.temp.name, panel_credentials=str(credentials),
                           panel_origin='http://localhost', panel_server_id='test')
        self.locked = False
        self.checks = 0

        @contextmanager
        def lock(_):
            self.assertFalse(self.locked)
            self.locked = True
            try:
                yield
            finally:
                self.locked = False

        self.music = SimpleNamespace(service_lock=lock)

        def require_empty():
            self.assertTrue(self.locked)
            self.checks += 1
            if self.checks == 1:
                raise Waiting('Players online')

        self.panel = SimpleNamespace(require_empty=require_empty)
        self.panels = SimpleNamespace(Panel=lambda *args: self.panel, Waiting=Waiting)

    def window(self, wait=True):
        return installer.empty_server_window(self.music, self.panels, self.config, self.game, wait)

    def test_wait_releases_lock_and_install_holds_it(self):
        def sleep(_):
            self.assertFalse(self.locked)
        with patch.object(installer.time, 'sleep', side_effect=sleep) as pause:
            with self.window() as panel:
                self.assertIs(panel, self.panel)
                self.assertTrue(self.locked)
            pause.assert_called_once_with(30)
        self.assertFalse(self.locked)
        self.assertEqual(self.checks, 2)

    def test_no_wait_leaves_online_server_untouched(self):
        with self.assertRaises(Waiting), self.window(False):
            self.fail('Must not begin installation')
        self.assertFalse(self.locked)

    def test_busy_operation_lock_retries_only_acquisition(self):
        original = self.music.service_lock
        attempts = []

        @contextmanager
        def busy_once(directory):
            attempts.append(directory)
            if len(attempts) == 1:
                raise RuntimeError('Another music service is already using this state directory.')
            with original(directory):
                yield

        self.music.service_lock = busy_once
        self.checks = 1
        with patch.object(installer.time, 'sleep', side_effect=lambda _: self.assertFalse(self.locked)) as pause:
            with self.window():
                self.assertTrue(self.locked)
            pause.assert_called_once_with(30)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(self.checks, 2)

    def test_lock_error_inside_install_is_not_retried(self):
        self.checks = 1
        with patch.object(installer.time, 'sleep') as pause:
            with self.assertRaisesRegex(RuntimeError, 'Another music service'), self.window():
                raise RuntimeError('Another music service is already using this state directory.')
            pause.assert_not_called()
        self.assertFalse(self.locked)

    def test_startup_without_player_response_waits_before_installing(self):
        results = iter([RuntimeError('Could not verify that Minecraft is empty. No restart was attempted.'), None])

        def require_empty():
            result = next(results)
            if result:
                raise result

        self.panel.require_empty = require_empty
        with patch.object(installer.time, 'sleep') as pause:
            with self.window():
                self.assertTrue(self.locked)
            pause.assert_called_once_with(30)

    def test_unexpected_check_errors_are_not_silently_retried(self):
        self.panel.require_empty = lambda: (_ for _ in ()).throw(RuntimeError('Bad credentials'))
        with patch.object(installer.time, 'sleep') as pause:
            with self.assertRaisesRegex(RuntimeError, 'Bad credentials'), self.window():
                self.fail('Must not begin installation')
            pause.assert_not_called()

    def test_install_failure_is_never_retried(self):
        self.checks = 1
        with patch.object(installer.time, 'sleep') as pause:
            with self.assertRaisesRegex(Waiting, 'joined'), self.window():
                raise Waiting('A player joined before restart')
            pause.assert_not_called()
        self.assertFalse(self.locked)
        self.assertEqual(self.checks, 2)

    def test_stopped_server_needs_no_roster_connection(self):
        self.panel.api = lambda _: {'running': False}
        self.panel.require_empty = lambda: self.assertEqual(self.panel.players(), 0)
        with patch.object(installer, 'management_player_count') as roster:
            with self.window():
                pass
            roster.assert_not_called()

    def test_running_server_uses_fresh_roster(self):
        self.panel.api = lambda _: {'running': True}
        self.panel.require_empty = lambda: self.assertEqual(self.panel.players(), 2)
        with patch.object(installer, 'management_player_count', return_value=2) as roster:
            with self.window():
                pass
            roster.assert_called_once_with(self.game / 'server.properties')


class ManagementRosterTest(unittest.TestCase):
    def check_roster(self, started, roster):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'server.properties'
            path.write_text('management-server-host=127.0.0.1\nmanagement-server-enabled=true\n'
                            'management-server-port=25585\nmanagement-server-secret=test\n')
            ws = SimpleNamespace(send=AsyncMock(), recv=AsyncMock(side_effect=[
                json.dumps({'id': 1, 'result': {'started': started}}),
                json.dumps({'id': 2, 'result': roster}),
            ]))

            @asynccontextmanager
            async def connect(*args, **kwargs):
                self.assertEqual(kwargs['additional_headers']['Authorization'], 'Bearer test')
                yield ws

            with patch.dict(sys.modules, {'websockets.asyncio.client': SimpleNamespace(connect=connect)}):
                return installer.management_player_count(path)

    def test_empty_and_occupied_rosters(self):
        self.assertEqual(self.check_roster(True, []), 0)
        self.assertEqual(self.check_roster(True, [{}, {}]), 2)

    def test_startup_and_invalid_rosters_do_not_mean_empty(self):
        for started, roster in [(False, []), (True, None), (True, {})]:
            with self.subTest(started=started, roster=roster), self.assertRaises(RuntimeError):
                self.check_roster(started, roster)


if __name__ == '__main__':
    unittest.main()

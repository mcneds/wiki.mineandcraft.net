import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import uuid
import wave
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('music_server', Path(__file__).resolve().parents[1] / 'scripts' / 'music-server.py')
music = importlib.util.module_from_spec(spec)
spec.loader.exec_module(music)
panel_spec = importlib.util.spec_from_file_location('music_panel', Path(__file__).resolve().parents[1] / 'scripts' / 'music-panel-refresh.py')
panel = importlib.util.module_from_spec(panel_spec)
panel_spec.loader.exec_module(panel)


class FakeWiki:
    def __init__(self, audio):
        self.audio, self.reports, self.reads = audio, [], 0
        self.value = {'schema': 1, 'releaseId': 'a' * 64, 'tracks': [{'id': 'a1111111-1111-4111-8111-111111111111', 'title': 'Test song', 'artist': 'A player', 'status': 'approved', 'sourceKind': 'file', 'sourceUrl': None, 'version': 1, 'audio': '/api/music/bridge/a1111111-1111-4111-8111-111111111111/audio/', 'sha256': music.digest(audio)}]}

    def manifest(self):
        return self.value

    def request(self, path):
        self.reads += 1
        return self.audio

    def report(self, manifest, status):
        self.reports.append((manifest['releaseId'], status))


class MusicServerTests(unittest.TestCase):
    def test_speaker_aliases_preserve_songs_and_share_the_existing_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.ogg'
            source.write_bytes(b'fixture-audio')
            manifest = FakeWiki(b'').value
            track_id = manifest['tracks'][0]['id']
            name = 'disc_' + track_id.replace('-', '')
            music.build_packs(manifest, {track_id: (source, 360.25)}, root / 'pack',
                              {'data_format': [121, 0], 'resource_format': [97, 1]})
            with zipfile.ZipFile(root / 'pack' / 'mineandcraft-music.zip') as pack:
                prefix = 'data/mineandcraft_music/jukebox_song/'
                original = json.loads(pack.read(prefix + name + '.json'))
                buffered = json.loads(pack.read(prefix + 'buffered/' + name + '.json'))
                self.assertEqual(buffered, {**original, 'sound_event': {'sound_id': 'mineandcraft_music:buffered.' + name}})
                self.assertEqual(buffered['length_in_seconds'], 360.25)
            resource_pack = root / 'pack' / 'music-resource-pack.zip'
            with zipfile.ZipFile(resource_pack) as pack:
                sounds = json.loads(pack.read('assets/mineandcraft_music/sounds.json'))
                self.assertTrue(sounds[name]['sounds'][0]['stream'])
                self.assertEqual(sounds['buffered.' + name], {'sounds': [{
                    'name': 'mineandcraft_music:music/' + name, 'type': 'file', 'stream': False, 'preload': False}]})
                self.assertEqual(len([p for p in pack.namelist() if p.endswith('.ogg')]), 1)
            with zipfile.ZipFile(root / 'pack' / 'mineandcraft-music.mcpack') as pack:
                self.assertEqual(json.loads(pack.read('manifest.json'))['header']['version'],
                                 [1, music.PACK_REVISION, int(manifest['releaseId'][:7], 16)])
                sounds = json.loads(pack.read('sounds/sound_definitions.json'))['sound_definitions']
                self.assertEqual(sounds['mineandcraft_music:buffered.' + name]['sounds'],
                                 [{'name': 'sounds/music/' + name, 'stream': False}])
                self.assertEqual(len([p for p in pack.namelist() if p.endswith('.ogg')]), 1)

            class ReadyPanel:
                def command(self, command): pass
                def console(self, cursor): return cursor, 'following contents: {release: "' + manifest['releaseId'] + '", pack_revision: ' + str(music.PACK_REVISION) + '}'

            with patch.object(panel.time, 'sleep'):
                panel.verify_music(ReadyPanel(), 0, '', manifest, resource_pack)
            self.assertEqual(panel.PACK_REVISION, music.PACK_REVISION)
            with patch.object(ReadyPanel, 'console', return_value=(0, 'following contents: ' + manifest['releaseId'])), \
                    patch.object(panel.time, 'sleep'), patch.object(panel.time, 'monotonic', side_effect=range(0, 1000, 10)):
                with self.assertRaisesRegex(RuntimeError, 'datapack release'):
                    panel.verify_music(ReadyPanel(), 0, '', manifest, resource_pack)
            # Old packs, streamed aliases, and absent audio must never confirm delivery.
            for fault in ('missing_alias', 'streamed_alias', 'missing_audio'):
                with self.subTest(fault=fault), zipfile.ZipFile(resource_pack) as pack:
                    entries = {name: pack.read(name) for name in pack.namelist()}
                sounds = json.loads(entries['assets/mineandcraft_music/sounds.json'])
                if fault == 'missing_alias': del sounds['buffered.' + name]
                if fault == 'streamed_alias': sounds['buffered.' + name]['sounds'][0]['stream'] = True
                if fault == 'missing_audio':
                    entries = {p: data for p, data in entries.items() if not p.endswith('.ogg')}
                entries['assets/mineandcraft_music/sounds.json'] = json.dumps(sounds).encode()
                invalid = root / (fault + '.zip')
                with zipfile.ZipFile(invalid, 'w') as pack:
                    for path, data in entries.items(): pack.writestr(path, data)
                with patch.object(panel.time, 'sleep'), patch.object(panel.time, 'monotonic', side_effect=range(0, 1000, 10)):
                    with self.assertRaisesRegex(RuntimeError, 'resource pack'):
                        panel.verify_music(ReadyPanel(), 0, '', manifest, invalid)

    def test_pack_upgrade_rebuilds_unchanged_catalogue_once_and_preserves_receipt_on_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wiki = FakeWiki(b'')
            wiki.value['tracks'] = []
            config = {'state_dir': str(root / 'state'), 'datapacks_dir': str(root / 'data'),
                      'polymer_source_dir': str(root / 'polymer'), 'data_format': [121, 0],
                      'resource_format': [97, 1], 'refresh_command': [sys.executable, '-c', 'pass']}
            music.sync(config, wiki)
            receipt = root / 'state' / 'installed.json'
            installed = json.loads(receipt.read_text())
            self.assertEqual(installed.pop('packRevision'), music.PACK_REVISION)
            receipt.write_text(json.dumps(installed))
            with patch.object(music, 'run', side_effect=RuntimeError('refresh failed')):
                with self.assertRaises(RuntimeError): music.sync(config, wiki)
            self.assertEqual(json.loads(receipt.read_text()), installed)
            with patch.object(music, 'run', wraps=music.run) as refresh:
                music.sync(config, wiki)
                refresh.assert_called_once()
            self.assertEqual(json.loads(receipt.read_text())['packRevision'], music.PACK_REVISION)
            with patch.object(music, 'run', side_effect=AssertionError('No second restart')):
                music.sync(config, wiki)

    def test_probe_accepts_long_audio_but_rejects_invalid_durations(self):
        for duration in (301, 600, 3600, 0, -1, 'nan', 'inf'):
            metadata = json.dumps({'streams': [{'codec_type': 'audio'}], 'format': {'duration': duration}}).encode()
            with self.subTest(duration=duration), patch.object(music, 'run', return_value=metadata):
                if isinstance(duration, int) and duration > 0:
                    self.assertEqual(music.probe(Path('audio')), duration)
                else:
                    with self.assertRaises(ValueError):
                        music.probe(Path('audio'))

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg and ffprobe required')
    def test_six_minute_audio_is_not_truncated_and_pack_uses_full_duration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, target = root / 'source.ogg', root / 'converted.ogg'
            music.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                       'sine=frequency=440:sample_rate=22050:duration=360', '-c:a', 'libvorbis', str(source)])
            duration = music.convert(source, target)
            self.assertAlmostEqual(duration, 360, delta=1)
            manifest = FakeWiki(b'').value
            track_id = manifest['tracks'][0]['id']
            music.build_packs(manifest, {track_id: (target, duration)}, root / 'pack',
                              {'data_format': [121, 0], 'resource_format': [97, 1]})
            song_path = root / 'pack' / 'data' / 'data' / music.NAMESPACE / 'jukebox_song' / ('disc_' + track_id.replace('-', '') + '.json')
            self.assertEqual(json.loads(song_path.read_text())['length_in_seconds'], duration)

    def test_conversion_rejects_silent_truncation_and_keeps_valid_duration(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source.audio'
            target = Path(temporary) / 'converted.ogg'
            target.write_bytes(b'audio')
            with patch.object(music, 'run'), patch.object(music, 'probe', side_effect=[289.38, 213.25]):
                with self.assertRaises(music.ToolFailure) as caught:
                    music.convert(source, target)
                self.assertEqual(caught.exception.reason, 'invalid_audio')
            with patch.object(music, 'run'), patch.object(music, 'probe', side_effect=[289.38, 289.40]):
                self.assertEqual(music.convert(source, target), 289.40)

    def test_lavalink_download_uses_exact_video_and_blocks_redirects(self):
        import http.server
        import threading
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            redirect = False
            def log_message(self, *args): pass
            def do_GET(self):
                requests.append((self.path, self.headers.get('Authorization')))
                self.send_response(302 if self.redirect else 200)
                if self.redirect: self.send_header('Location', 'https://example.com/credential-leak')
                self.end_headers()
                if not self.redirect: self.wfile.write(b'test-audio')
        with tempfile.TemporaryDirectory() as temporary, http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            root = Path(temporary); credentials = root / 'private.json'
            secret = 'private-test-password-' * 3
            credentials.write_text(json.dumps({'origin': f'http://127.0.0.1:{server.server_port}', 'password': secret}))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                source = music.lavalink_audio('https://www.youtube.com/watch?v=8FboDWxVuxc', root, str(credentials))
                self.assertEqual(source.read_bytes(), b'test-audio')
                self.assertEqual(requests, [('/youtube/stream/8FboDWxVuxc', secret)])
                Handler.redirect = True
                with self.assertRaises(music.ToolFailure) as caught:
                    music.lavalink_audio('https://www.youtube.com/watch?v=8FboDWxVuxc', root, str(credentials))
                self.assertNotIn(secret, str(caught.exception))
                credentials.write_text(json.dumps({'origin': 'https://example.com', 'password': secret}))
                with self.assertRaises(ValueError):
                    music.lavalink_audio('https://www.youtube.com/watch?v=8FboDWxVuxc', root, str(credentials))
            finally:
                server.shutdown()

    def test_lavalink_download_retains_file_size_limit(self):
        import io
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); credentials = root / 'private.json'
            credentials.write_text(json.dumps({'origin': 'http://127.0.0.1:2333', 'password': 'a' * 40}))
            from unittest.mock import MagicMock
            opener = MagicMock(); opener.open.return_value = io.BytesIO(b'audio-too-large')
            with patch.object(music, 'FILE_LIMIT', 4), patch.object(music, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(ValueError, '20 MB'):
                    music.lavalink_audio('https://www.youtube.com/watch?v=8FboDWxVuxc', root, str(credentials))

    def test_status_full_roster_join_leave_and_reconnect_snapshot(self):
        status_spec = importlib.util.spec_from_file_location('server_status', Path(__file__).resolve().parents[1] / 'scripts' / 'server-status.py')
        status = importlib.util.module_from_spec(status_spec); status_spec.loader.exec_module(status)
        roster = status.Roster()
        roster.snapshot({'started': True, 'players': [{'id': str(i), 'name': f'Player{i}'} for i in range(19)]})
        roster.event('minecraft:notification/players/joined', [{'id': 'bedrock-id', 'name': '.Bedrock player'}])
        value = roster.report(20)
        self.assertEqual(len(value['players']), 20)
        self.assertNotIn('bedrock-id', json.dumps(value))
        roster.event('minecraft:notification/players/left', [{'id':'0','name':'Player0'}])
        self.assertEqual(len(roster.report(20)['players']), 19)
        roster.snapshot({'started': True, 'players': []})
        self.assertEqual(roster.report(20), {'availability':'online','players':[],'capacity':20})
        roster.ready = False
        self.assertEqual(roster.report(20)['availability'], 'unavailable')

    def test_management_protocol_requests_roster_separately_from_server_status(self):
        import asyncio
        status_spec = importlib.util.spec_from_file_location('server_status', Path(__file__).resolve().parents[1] / 'scripts' / 'server-status.py')
        status = importlib.util.module_from_spec(status_spec); status_spec.loader.exec_module(status)
        class Socket:
            def __init__(self):
                self.sent = []
                self.messages = iter([{'id':1,'result':{'started':True,'version':{}}}, {'id':2,'result':[{'id':'internal-id','name':'.Bedrock name'}]}])
            async def recv(self): return json.dumps(next(self.messages))
            async def send(self, value): self.sent.append(json.loads(value))
        async def check():
            socket, roster, changed = Socket(), status.Roster(), asyncio.Event()
            await status.initial_receive(socket, roster, changed)
            self.assertEqual(socket.sent, [{'jsonrpc':'2.0','id':2,'method':'minecraft:players'}])
            self.assertEqual(roster.report(20)['players'], ['.Bedrock name'])
            self.assertTrue(changed.is_set())
        asyncio.run(check())

    def test_youtube_failure_classification_uses_safe_reason_codes(self):
        import subprocess
        result = subprocess.CompletedProcess(['yt-dlp'], 1, b'', b'ERROR: Sign in to confirm you are not a bot. private-url')
        with patch.object(music.subprocess, 'run', return_value=result):
            with self.assertRaises(music.ToolFailure) as caught:
                music.run(['yt-dlp', '--ignore-config'])
        self.assertEqual(caught.exception.reason, 'youtube_access_blocked')
        self.assertNotIn('private-url', str(caught.exception))

    def test_youtube_backoff_survives_restarts_and_resets_on_connection_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            track = {'id': 'a1111111-1111-4111-8111-111111111111', 'sourceUrl': 'https://www.youtube.com/watch?v=8FboDWxVuxc'}
            blocked = music.ToolFailure('blocked', 'youtube_access_blocked')
            with patch.object(music, 'youtube_audio', side_effect=blocked) as download, patch.object(music.time, 'time', return_value=1000):
                for _ in range(2):
                    with self.assertRaises(music.ToolFailure):
                        music.download_with_backoff(track, root, {}, root)
                self.assertEqual(download.call_count, 1)
            receipt = root / 'youtube-retries' / (track['id'] + '.json')
            self.assertEqual(json.loads(receipt.read_text())['retryAfter'], 1900)
            with patch.object(music, 'youtube_audio', side_effect=blocked) as download, patch.object(music.time, 'time', return_value=1901):
                with self.assertRaises(music.ToolFailure): music.download_with_backoff(track, root, {}, root)
                download.assert_called_once()
            self.assertEqual(json.loads(receipt.read_text())['retryAfter'], 3701)
            with patch.object(music, 'youtube_audio', return_value=root / 'audio.ogg') as download, patch.object(music.time, 'time', return_value=1902):
                music.download_with_backoff(track, root, {'youtube_proxy': 'http://127.0.0.1:18443'}, root)
                download.assert_called_once()
            self.assertFalse(receipt.exists())

    def test_supplied_audio_bypasses_a_blocked_youtube_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            wiki = FakeWiki(b'audio'); wiki.upload = lambda *args: None
            track = wiki.value['tracks'][0]; track['sourceKind'] = 'youtube'
            audio_path = track.pop('audio')
            config = {'state_dir': temporary, 'allow_youtube': True}
            with patch.object(music, 'youtube_audio', side_effect=music.ToolFailure('blocked', 'youtube_access_blocked')) as download:
                with self.assertRaises(music.ToolFailure): music.sync(config, wiki)
                track['audio'] = audio_path
                with patch.object(wiki, 'request', side_effect=RuntimeError('Reached stored audio')):
                    with self.assertRaisesRegex(RuntimeError, 'Reached stored audio'): music.sync(config, wiki)
                self.assertEqual(download.call_count, 1)

    def test_failed_attempt_retains_its_original_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            wiki = FakeWiki(b'audio'); wiki.upload = lambda *args: None; wiki.value['tracks'][0].pop('audio')
            wiki.value['tracks'][0]['sourceKind'] = 'youtube'
            config = {'state_dir': temporary, 'allow_youtube': True}
            with patch.object(music, 'youtube_audio', side_effect=music.ToolFailure('blocked', 'youtube_access_blocked')):
                with self.assertRaises(music.ToolFailure): music.sync(config, wiki)
            wiki.value['releaseId'] = 'b' * 64
            self.assertEqual(wiki.attempt['releaseId'], 'a' * 64)
            self.assertEqual(wiki.phase, 'fetching_audio')

    def test_ready_management_api_recovers_a_missed_console_startup_message(self):
        client = object.__new__(panel.Panel)
        client.console = lambda cursor: (2, '')
        client.management_properties = Path('/private/server.properties')
        with patch.object(panel.time, 'sleep'), patch.object(panel, 'management_ready', return_value=True) as ready:
            self.assertEqual(client.wait_start(1), (2, '\n'))
        ready.assert_called_once_with(client.management_properties)

    def test_pot_settings_apply_only_to_the_confirmed_video(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); calls = []
            def fake_run(command, **kwargs):
                calls.append(command); (root / 'source.webm').write_bytes(b'audio')
            with patch.object(music, 'run', side_effect=fake_run), patch.object(music, 'convert'):
                music.youtube_audio({'sourceKind':'youtube','sourceUrl':'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},root,{'youtube_pot':True})
            self.assertIn('youtube:player_client=mweb,tv,web_safari;fetch_pot=always', calls[0])
            self.assertEqual(calls[0][-1], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    def test_panel_commands_use_raw_stdin_and_detect_online_players(self):
        client = object.__new__(panel.Panel)
        calls = []
        client.api = lambda endpoint, data=None: calls.append((endpoint, data)) or {'running': True}
        responses = iter([(10, ''), (11, '[16:00:00] [Server thread/INFO]: System chat: There are 2 of a max of 20 players online: A, B')])
        client.console = lambda cursor=None: next(responses)
        with patch.object(panel.time, 'sleep'):
            self.assertEqual(client.players(), 2)
        self.assertIn(('console', b'list'), calls)
        client.players = lambda: 2
        with self.assertRaises(panel.Waiting):
            client.restart()
        self.assertFalse(any(endpoint == 'stop' for endpoint, _ in calls))

    def test_empty_catalogue_installs_core_once_and_online_preflight_changes_no_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wiki = FakeWiki(b'')
            wiki.value['tracks'] = []
            config = {'state_dir': str(root / 'state'), 'datapacks_dir': str(root / 'data'), 'polymer_source_dir': str(root / 'polymer'), 'data_format': [121, 0], 'resource_format': [97, 1], 'refresh_command': [sys.executable, '-c', 'pass'], 'preflight_command': [sys.executable, '-c', 'print("Players online");raise SystemExit(75)']}
            with self.assertRaises(music.Waiting):
                music.sync(config, wiki)
            self.assertFalse((root / 'data').exists())
            del config['preflight_command']
            music.sync(config, wiki)
            installed = root / 'data' / 'mineandcraft-music.zip'
            self.assertTrue(installed.is_file())
            with zipfile.ZipFile(installed) as archive:
                self.assertIn('data/mineandcraft_music/function/load.mcfunction', archive.namelist())
            with patch.object(music, 'run', side_effect=AssertionError('No second restart')):
                music.sync(config, wiki)
            self.assertEqual(len(wiki.reports), 2)

    def test_only_one_service_can_install_from_a_state_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            with music.service_lock(Path(temporary)):
                with self.assertRaises(RuntimeError):
                    with music.service_lock(Path(temporary)):
                        self.fail('A second installer acquired the lock')
            with music.service_lock(Path(temporary)):
                pass

    def test_origin_checks_prevent_credentials_being_sent_to_other_urls(self):
        for origin in ('http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'file:///secret'):
            with self.assertRaises(ValueError):
                music.Wiki(origin, 'a' * 40)
        client = music.Wiki('https://wiki.example.com', 'a' * 40)
        for path in ('https://evil.example/api/music/bridge/manifest/', '//evil.example/api/music/bridge/manifest/', '/api/players/'):
            with self.assertRaises(ValueError):
                client.request(path)

    def test_pack_formats_and_disc_codes_are_explicit_and_stable(self):
        self.assertEqual(music.pack_metadata([97, 1])['pack']['min_format'], [97, 1])
        for value in (97.1, '97.1', [97], [-1, 0], [True, 0]):
            with self.assertRaises(ValueError):
                music.pack_metadata(value)
        self.assertEqual(music.track_code('a1111111-1111-4111-8111-111111111111'), 1651506798)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg and ffprobe are needed for real audio conversion checks')
    def test_direct_delivery_converts_audio_installs_only_its_files_and_retries_ack_without_reinstall(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.wav'
            with wave.open(str(source), 'wb') as file:
                file.setnchannels(2); file.setsampwidth(2); file.setframerate(22050)
                file.writeframes(b'\x00\x00\x00\x00' * 2205)
            wiki = FakeWiki(source.read_bytes())
            config = {'state_dir': str(root / 'state'), 'datapacks_dir': str(root / 'world' / 'datapacks'), 'polymer_source_dir': str(root / 'polymer' / 'source_assets'), 'geyser_packs_dir': str(root / 'geyser' / 'packs'), 'data_format': [121, 0], 'resource_format': [97, 1], 'refresh_command': [sys.executable, '-c', 'pass']}
            unrelated = root / 'polymer' / 'source_assets' / 'assets' / 'another_mod' / 'keep.txt'
            unrelated.parent.mkdir(parents=True); unrelated.write_text('keep')
            music.sync(config, wiki)
            self.assertEqual(unrelated.read_text(), 'keep')
            self.assertEqual(wiki.reports, [('a' * 64, 'installed')])
            installed_pack = root / 'world' / 'datapacks' / 'mineandcraft-music.zip'
            original = installed_pack.read_bytes()
            with zipfile.ZipFile(installed_pack) as pack:
                song = json.loads(pack.read('data/mineandcraft_music/jukebox_song/disc_a1111111111141118111111111111111.json'))
                self.assertGreater(song['length_in_seconds'], 0)
                self.assertLess(song['length_in_seconds'], 1)
                claim = pack.read('data/mineandcraft_music/function/claim.mcfunction').decode()
                self.assertIn('if items entity @s weapon.mainhand *[minecraft:jukebox_playable]', claim)
                self.assertIn('scoreboard players reset @s mac_music', claim)
                self.assertIn('run item modify entity @s weapon.mainhand mineandcraft_music:disc_a1111111111141118111111111111111', claim)
                self.assertNotIn('item replace', claim)
                modifier = json.loads(pack.read('data/mineandcraft_music/item_modifier/disc_a1111111111141118111111111111111.json'))
                self.assertEqual(modifier, {'type': 'minecraft:set_components', 'components': {
                    'minecraft:jukebox_playable': 'mineandcraft_music:disc_a1111111111141118111111111111111',
                    'minecraft:item_name': {'text': 'A player - Test song'},
                }})
            with zipfile.ZipFile(root / 'geyser' / 'packs' / 'mineandcraft-music.mcpack') as pack:
                self.assertIn('sounds/sound_definitions.json', pack.namelist())
                self.assertEqual(json.loads(pack.read('manifest.json'))['modules'][0]['type'], 'resources')
            music.sync(config, wiki)
            self.assertEqual(wiki.reads, 1)
            self.assertEqual(installed_pack.read_bytes(), original)
            self.assertEqual(len(wiki.reports), 2)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg and ffprobe required')
    def test_failed_server_refresh_restores_previous_files_and_does_not_acknowledge_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.wav'
            with wave.open(str(source), 'wb') as file:
                file.setnchannels(1); file.setsampwidth(2); file.setframerate(22050); file.writeframes(b'\x00\x00' * 2205)
            wiki = FakeWiki(source.read_bytes())
            datapacks = root / 'world' / 'datapacks'; datapacks.mkdir(parents=True)
            target = datapacks / 'mineandcraft-music.zip'; target.write_bytes(b'previous-pack')
            config = {'state_dir': str(root / 'state'), 'datapacks_dir': str(datapacks), 'polymer_source_dir': str(root / 'polymer' / 'source_assets'), 'data_format': [121, 0], 'resource_format': [97, 1], 'refresh_command': [sys.executable, '-c', 'raise SystemExit(1)']}
            with self.assertRaises(RuntimeError):
                music.sync(config, wiki)
            self.assertEqual(target.read_bytes(), b'previous-pack')
            self.assertEqual(wiki.reports, [])
            self.assertFalse((root / 'state' / 'installed.json').exists())

    def test_youtube_is_individual_video_only_and_never_falls_back_to_another_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            for source in ('https://evil.example/song', 'https://www.youtube.com/playlist?list=123', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'):
                with self.assertRaises(ValueError):
                    music.youtube_audio({'sourceUrl': source}, Path(temporary))

    def test_youtube_relay_is_loopback_only_and_preserves_limits_and_recording(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            track = {'sourceUrl': 'https://www.youtube.com/watch?v=8FboDWxVuxc'}
            for proxy in ('http://public.example:8080', 'http://user:secret@127.0.0.1:8080',
                          'http://127.0.0.1:bad', 'http://127.0.0.1', 'file:///secret',
                          'http://127.0.0.1:8080/path', 'http://127.0.0.1:8080?secret=x'):
                with self.assertRaises(ValueError), patch.object(music, 'run') as run:
                    music.youtube_audio(track, root, {'youtube_proxy': proxy})
                run.assert_not_called()
            def download(command, **kwargs):
                self.assertEqual(command[command.index('--proxy') + 1], 'http://127.0.0.1:18443')
                self.assertEqual(command[command.index('--max-filesize') + 1], str(music.FILE_LIMIT))
                self.assertEqual(command[command.index('--match-filter') + 1], '!is_live')
                self.assertEqual(command[-2:], ['--', track['sourceUrl']])
                (root / 'source.webm').write_bytes(b'audio')
            with patch.object(music, 'run', side_effect=download), patch.object(music, 'convert'):
                music.youtube_audio(track, root, {'youtube_proxy': 'http://127.0.0.1:18443'})

    def test_spotify_download_uses_only_the_explicitly_confirmed_recording(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            track = {'sourceKind': 'spotify', 'sourceUrl': 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'}
            for url in (None, 'https://evil.test/audio', 'https://www.youtube.com/playlist?list=123'):
                with self.assertRaises(ValueError):
                    music.youtube_audio({**track, 'audioSourceUrl': url or ''}, root)
            calls = []
            def fake_run(command, **kwargs):
                calls.append(command)
                (root / 'source.webm').write_bytes(b'audio')
            with patch.object(music, 'run', side_effect=fake_run), patch.object(music, 'convert'):
                music.youtube_audio({**track, 'audioSourceUrl': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}, root)
            self.assertEqual(calls[0][-1], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
            self.assertNotIn(track['sourceUrl'], calls[0])


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""VPS music bridge. Uses only stdlib, ffmpeg/ffprobe, and optional yt-dlp.

The site never sends shell commands or filesystem paths. Installation paths and
the command which refreshes Minecraft are configured locally by the server owner.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
import uuid
import zipfile
import zlib

FILE_LIMIT = 20 * 1024 * 1024
NAMESPACE = 'mineandcraft_music'
# Rebuild installed catalogues once when the generated pack contract changes.
PACK_REVISION = 3


class ToolFailure(RuntimeError):
    def __init__(self, message, reason='installation_failed'):
        super().__init__(message)
        self.reason = reason


class Waiting(RuntimeError):
    pass


@contextmanager
def service_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'bridge.lock').open('a+b') as lock:
        try:
            if os.name == 'nt':
                import msvcrt
                if lock.tell() == 0:
                    lock.write(b'0'); lock.flush()
                lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError('Another music service is already using this state directory.') from None
        try:
            yield
        finally:
            if os.name == 'nt':
                lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('The wiki redirected a private music request. Check site_origin.')


class Wiki:
    def __init__(self, origin, key):
        url = urlparse(origin)
        if not (url.scheme == 'https' or (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost'))):
            raise ValueError('site_origin must use HTTPS (HTTP is allowed only for local development).')
        if url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError('site_origin must contain only the wiki origin.')
        if len(key) < 32:
            raise ValueError('Set MUSIC_BRIDGE_KEY to the same secret configured on the wiki.')
        self.attempt = None
        self.track_id = None
        self.phase = 'queued'
        self.origin, self.key, self.opener = origin.rstrip('/'), key, build_opener(NoRedirect())

    def request(self, path, data=None, content_type='application/json', maximum=FILE_LIMIT):
        if not re.fullmatch(r'/api/music/bridge/[a-z0-9/-]+/', path):
            raise ValueError('Invalid music bridge endpoint.')
        request = Request(self.origin + path, data=data, headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': content_type, 'User-Agent': 'mineandcraft-music/1.0'})
        try:
            with self.opener.open(request, timeout=90) as response:
                value = response.read(maximum + 1)
                if len(value) > maximum:
                    raise RuntimeError('A music response exceeded its size limit.')
                return value
        except HTTPError as error:
            raise RuntimeError(f'The wiki rejected a music request (HTTP {error.code}).') from None

    def manifest(self):
        value = json.loads(self.request('/api/music/bridge/manifest/', maximum=2 * 1024 * 1024))
        if value.get('schema') != 1 or not re.fullmatch('[a-f0-9]{64}', value.get('releaseId', '')):
            raise ValueError('The wiki returned an invalid music catalogue.')
        for track in value.get('tracks', []):
            if str(uuid.UUID(track['id'])) != track['id'] or len(track['title']) > 100 or len(track['artist']) > 100:
                raise ValueError('The wiki returned invalid track details.')
            if track.get('audio') and track['audio'] != f"/api/music/bridge/{track['id']}/audio/":
                raise ValueError('The wiki returned an invalid audio endpoint.')
            if track.get('audioSourceUrl') and (track.get('sourceKind') != 'spotify' or not re.fullmatch(r'https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}', track['audioSourceUrl'])):
                raise ValueError('The wiki returned an invalid confirmed recording.')
        return value

    def report(self, manifest, status, message=''):
        self.request('/api/music/bridge/report/', json.dumps({'releaseId': manifest['releaseId'], 'catalogueVersion': manifest.get('catalogueVersion'), 'status': status, 'message': message}).encode())

    def progress(self, manifest, track_id, phase, reason=''):
        self.request('/api/music/bridge/progress/', json.dumps({'releaseId': manifest['releaseId'], 'catalogueVersion': manifest['catalogueVersion'], 'trackId': track_id, 'phase': phase, 'reason': reason}).encode())

    def heartbeat(self):
        self.request('/api/music/bridge/heartbeat/', b'{}')

    def upload(self, track, audio):
        boundary = 'mac-' + uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="converted.ogg"\r\nContent-Type: audio/ogg\r\n\r\n'.encode()
                + audio.read_bytes() + f'\r\n--{boundary}--\r\n'.encode())
        self.request(f"/api/music/bridge/{track['id']}/audio/", body, f'multipart/form-data; boundary={boundary}')


def run(command, timeout=180):
    # No shell interpolation. Provider logs can contain URLs or credentials, so
    # report only a generic failure; inspect local tools separately when needed.
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('A required music tool is missing or timed out.') from None
    if result.returncode == 75:
        raise Waiting(result.stdout.decode('utf-8', errors='replace').strip()[:500] or 'Publishing is waiting for an empty server.')
    if result.returncode:
        if Path(command[0]).name == 'yt-dlp':
            blocked = any(marker in result.stderr.lower() for marker in (b'not a bot', b'sign in to confirm', b'http error 403', b'http error 429', b'too many requests', b'login required'))
            raise ToolFailure('Audio download blocked by YouTube' if blocked else 'Audio source unavailable', 'youtube_access_blocked' if blocked else 'provider_unavailable')
        raise ToolFailure(f'{Path(command[0]).name} could not process the track or refresh the server.', 'invalid_audio' if Path(command[0]).name in ('ffmpeg', 'ffprobe') else 'installation_failed')
    return result.stdout


def probe(path):
    data = json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', str(path)]))
    streams = [stream for stream in data.get('streams', []) if stream.get('codec_type') == 'audio']
    duration = float(data.get('format', {}).get('duration', 0))
    if not streams or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Tracks must contain valid audio with a finite, positive duration.')
    return duration


def convert(source, target):
    expected_duration = probe(source)
    run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-y', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-filter_threads', '1', '-i', str(source),
         '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '44100', '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-c:a', 'libvorbis', '-q:a', '4', '-map_metadata', '-1', str(target)])
    if not (0 < target.stat().st_size <= FILE_LIMIT):
        raise ValueError('Converted audio exceeds the 20 MB track limit.')
    duration = probe(target)
    if abs(duration - expected_duration) > max(1, expected_duration * 0.01):
        raise ToolFailure('Audio is incomplete; converted duration differs from the source.', 'invalid_audio')
    return duration


def youtube_audio(track, directory, options=None):
    source_url = track.get('audioSourceUrl', '') if track.get('sourceKind') == 'spotify' else track.get('sourceUrl', '')
    if not re.fullmatch(r'https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}', source_url):
        raise ValueError('Only individual YouTube video links can be downloaded.')
    extra = []
    options = options or {}
    if options.get('youtube_lavalink_config'):
        target = directory / 'converted.ogg'
        source = lavalink_audio(source_url, directory, options['youtube_lavalink_config'])
        convert(source, target)
        return target
    proxy = options.get('youtube_proxy')
    if proxy:
        endpoint = urlparse(proxy)
        try:
            valid_port = endpoint.port is not None and 0 < endpoint.port <= 65535
        except ValueError:
            valid_port = False
        if (endpoint.scheme not in ('http', 'socks5', 'socks5h') or
                endpoint.hostname not in ('127.0.0.1', '::1') or not valid_port or
                endpoint.username or endpoint.password or endpoint.path not in ('', '/') or endpoint.query or endpoint.fragment):
            raise ValueError('youtube_proxy must be a loopback proxy URL with an explicit port.')
        # Scope the relay to yt-dlp. Wiki credentials and Minecraft traffic must
        # continue to use their normal connections.
        extra += ['--proxy', proxy]
    if options.get('youtube_pot', False):
        extra += ['--extractor-args', 'youtube:player_client=mweb,tv,web_safari;fetch_pot=always']
    cookie_file = options.get('youtube_cookies')
    if cookie_file:
        cookie_path = Path(cookie_file)
        if not cookie_path.is_absolute() or not cookie_path.is_file():
            raise ValueError('The private YouTube cookie file is not available.')
        private_copy = directory / 'youtube-cookies.txt'
        shutil.copyfile(cookie_path, private_copy)
        private_copy.chmod(0o600)
        extra += ['--cookies', str(private_copy)]
    try:
        run(['yt-dlp', '--ignore-config', '--no-playlist', '--no-progress', '--no-warnings',
             '--sleep-requests', '1', '--sleep-interval', '5', '--retries', '1', '--extractor-retries', '0', '--fragment-retries', '1', '--socket-timeout', '20', '--max-filesize', str(FILE_LIMIT),
             '--match-filter', '!is_live', '-f', 'bestaudio', '-o', str(directory / 'source.%(ext)s'), *extra, '--', source_url], timeout=180)
    except RuntimeError as error:
        raise ToolFailure('YouTube could not provide audio. Request changes and attach an audio file instead.', getattr(error, 'reason', 'provider_unavailable')) from None
    files = [path for path in directory.glob('source.*') if path.suffix not in ('.part', '.ytdl')]
    if len(files) != 1 or files[0].stat().st_size > FILE_LIMIT:
        raise ValueError('YouTube audio is unavailable or exceeds the track limits. Attach an audio file instead.')
    target = directory / 'converted.ogg'
    convert(files[0], target)
    return target


def lavalink_audio(source_url, directory, credentials_path):
    class NoAudioRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    path = Path(credentials_path)
    if not path.is_absolute() or not path.is_file():
        raise ValueError('The private Lavalink connection file is not available.')
    credentials = json.loads(path.read_text(encoding='utf-8'))
    origin = credentials.get('origin', '')
    url = urlparse(origin)
    if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', '::1') or
            url.username or url.password or url.path not in ('', '/') or url.query or url.fragment):
        raise ValueError('Lavalink must use a private loopback HTTP address.')
    password = credentials.get('password', '')
    if not isinstance(password, str) or len(password) < 32:
        raise ValueError('Lavalink requires a private password of at least 32 characters.')
    if not re.fullmatch(r'https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}', source_url):
        raise ValueError('Only individual YouTube video links can be downloaded.')
    request = Request(origin.rstrip('/') + '/youtube/stream/' + source_url[-11:],
                      headers={'Authorization': password, 'User-Agent': 'mineandcraft-music/1.0'})
    source = directory / 'source.audio'
    deadline = time.monotonic() + 180
    try:
        with build_opener(NoAudioRedirect()).open(request, timeout=20) as response, source.open('wb') as output:
            size = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > FILE_LIMIT:
                    raise ValueError('YouTube audio exceeds the 20 MB track limit.')
                if time.monotonic() > deadline:
                    raise ToolFailure('The server audio source timed out.', 'provider_unavailable')
                output.write(chunk)
    except HTTPError as error:
        error.close()
        raise ToolFailure('The server audio source could not provide this recording.', 'provider_unavailable') from None
    except (URLError, OSError, RuntimeError):
        raise ToolFailure('The server audio source could not provide this recording.', 'provider_unavailable') from None
    return source


def download_with_backoff(track, directory, config, state):
    # Preserve the cooldown across service restarts. Uploading an audio file
    # bypasses this path entirely; changing the source or connection retries now.
    cookie = Path(config['youtube_cookies']) if config.get('youtube_cookies') else None
    fingerprint = digest(json.dumps([track.get('sourceUrl'), track.get('audioSourceUrl'),
        config.get('youtube_proxy'), config.get('youtube_pot'), config.get('youtube_lavalink_config'), str(cookie),
        cookie.stat().st_mtime_ns if cookie and cookie.is_file() else None]).encode())
    receipt = state / 'youtube-retries' / (track['id'] + '.json')
    previous = json.loads(receipt.read_text()) if receipt.is_file() else {}
    if previous.get('fingerprint') != fingerprint:
        previous = {}
    now = time.time()
    if previous.get('retryAfter', 0) > now:
        when = time.strftime('%H:%M UTC', time.gmtime(previous['retryAfter']))
        raise ToolFailure(f'YouTube download is cooling down; next attempt after {when}.', previous['reason'])
    try:
        result = youtube_audio(track, directory, config)
    except ToolFailure as error:
        if error.reason in ('youtube_access_blocked', 'provider_unavailable'):
            failures = min(8, previous.get('failures', 0) + 1)
            delay = min(21600, (900 if error.reason == 'youtube_access_blocked' else 300) * 2 ** (failures - 1))
            write_json(receipt, {'fingerprint': fingerprint, 'failures': failures,
                                'retryAfter': time.time() + delay, 'reason': error.reason})
        raise
    receipt.unlink(missing_ok=True)
    return result


def track_code(track_id):
    return (zlib.crc32(track_id.encode()) & 0x7fffffff) or 1


def pack_metadata(version):
    if not isinstance(version, list) or len(version) != 2 or not all(type(value) is int and value >= 0 for value in version):
        raise ValueError('Pack formats must be [major, minor] pairs for the running Minecraft version.')
    return {'pack': {'description': 'mineandcraft.net music discs', 'min_format': version, 'max_format': version}}


def zip_directory(directory, target):
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob('*')):
            if path.is_file():
                archive.write(path, path.relative_to(directory).as_posix())


def build_packs(manifest, audio, directory, config):
    java, data, bedrock = (directory / name for name in ('java', 'data', 'bedrock'))
    write_json(java / 'pack.mcmeta', pack_metadata(config['resource_format']))
    write_json(data / 'pack.mcmeta', pack_metadata(config['data_format']))
    sounds, bedrock_sounds, commands, claims, codes = {}, {}, [], [], set()
    for track in manifest['tracks']:
        name = 'disc_' + track['id'].replace('-', '')
        source, duration = audio[track['id']]
        sound_id = f'{NAMESPACE}:{name}'
        target = java / 'assets' / NAMESPACE / 'sounds' / 'music' / (name + '.ogg')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        bedrock_target = bedrock / 'sounds' / 'music' / (name + '.ogg')
        bedrock_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, bedrock_target)
        sounds[name] = {'sounds': [{'name': f'{NAMESPACE}:music/{name}', 'stream': True}]}
        buffered_sound = f'{NAMESPACE}:buffered.{name}'
        sounds['buffered.' + name] = {'sounds': [{'name': f'{NAMESPACE}:music/{name}', 'type': 'file', 'stream': False, 'preload': False}]}
        bedrock_sounds[sound_id] = {'category': 'record', 'sounds': [{'name': 'sounds/music/' + name, 'stream': True}]}
        bedrock_sounds[buffered_sound] = {'category': 'record', 'sounds': [{'name': 'sounds/music/' + name, 'stream': False}]}
        label = f"{track['artist']} - {track['title']}" if track['artist'] else track['title']
        song = {'sound_event': {'sound_id': sound_id}, 'description': {'text': label}, 'length_in_seconds': duration, 'comparator_output': 1}
        write_json(data / 'data' / NAMESPACE / 'jukebox_song' / (name + '.json'), song)
        write_json(data / 'data' / NAMESPACE / 'jukebox_song' / 'buffered' / (name + '.json'),
                   {**song, 'sound_event': {'sound_id': buffered_sound}})
        item = f'minecraft:music_disc_13[minecraft:jukebox_playable={json.dumps(sound_id)},minecraft:item_name={json.dumps({"text": label}, ensure_ascii=False)}]'
        command = f'give @s {item}'
        function = data / 'data' / NAMESPACE / 'function' / 'give' / (name + '.mcfunction')
        function.parent.mkdir(parents=True, exist_ok=True)
        function.write_text(command + '\n', encoding='utf-8')
        code = track_code(track['id'])
        if code in codes:
            raise ValueError('Two tracks have the same claim code; publishing requires an owner review.')
        codes.add(code)
        # Modify the existing stack: keep its base disc, model, count and other
        # components. Minecraft 26.3 uses `type` for loot/item modifiers.
        write_json(data / 'data' / NAMESPACE / 'item_modifier' / (name + '.json'), {
            'type': 'minecraft:set_components',
            'components': {'minecraft:jukebox_playable': sound_id, 'minecraft:item_name': {'text': label}},
        })
        claims.append(f'execute if score @s mac_music matches {code} if items entity @s weapon.mainhand *[minecraft:jukebox_playable] run item modify entity @s weapon.mainhand {sound_id}')
        commands.append(f"{label}\nHold any music disc (its base type is preserved) and use: /trigger mac_music set {code}\nOwner: /function {NAMESPACE}:give/{name}\n")
    write_json(java / 'assets' / NAMESPACE / 'sounds.json', sounds)
    write_json(bedrock / 'sounds' / 'sound_definitions.json', {'format_version': '1.14.0', 'sound_definitions': bedrock_sounds})
    # The old oversized patch number caused Bedrock to reject pack negotiation.
    # Keep the same release fingerprint, split into 12-bit and 16-bit parts.
    # Revision 3 also supersedes the manifest-only 2.3.0 repair deployed live.
    version = [PACK_REVISION, int(manifest['releaseId'][:3], 16), int(manifest['releaseId'][3:7], 16)]
    write_json(bedrock / 'manifest.json', {'format_version': 2, 'header': {'name': 'mineandcraft.net music', 'description': 'Member music discs', 'uuid': str(uuid.uuid5(uuid.NAMESPACE_DNS, 'music.mineandcraft.net')), 'version': version, 'min_engine_version': config.get('bedrock_engine', [1, 21, 0])}, 'modules': [{'type': 'resources', 'uuid': str(uuid.uuid5(uuid.NAMESPACE_DNS, 'music.mineandcraft.net.resources')), 'version': version}]})
    functions = data / 'data' / NAMESPACE / 'function'
    functions.mkdir(parents=True, exist_ok=True)
    (functions / 'load.mcfunction').write_text('scoreboard objectives add mac_music trigger\n' + f'data modify storage {NAMESPACE}:delivery release set value {json.dumps(manifest["releaseId"])}\ndata modify storage {NAMESPACE}:delivery claim_format set value 2\ndata modify storage {NAMESPACE}:delivery pack_revision set value {PACK_REVISION}\n', encoding='utf-8')
    (functions / 'tick.mcfunction').write_text(f'scoreboard players enable @a mac_music\nexecute as @a[scores={{mac_music=1..}}] run function {NAMESPACE}:claim\n', encoding='utf-8')
    (functions / 'claim.mcfunction').write_text('\n'.join(claims + ['scoreboard players reset @s mac_music']) + '\n', encoding='utf-8')
    for event in ('load', 'tick'):
        write_json(data / 'data' / 'minecraft' / 'tags' / 'function' / (event + '.json'), {'values': [f'{NAMESPACE}:{event}']})
    (directory / 'disc-commands.txt').write_text('\n'.join(commands), encoding='utf-8')
    for source, filename in ((java, 'music-resource-pack.zip'), (data, 'mineandcraft-music.zip'), (bedrock, 'mineandcraft-music.mcpack')):
        zip_directory(source, directory / filename)


def install_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.music-new')
    shutil.copyfile(source, temporary)
    os.replace(temporary, target)


def progress(wiki, manifest, phase, track=None, reason=''):
    wiki.phase = phase
    if track is not None:
        wiki.track_id = track['id']
    targets = [track] if track else manifest['tracks']
    for value in targets:
        if value.get('status') == 'released' and phase != 'installed':
            continue
        if hasattr(wiki, 'progress'):
            wiki.progress(manifest, value['id'], phase, reason)


def sync(config, wiki):
    wiki.attempt = None
    wiki.track_id = None
    manifest = wiki.manifest()
    wiki.attempt = json.loads(json.dumps(manifest))
    progress(wiki, manifest, 'queued')
    state = Path(config['state_dir']).resolve()
    state.mkdir(parents=True, exist_ok=True)
    if (state / 'installed.json').exists():
        installed = json.loads((state / 'installed.json').read_text(encoding='utf-8'))
        configuration_id = digest(json.dumps(config, sort_keys=True).encode())
        if (installed.get('releaseId') == manifest['releaseId'] and installed.get('configurationId') == configuration_id
                and installed.get('packRevision') == PACK_REVISION):
            # Retry a lost acknowledgement, without touching the server again.
            wiki.report(manifest, 'installed')
            return
    for track in manifest['tracks']:
        if track.get('audio'):
            continue
        if not (track['sourceKind'] == 'youtube' or (track['sourceKind'] == 'spotify' and track.get('audioSourceUrl'))) or not config.get('allow_youtube', False):
            raise ValueError('A track needs an audio file. YouTube downloads are disabled or this source cannot provide audio.')
        progress(wiki, manifest, 'fetching_audio', track)
        with tempfile.TemporaryDirectory(dir=state) as temporary:
            try:
                wiki.upload(track, download_with_backoff(track, Path(temporary), config, state))
            except (RuntimeError, ValueError) as error:
                raise ToolFailure(f'{track["title"]}: {error}', getattr(error, 'reason', 'invalid_audio')) from None
        return  # Re-fetch the catalogue after the stored source changes.
    cache = state / 'audio'
    cache.mkdir(exist_ok=True)
    audio = {}
    with tempfile.TemporaryDirectory(dir=state) as temporary:
        work = Path(temporary)
        for track in manifest['tracks']:
            progress(wiki, manifest, 'converting', track)
            sha = track.get('sha256', '')
            if not re.fullmatch('[a-f0-9]{64}', sha):
                raise ValueError('A source is missing its checksum.')
            converted = cache / (sha + '.ogg')
            if not converted.exists():
                original = wiki.request(track['audio'])
                if digest(original) != sha:
                    raise ValueError('An audio source failed checksum validation.')
                source = work / 'source.audio'
                source.write_bytes(original)
                pending = work / 'converted.ogg'
                duration = convert(source, pending)
                os.replace(pending, converted)
            else:
                duration = probe(converted)
            audio[track['id']] = (converted, duration)
        build_packs(manifest, audio, work, config)
        if (work / 'music-resource-pack.zip').stat().st_size > int(config.get('pack_limit_bytes', 100 * 1024 * 1024)):
            raise ValueError('The music pack exceeds the configured download limit. The server was not changed.')
        if wiki.manifest()['releaseId'] != manifest['releaseId']:
            raise RuntimeError('The approved collection changed while building. The server was not changed.')
        if config.get('preflight_command'):
            run(config['preflight_command'], timeout=60)
        progress(wiki, manifest, 'installing')
        # Back up the exact files this service owns. Do not replace the server's
        # existing pack or other mods' assets with a music-only resource pack.
        targets = [(work / 'mineandcraft-music.zip', Path(config['datapacks_dir']) / 'mineandcraft-music.zip'),
                   (work / 'java' / 'assets' / NAMESPACE / 'sounds.json', Path(config['polymer_source_dir']) / 'assets' / NAMESPACE / 'sounds.json')]
        for source in (work / 'java' / 'assets' / NAMESPACE / 'sounds').rglob('*.ogg'):
            targets.append((source, Path(config['polymer_source_dir']) / 'assets' / NAMESPACE / 'sounds' / 'music' / source.name))
        if config.get('geyser_packs_dir'):
            targets.append((work / 'mineandcraft-music.mcpack', Path(config['geyser_packs_dir']) / 'mineandcraft-music.mcpack'))
        backups = []
        try:
            write_json(state / 'pending-install.json', manifest)
            for index, (source, target) in enumerate(targets):
                target = target.resolve()
                backup = work / f'backup-{index}'
                existed = target.is_file()
                if existed:
                    shutil.copyfile(target, backup)
                backups.append((target, backup, existed))
                install_file(source, target)
            run(config['refresh_command'], timeout=480)
        except Exception as error:
            for target, backup, existed in reversed(backups):
                if existed:
                    install_file(backup, target)
                else:
                    target.unlink(missing_ok=True)
            if not isinstance(error, Waiting) and config.get('recovery_command'):
                try:
                    run(config['recovery_command'], timeout=480)
                except Exception:
                    pass
            raise
        install_file(work / 'disc-commands.txt', state / 'disc-commands.txt')
        write_json(state / 'installed.json', {'releaseId': manifest['releaseId'], 'configurationId': digest(json.dumps(config, sort_keys=True).encode()), 'packRevision': PACK_REVISION})
    wiki.report(manifest, 'installed')
    keep = {track['sha256'] + '.ogg' for track in manifest['tracks']}
    for cached in cache.glob('*.ogg'):
        if re.fullmatch('[a-f0-9]{64}\.ogg', cached.name) and cached.name not in keep:
            cached.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    for field in ('state_dir', 'datapacks_dir', 'polymer_source_dir'):
        if not isinstance(config.get(field), str) or not Path(config[field]).is_absolute():
            raise ValueError(f'{field} must be an explicit absolute server path.')
    refresh = config.get('refresh_command')
    if not isinstance(refresh, list) or not refresh or not all(isinstance(part, str) for part in refresh) or not Path(refresh[0]).is_absolute():
        raise ValueError('refresh_command must be a fixed local command with an absolute executable path.')
    pack_metadata(config['data_format']); pack_metadata(config['resource_format'])
    wiki = Wiki(config['site_origin'], os.environ.get('MUSIC_BRIDGE_KEY', ''))
    stopped = threading.Event()
    def heartbeat_loop():
        heartbeat_client = Wiki(config['site_origin'], os.environ.get('MUSIC_BRIDGE_KEY', ''))
        while not stopped.is_set():
            try:
                heartbeat_client.heartbeat()
            except Exception:
                pass
            stopped.wait(15)
    threading.Thread(target=heartbeat_loop, daemon=True, name='music-heartbeat').start()
    with service_lock(Path(config['state_dir'])):
        while True:
            try:
                wiki.attempt = None
                with service_lock(Path(config['state_dir']) / 'operations'):
                    sync(config, wiki)
            except Waiting as error:
                print(str(error), flush=True)
                try:
                    if wiki.attempt:
                        phase = 'waiting_for_empty_server' if re.search(r'\d+ players online', str(error)) else 'queued'
                        progress(wiki, wiki.attempt, phase)
                        wiki.report(wiki.attempt, 'waiting', str(error))
                except Exception:
                    pass
            except Exception as error:
                print(f'Music update failed: {error}', flush=True)
                try:
                    if wiki.attempt:
                        reason = getattr(error, 'reason', 'invalid_audio' if isinstance(error, ValueError) else 'installation_failed')
                        track = next((value for value in wiki.attempt['tracks'] if value['id'] == wiki.track_id), None) if wiki.phase in ('fetching_audio', 'converting') else None
                        progress(wiki, wiki.attempt, 'failed', track, reason)
                        wiki.report(wiki.attempt, 'failed', str(error))
                except Exception:
                    pass
                if args.once:
                    raise SystemExit(1)
            if args.once:
                return
            time.sleep(max(30, int(config.get('poll_seconds', 60))))


if __name__ == '__main__':
    main()

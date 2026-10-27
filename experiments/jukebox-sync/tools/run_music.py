"""Generate private test assets, run Minecraft, and capture its actual WASAPI output.

Requires ffmpeg, numpy, scipy, and PyAudioWPatch. The supplied recording and all
derived audio stay under ignored build/. No music is added to the shipped mod.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time

import numpy as np
import pyaudiowpatch as pa
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('music', type=Path)
    parser.add_argument('--name', default='music-listening')
    parser.add_argument('--rounds', type=int, default=6)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--compare', action='store_true')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--sodium-only', action='store_true')
    parser.add_argument('--stress', type=int, default=0)
    parser.add_argument('--speakers', type=int, default=8)
    parser.add_argument('--long-seconds', type=float, default=0)
    parser.add_argument('--quick-rounds', type=int, default=0)
    args = parser.parse_args()
    destination = (ROOT / 'build' / args.name).resolve()
    if not destination.is_relative_to((ROOT / 'build').resolve()):
        raise ValueError('Output must stay inside the lab build directory')
    destination.mkdir(exist_ok=False)
    exchange = destination / 'exchange'
    exchange.mkdir()
    fixture = ROOT / 'build/music-fixture'
    assets = fixture / 'assets/musiclab'
    (assets / 'sounds').mkdir(parents=True, exist_ok=True)
    data = fixture / 'data/musiclab/jukebox_song'
    data.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels',
        '-of', 'json', str(args.music)], text=True))
    duration = float(metadata['format']['duration'])
    if max(args.seconds, args.long_seconds) + 5 >= duration:
        raise ValueError('Recording window must leave time before the song ends')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(args.music),
                    '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-c:a', 'libvorbis', '-q:a', '8',
                    str(assets / 'sounds/music.ogg')], check=True)
    (assets / 'sounds.json').write_text(json.dumps({mode: {
        'sounds': [{'name': 'musiclab:music', 'stream': mode == 'streamed', 'preload': False}]}
        for mode in ['buffered', 'streamed']}, indent=2))
    for mode in ['buffered', 'streamed']:
        (data / f'{mode}.json').write_text(json.dumps({
        'sound_event': {'sound_id': f'musiclab:{mode}'},
        'description': {'text': 'Private listening experiment'},
        'length_in_seconds': duration, 'comparator_output': 1
        }))
    # Always copy the freshly generated fixture into the launch resources.
    # Skipping this would let the capture manifest describe a different OGG
    # from the one actually loaded by the game.
    subprocess.run(['cmd.exe', '/d', '/c', 'gradlew.bat', 'prepareLabClient'] + (['-Pbaseline'] if args.baseline else ['-PsodiumOnly'] if args.sodium_only else []), cwd=ROOT, check=True)
    manifest = {
        'inputName': args.music.name,
        'inputSha256': hashlib.sha256(args.music.read_bytes()).hexdigest(),
        'inputMetadata': metadata,
        'assetSha256': hashlib.sha256((assets / 'sounds/music.ogg').read_bytes()).hexdigest(),
        'conversion': 'Full track downmixed to mono, 48000 Hz, Vorbis quality 8; identical asset in every source and reference',
        'scope': 'Windows endpoint loopback, not a microphone or analog DAC measurement; other apps on the same endpoint can contaminate it',
        'captures': []
    }
    environment = dict(os.environ, SYNCLAB_MUSIC='true', SYNCLAB_NETWORK='false',
                       SYNCLAB_ROUNDS=str(args.rounds), SYNCLAB_MUSIC_SECONDS=str(args.seconds),
                       SYNCLAB_MUSIC_COMPARE=str(args.compare).lower(), SYNCLAB_STRESS=str(args.stress),
                       SYNCLAB_SPEAKERS=str(args.speakers), SYNCLAB_LONG_SECONDS=str(args.long_seconds),
                       SYNCLAB_QUICK_ROUNDS=str(args.quick_rounds),
                       SYNCLAB_CAPTURE_DIR=str(destination))
    java = ROOT / '.runtime/zulu25.38.107-ca-jre25.0.5-win_x64/bin/java.exe'
    active = None
    chunks = []
    errors = []
    lock = threading.Lock()

    def callback(data, frames, timing, status):
        with lock:
            if active is not None:
                chunks.append(data)
                if status:
                    errors.append({'status': status, 'time': timing})
        return None, pa.paContinue

    with pa.PyAudio() as audio, (destination / 'client.log').open('wb') as log:
        endpoint = audio.get_default_wasapi_loopback()
        manifest['endpoint'] = endpoint
        rate = int(endpoint['defaultSampleRate'])
        channels = int(endpoint['maxInputChannels'])
        # Initialize the game/output device before opening the loopback stream.
        # This also keeps unrelated startup sounds out of the recording session.
        with contextlib.ExitStack() as capture_stack:
            process = subprocess.Popen([str(java), '@build/ide-vm.args', 'net.fabricmc.devlaunchinjector.Main'],
                                       cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
            print(f'Minecraft PID {process.pid}; recording {endpoint["name"]}; output {destination}', flush=True)
            seen = set()
            deadline = time.monotonic() + max(1200, 600 + args.rounds * 3 * (args.seconds + 5) + 2 * args.long_seconds + args.quick_rounds * 8)
            try:
                while process.poll() is None:
                    if time.monotonic() > deadline:
                        raise TimeoutError('Music run exceeded the calculated deadline')
                    timing_file = destination / 'source-timing.json'
                    if timing_file.exists() and 'gameDevice' not in manifest:
                        try:
                            game_device = json.loads(timing_file.read_text())['device']
                        except (json.JSONDecodeError, KeyError):
                            time.sleep(.02)
                            continue
                        if endpoint['name'].replace(' [Loopback]', '') not in game_device:
                            raise RuntimeError(f'Capture endpoint differs from game output: {game_device}')
                        manifest['gameDevice'] = game_device
                        capture_stack.enter_context(audio.open(format=pa.paFloat32, channels=channels, rate=rate,
                            frames_per_buffer=480, input=True, input_device_index=endpoint['index'], stream_callback=callback))
                        manifest['captureOpenedAfterGameReady'] = True
                    if active is None:
                        for request in sorted(exchange.glob('*.start')):
                            if request.stem in seen:
                                continue
                            with lock:
                                active = request.stem
                                chunks = []
                                errors = []
                            seen.add(active)
                            (exchange / f'{active}.ready').write_text('ready\n')
                            print(f'Recording {active}', flush=True)
                            break
                    elif (exchange / f'{active}.stop').exists():
                        with lock:
                            name = active
                            active = None
                            pcm = np.frombuffer(b''.join(chunks), dtype='<f4').reshape(-1, channels).copy()
                            statuses = list(errors)
                        if len(pcm) < rate * args.seconds:
                            raise RuntimeError(f'Truncated recording: {name}, {len(pcm) / rate:.3f}s')
                        wavfile.write(destination / f'{name}.wav', rate, pcm)
                        result = {'id': name, 'frames': len(pcm), 'sampleRate': rate,
                                  'peak': float(np.max(np.abs(pcm))), 'callbackStatuses': statuses}
                        manifest['captures'].append(result)
                        (destination / 'capture.json').write_text(json.dumps(manifest, indent=2))
                        if statuses:
                            raise RuntimeError(f'Audio capture overflow/status flags: {statuses}')
                        (exchange / f'{name}.done').write_text('saved\n')
                        print(f'Saved {name}: {len(pcm) / rate:.2f}s, peak {result["peak"]:.4f}', flush=True)
                    time.sleep(.02)
                if process.returncode:
                    raise RuntimeError(f'Minecraft exited with {process.returncode}; see {destination / "client.log"}')
                timing = json.loads((destination / 'source-timing.json').read_text())
                if timing.get('status') != 'complete' or len(manifest['captures']) != timing.get('expectedCaptures', args.rounds + 4):
                    raise RuntimeError('Incomplete capture suite')
                manifest['status'] = 'complete'
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)
                (destination / 'capture.json').write_text(json.dumps(manifest, indent=2))
    print(f'COMPLETE: {destination}', flush=True)


if __name__ == '__main__':
    main()

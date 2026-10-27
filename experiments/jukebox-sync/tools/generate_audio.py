"""Generate an original deterministic 12-second probe; no copyrighted audio."""
import array
import json
import math
from pathlib import Path
import subprocess
import wave

root = Path(__file__).resolve().parents[1]
audio = root / 'src/main/resources/assets/synclab/sounds'
audio.mkdir(parents=True, exist_ok=True)
temporary = root / 'build/probe.wav'
temporary.parent.mkdir(parents=True, exist_ok=True)
rate = 44100
one_second = array.array('h', (int(1800 * math.sin(2 * math.pi * 440 * i / rate)
    + (4500 * math.sin(2 * math.pi * 1760 * i / rate) if i < 2205 else 0)) for i in range(rate)))
definitions = {}
for seconds in (12, 180):
    name = 'probe' if seconds == 12 else 'long_probe'
    with wave.open(str(temporary), 'wb') as output:
        output.setparams((1, 2, rate, rate * seconds, 'NONE', 'not compressed'))
        for _ in range(seconds):
            output.writeframes(one_second.tobytes())
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(temporary),
        '-c:a', 'libvorbis', '-q:a', '4', str(audio / (name + '.ogg'))], check=True)
    for mode in ('streamed', 'buffered', 'preloaded'):
        event = mode + ('_long' if seconds == 180 else '')
        definitions[event] = {'sounds': [{'name': 'synclab:' + name, 'stream': mode == 'streamed',
            'preload': mode == 'preloaded' and seconds == 12}]}
        song_path = root / 'src/main/resources/data/synclab/jukebox_song' / (event + '.json')
        song_path.parent.mkdir(parents=True, exist_ok=True)
        song_path.write_text(json.dumps({'sound_event': {'sound_id': 'synclab:' + event},
            'description': {'text': 'Sync Lab ' + event}, 'length_in_seconds': seconds, 'comparator_output': 1}) + '\n')
(audio.parent / 'sounds.json').write_text(json.dumps(definitions, indent=2) + '\n')
print('Generated 12-second and 180-second probes, six sound definitions and six jukebox songs.')

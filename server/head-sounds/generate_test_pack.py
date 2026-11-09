"""Exercise the production generator in Minecraft's native GameTest parser."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('music', Path(__file__).resolve().parents[2] / 'scripts/music-server.py')
music = importlib.util.module_from_spec(spec)
spec.loader.exec_module(music)
output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
source = output / 'fixture.ogg'
source.write_bytes(b'fixture; no audio client runs in this test')
tracks = []
for association, target, owned, name in [
    ('11111111-1111-4111-8111-111111111111', '069a79f4-44e9-4726-a5be-fca90e38aaf5', False, 'Notch'),
    ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', True, 'HeadTester'),
]:
    tracks.append({'id': association, 'kind': 'head', 'title': 'Test effect', 'artist': '',
                   'head': {'id': association, 'uuid': target, 'owned': owned, 'profile': {'id': target}}})
music.build_packs({'releaseId': 'a' * 64, 'tracks': tracks}, {t['id']: (source, 1) for t in tracks}, output,
                  {'data_format': [121, 0], 'resource_format': [97, 1]})

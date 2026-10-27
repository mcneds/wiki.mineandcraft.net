"""Compile a bounded packet-test controller against the installed server classpath."""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--classpath', type=Path, required=True, help='classpath.txt produced by build.py')
    parser.add_argument('--javac', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--controller', default='AudioBench', help='Use a new suffix when replacing an already-loaded helper')
    args = parser.parse_args()
    if not re.fullmatch(r'AudioBench(?:[1-9][0-9]?)?', args.controller): parser.error('Invalid controller name')
    suffix = args.controller.removeprefix('AudioBench')
    args.output.mkdir(parents=True, exist_ok=True)
    target = args.output / ('audio-bench' + ('-v' + suffix if suffix else '') + '.jar')
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary); source = stage / (args.controller + '.java'); classes = stage / 'classes'; classes.mkdir()
        source.write_text(Path(__file__).with_name('AudioBench.java').read_text().replace('AudioBench', args.controller))
        subprocess.run([str(args.javac), '--release', '21', '-cp', args.classpath.read_text().strip(),
                        '-d', str(classes), str(source)], check=True)
        subprocess.run([str(args.javac.with_name('jar')), 'cf', str(target), '-C', str(classes), '.'], check=True)
    print(target)

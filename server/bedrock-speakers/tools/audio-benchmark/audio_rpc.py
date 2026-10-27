"""Bounded stdio RPC for the diagnostic host; never accepts shell or world commands."""
import json
from pathlib import Path
import subprocess
import sys
import time
import re

ROOT = Path('/var/lib/pufferpanel/servers/1fc61e68/.copper-diagnostics')
JDK = '/usr/lib/jvm/temurin-24-jdk-arm64/bin/'
METHODS = {'single', 'raw', 'delayed', 'seek', 'pause', 'settle', 'pause5', 'production', 'late', 'jukebox', 'control', 'continuous', 'snapshot', 'cleanup'}


def invoke(request):
    if request['method'] == 'clock':
        return {'utc': time.time_ns() / 1e9}
    method = request['method']; controller = request.get('controller', 'AudioBench4')
    if method == 'remove':
        controller, helper = 'AudioWarmupProbe', 'audio-warmup-probe.jar'
        if not (ROOT / helper).exists(): return 'No temporary warm-up helper installed.'
    else:
        if method not in METHODS or not re.fullmatch(r'AudioBench(?:[1-9][0-9]?)?', controller):
            raise ValueError('Unsupported operation')
        suffix = controller.removeprefix('AudioBench')
        helper = 'audio-bench' + ('-v' + suffix if suffix else '') + '.jar'
    pid = next(line.split()[0] for line in subprocess.check_output(['ps', '-eo', 'pid,args'], text=True).splitlines()
               if 'java' in line and 'fabric-server' in line)
    output = ROOT / 'benchmark-control.txt'
    argument = f'{ROOT / helper}|net.mineandcraft.bedrockspeakers.debug.{controller}|{method}|{output}'
    run = subprocess.run(['sudo', '-u', 'pufferpanel', JDK + 'java', '--add-modules', 'jdk.attach',
                          '-cp', str(ROOT / 'debug-attach.jar'), 'DebugAttach', pid,
                          str(ROOT / 'debug-attach.jar'), argument], capture_output=True, text=True, timeout=10)
    if run.returncode: raise RuntimeError(run.stderr[-2000:])
    value = output.read_text()
    return value if method in {'cleanup', 'remove'} else json.loads(value)


print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    try: response = {'value': invoke(json.loads(line))}
    except Exception as error: response = {'error': str(error)}
    print(json.dumps(response), flush=True)

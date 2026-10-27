"""Record one controlled Minecraft-only audio trial and its server event timestamps."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import ctypes
import threading
import msvcrt

CONTROLLER = 'AudioBench'
RPC = None


def precise_time():
    value = ctypes.c_ulonglong()
    ctypes.windll.kernel32.GetSystemTimePreciseAsFileTime(ctypes.byref(value))
    return (value.value - 116444736000000000) / 1e7


class Connection:
    def __init__(self):
        self.process = subprocess.Popen([r'C:\Program Files\PuTTY\plink.exe', '-batch', '-load', 'minecraft',
                                        '-l', 'ubuntu', 'sudo -n python3 -u /home/ubuntu/copper-bedrock/audio_rpc.py'],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if not json.loads(self.process.stdout.readline()).get('ready'): raise RuntimeError('RPC unavailable')
    def request(self, method):
        self.process.stdin.write(json.dumps({'method': method, 'controller': CONTROLLER}) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line: raise RuntimeError('RPC closed: ' + self.process.stderr.read())
        reply = json.loads(line)
        if 'error' in reply: raise RuntimeError(reply['error'])
        return reply['value']
    def close(self):
        self.process.stdin.close(); self.process.wait(timeout=5)


def remote(method, probe=False):
    if RPC is None: raise RuntimeError('Diagnostic connection is not open')
    return RPC.request(method)


def run(args):
    global RPC
    args.output.mkdir(parents=True, exist_ok=True)
    wav = args.output / (args.label + '.wav')
    metadata = args.output / (args.label + '.json')
    if wav.exists() or metadata.exists(): raise RuntimeError('Trial labels must be new')
    RPC = Connection()
    calibration = []
    if RPC:
        for _ in range(7):
            before = precise_time(); server = remote('clock')['utc']; after = precise_time()
            calibration.append({'roundTripSeconds': after - before, 'serverMinusPcSeconds': server - (before + after) / 2})
    clock = min(calibration, key=lambda row: row['roundTripSeconds']) if calibration else None
    print(remote('remove', probe=True), flush=True)
    user32 = ctypes.windll.user32
    user32.GetForegroundWindow.restype = ctypes.c_void_p
    user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
    user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    old_foreground = user32.GetForegroundWindow()
    focus_requested = False
    if args.focus_minecraft:
        windows = []
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
        def visit(window, _):
            owner = ctypes.c_ulong(); user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
            if owner.value == args.pid and user32.IsWindowVisible(ctypes.c_void_p(window)): windows.append(window)
            return True
        callback = callback_type(visit); user32.EnumWindows(callback, 0)
        if windows: focus_requested = bool(user32.SetForegroundWindow(windows[0]))
    process = subprocess.Popen([str(args.capture), str(args.pid), str(args.seconds), str(wav)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    observations = []; finished = threading.Event()
    def observe_focus():
        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        while not finished.is_set():
            owner = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), ctypes.byref(owner))
            observations.append({'at': time.time(), 'minecraftForeground': owner.value == args.pid,
                                 'wallMinusMonotonic': time.time() - time.monotonic()})
            finished.wait(.2)
    observer = threading.Thread(target=observe_focus, daemon=True); observer.start()
    try:
        ready = process.stdout.readline()
        if not ready: raise RuntimeError(process.stderr.read())
        capture_ready = time.time(); status = json.loads(ready)
        if status.get('event') != 'ready': raise RuntimeError('Capture did not become ready')
        time.sleep(1)
        sent = time.time(); initial = remote(args.mode); replied = time.time()
        print('Recording', args.label, 'mode', args.mode, flush=True)
        output, error = process.communicate(timeout=args.seconds + 15)
        finished.set(); observer.join(timeout=1)
        if process.returncode: raise RuntimeError(error)
        capture = [status, *[json.loads(line) for line in output.splitlines() if line.strip()]]
        value = {'label': args.label, 'mode': args.mode, 'captureReadyAt': capture_ready,
                 'controlSentAt': sent, 'controlRepliedAt': replied, 'initial': initial,
                 'result': remote('snapshot'), 'capture': capture, 'stderr': error,
                 'captureProcess': 'Minecraft.Windows only', 'gatingDoesNotRestartVoices': True,
                 'focus': observations, 'controller': CONTROLLER, 'focusRequested': focus_requested,
                 'clockCalibration': clock, 'clockCalibrationPings': calibration}
        temporary = metadata.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(value, indent=2) + '\n'); temporary.replace(metadata)
        print('Saved', wav.name, 'and', metadata.name, flush=True)
    finally:
        finished.set(); observer.join(timeout=1)
        if process.poll() is None: process.terminate(); process.wait(timeout=5)
        print(remote('cleanup'), flush=True)
        if RPC: RPC.close(); RPC = None
        if args.focus_minecraft and old_foreground: user32.SetForegroundWindow(old_foreground)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', type=Path, required=True)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--mode', choices=['single', 'raw', 'delayed', 'seek', 'pause', 'settle', 'pause5', 'production', 'late', 'jukebox', 'control', 'continuous'], required=True)
    parser.add_argument('--controller', choices=['AudioBench', 'AudioBench2', 'AudioBench3', 'AudioBench4', 'AudioBench5', 'AudioBench6', 'AudioBench7'], default='AudioBench')
    parser.add_argument('--seconds', type=int, default=36)
    parser.add_argument('--focus-minecraft', action='store_true')
    args = parser.parse_args(); CONTROLLER = args.controller
    # Never overlap controllers: each changes volumes on the same three handles.
    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / '.trial.lock').open('a+b') as lock:
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        try: msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError: raise SystemExit('Another audio trial is still running')
        try: run(args)
        finally:
            lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)

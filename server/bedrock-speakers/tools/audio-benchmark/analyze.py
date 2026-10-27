"""Historical sequential-solo analysis; use analyze_pairs.py for timing claims.

This method cannot separate a shared mixer pause between windows from an
individual voice offset. Its historical results are not accepted measurements.
"""
import argparse
import json
from pathlib import Path
import subprocess
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, correlate, resample_poly, sosfiltfilt

RATE = 4000
FILTER = butter(4, [80, 1700], fs=RATE, btype='bandpass', output='sos')


class Timeline:
    def __init__(self, path=None):
        self.pcm = self.qpc = None
        if path is not None and path.exists():
            packets = json.loads(path.read_text())['packets']
            if any(p['flags'] & 4 for p in packets): raise ValueError('Invalid capture QPC timestamps')
            self.pcm = np.array([p['frame'] / 44100 for p in packets])
            first = packets[0]['qpc']
            self.qpc = np.array([(p['qpc'] - first) / 1e7 for p in packets])
            if np.any(np.diff(self.pcm) <= 0) or np.any(np.diff(self.qpc) <= 0):
                raise ValueError('Non-monotonic capture timeline')
    def actual(self, seconds):
        return float(np.interp(seconds, self.pcm, self.qpc)) if self.pcm is not None else seconds
    def samples(self, seconds):
        return float(np.interp(seconds, self.qpc, self.pcm)) if self.pcm is not None else seconds


def reference_audio(path):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le',
                                   '-ar', str(RATE), '-ac', '1', '-'])
    return np.frombuffer(raw, dtype='<f4').astype(np.float64)


def locate(reference, window):
    energy = float(window @ window)
    if energy < 1e-10: raise ValueError('Solo window is silent')
    dot = correlate(reference, window, mode='valid', method='fft')
    sums = np.r_[0., np.cumsum(reference * reference)]
    powers = sums[len(window):] - sums[:-len(window)]
    scores = dot / np.sqrt(np.maximum(powers * energy, 1e-20))
    best = int(np.argmax(scores))
    distinct = scores.copy(); distinct[max(0, best - 600):best + 601] = -np.inf
    runner_up = float(np.max(distinct))
    return best / RATE, float(scores[best]), runner_up


def measure(reference, audio, metadata, timeline=None):
    timeline = timeline or Timeline()
    events = metadata['result']['events']
    anchor = next(e for e in events if e['event'] == 'began')
    origin = anchor['utcMillis'] / 1000 - anchor['elapsed'] - metadata['captureReadyAt']
    rows = []; visits = {}
    for event in events:
        if event['event'] != 'gate' or event['voice'] < 0: continue
        begin = round((origin + event['elapsed'] + .6) * RATE)
        end = begin + round(1.8 * RATE)
        if begin < 0 or end > len(audio): raise ValueError('Missing solo window in capture')
        position, score, alternate = locate(reference, audio[begin:end])
        phase = 'early' if visits.get(event['voice'], 0) == 0 else 'late'
        visits[event['voice']] = visits.get(event['voice'], 0) + 1
        rows.append({'voice': event['voice'], 'pass': phase,
                     'captureTimeSeconds': begin / RATE, 'referenceTimeSeconds': position,
                     'clockEpochSeconds': timeline.actual(begin / RATE) - position,
                     'correlation': score, 'alternateCorrelation': alternate,
                     'confident': score >= .70 and score - alternate >= .08})
    result = {'windows': rows, 'analysisSampleRate': RATE, 'resolutionMs': 1000 / RATE,
              'confidencePassed': bool(rows) and all(r['confident'] for r in rows),
              'windowSeconds': 1.8, 'gateGuardSeconds': .6}
    for name in ['early', 'late']:
        selected = [r for r in rows if r['pass'] == name]
        values = [r['clockEpochSeconds'] for r in selected]
        result[name + 'Valid'] = bool(selected) and all(r['confident'] for r in selected)
        result[name + 'SpreadMs'] = (max(values) - min(values)) * 1000 if result[name + 'Valid'] else None
    result['driftMs'] = {}
    for voice in sorted({r['voice'] for r in rows}):
        values = {r['pass']: r['clockEpochSeconds'] for r in rows if r['voice'] == voice and r['confident']}
        if len(values) == 2: result['driftMs'][str(voice)] = (values['late'] - values['early']) * 1000
    baseline = result['driftMs'].get('0')
    result['relativeDriftMs'] = {key: value - baseline for key, value in result['driftMs'].items()} if baseline is not None else {}
    return result


def synthetic_control(raw_reference):
    checks = []
    for label, delays, rates in [('known-delays', [0, .15, .30], [1, 1, 1]),
                                  ('known-drift', [0, 0, 0], [1, 1.0002, .9998])]:
        t = np.arange(36 * RATE) / RATE
        audio = np.zeros(len(t))
        events = [{'event': 'began', 'elapsed': 0., 'utcMillis': 1000000, 'voice': -1}]
        for base in [3, 20]:
            for voice in range(3): events.append({'event': 'gate', 'elapsed': base + 3 * voice, 'voice': voice})
        for voice in range(3):
            source_t = (t - 2 - delays[voice]) * rates[voice]
            signal = np.interp(source_t * RATE, np.arange(len(raw_reference)), raw_reference, left=0, right=0)
            audible = (t >= 2) & (t < 31)
            for base in [3, 20]:
                inside = (t >= 2 + base) & (t < 2 + base + 9)
                audible &= ~inside | ((t >= 2 + base + 3 * voice) & (t < 2 + base + 3 * voice + 3))
            audio += signal * audible * .2
        audio += np.random.default_rng(1).normal(0, 1e-6, len(audio))
        result = measure(sosfiltfilt(FILTER, raw_reference), sosfiltfilt(FILTER, audio),
                         {'captureReadyAt': 998., 'result': {'events': events}})
        expected = 300 if label == 'known-delays' else 0
        if label == 'known-delays':
            assert abs(result['earlySpreadMs'] - expected) <= .5, result
            assert abs(result['lateSpreadMs'] - expected) <= .5, result
        else:
            assert abs(result['driftMs']['1'] + 3.4) <= .5, result
            assert abs(result['driftMs']['2'] - 3.4) <= .5, result
        checks.append({'label': label, 'result': result, 'kind': 'synthetic analysis validation, not a client measurement'})
    return checks


def analyze(root):
    raw_reference = reference_audio(root / 'reference.ogg')
    reference = sosfiltfilt(FILTER, raw_reference)
    checks = synthetic_control(raw_reference)
    report = {'status': 'historical-unreliable',
              'limitation': 'Sequential windows confound shared mixer pauses with individual offsets; use analyze_pairs.py',
              'method': 'PCM correlation in solo windows; existing voices continue between gates',
              'syntheticValidation': checks, 'trials': []}
    for path in sorted(root.glob('*.json')):
        metadata = json.loads(path.read_text())
        if 'result' not in metadata or 'captureReadyAt' not in metadata: continue
        rate, samples = wavfile.read(path.with_suffix('.wav'))
        raw = samples.astype(np.float64) / 32768
        mono = raw.mean(axis=1) if raw.ndim == 2 else raw
        if rate != 44100: raise ValueError('Unexpected capture sample rate')
        audio = sosfiltfilt(FILTER, resample_poly(mono, 40, 441))
        timeline = Timeline(Path(str(path.with_suffix('.wav')) + '.timing.json'))
        try: result = measure(reference, audio, metadata, timeline)
        except ValueError as error: result = {'confidencePassed': False, 'error': str(error)}
        completed = next((v for v in metadata['capture'] if v['event'] == 'complete'), {})
        result.update({'label': metadata['label'], 'mode': metadata['mode'], 'wav': str(path.with_suffix('.wav')),
                       'peak': float(np.max(abs(raw))), 'rms': float(np.sqrt(np.mean(raw * raw))),
                       'clippedFraction': float(np.mean(abs(raw) >= .999)), 'capture': completed,
                       'clockBasis': 'capture-QPC' if timeline.pcm is not None else 'legacy sample-count'})
        if timeline.pcm is not None:
            deviations = (timeline.qpc - timeline.pcm) * 1000
            result['captureTimelineDeviationMs'] = [float(min(deviations)), float(max(deviations))]
        late = [w['clockEpochSeconds'] for w in result.get('windows', []) if w['pass'] == 'late' and w['confident']]
        anchor = next((e for e in metadata['result']['events'] if e['event'] == 'began'), None)
        gates = [e for e in metadata['result']['events'] if e['event'] == 'gate' and e['voice'] >= 0]
        if late and anchor and gates:
            epoch = timeline.samples(float(np.median(late))); length = round(.8 * RATE)
            energy = np.convolve(reference[:RATE * 6] ** 2, np.ones(200) / 200, mode='valid')
            attack = int(np.flatnonzero(energy > max(energy) * .0225)[0])
            opening = epoch + attack / RATE
            first_gate = anchor['utcMillis'] / 1000 - anchor['elapsed'] - metadata['captureReadyAt'] + gates[0]['elapsed']
            if epoch >= 0 and opening + .8 < first_gate:
                template = reference[attack:attack + length]; powers = float(template @ template)
                choices = []
                for delta in range(-2, 3):
                    begin = round(opening * RATE) + delta; window = audio[begin:begin + length]
                    if len(window) != length: continue
                    dot = float(window @ template); energy = float(window @ window)
                    choices.append((dot / np.sqrt(max(powers * energy, 1e-20)), dot / max(powers, 1e-20)))
                result['openingCorrelation'], result['openingGain'] = max(choices)
                result['openingSecondsCompared'] = .8
                result['openingReferenceStartSeconds'] = attack / RATE
            else: result['openingRejected'] = 'Estimated beginning extends into solo gating; not a valid opening-quality comparison'
        focus = metadata.get('focus', [])
        if focus:
            result['foregroundFraction'] = sum(v['minecraftForeground'] for v in focus) / len(focus)
            clocks = [v['wallMinusMonotonic'] for v in focus]
            result['wallClockVariationMs'] = (max(clocks) - min(clocks)) * 1000
        positions = [e['listenerPosition'] for e in metadata['result']['events'] if 'listenerPosition' in e]
        if positions: result['listenerDisplacementBlocks'] = float(np.max(np.linalg.norm(np.array(positions) - positions[0], axis=1)))
        if completed.get('gapFrames') or completed.get('discontinuities'): result['confidencePassed'] = False
        report['trials'].append(result)
        print(result['label'], 'early spread ms=', result.get('earlySpreadMs'), 'late=', result.get('lateSpreadMs'),
              'drift=', result.get('driftMs'), 'valid=', result['confidencePassed'], flush=True)
    (root / 'analysis.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    analyze(parser.parse_args().root)

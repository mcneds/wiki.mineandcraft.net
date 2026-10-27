"""Measure simultaneous speaker pairs against an exact recording, retaining failed trials.

Voice 0 remains audible at twice the amplitude of the comparison voice. A common
time shift and gain are nuisance parameters; the fitted relative delay is the
measurement. Absolute packet arrival times never determine the speaker offset.
Continuous trials keep the original two aligned voices playing without volume
gating, then fit their combined 3:1 mixture with a newly attached speaker.
"""
import argparse
import json
from pathlib import Path
import subprocess
import numpy as np
from scipy.io import wavfile
from scipy.optimize import least_squares
from scipy.signal import resample_poly, sosfiltfilt
from analyze import RATE, FILTER, Timeline, locate, reference_audio

_oversampled = {}


def contiguous_window(timeline, start, finish):
    """Choose by timestamps only, never by the fit score or the measured delay."""
    spans = []; cursor = start
    if timeline.pcm is not None:
        for index in np.flatnonzero(np.diff(timeline.qpc) - np.diff(timeline.pcm) > .002) + 1:
            before = timeline.qpc[index - 1] + timeline.pcm[index] - timeline.pcm[index - 1]
            after = timeline.qpc[index]
            if after <= cursor or before >= finish: continue
            if before > cursor: spans.append((cursor, min(before, finish)))
            cursor = max(cursor, after)
    if cursor < finish: spans.append((cursor, finish))
    if not spans: raise ValueError('No contiguous audio in gate')
    left, right = max(spans, key=lambda span: span[1] - span[0])
    left += .04; right -= .04
    length = min(1.4, right - left)
    if length < .9: raise ValueError('No contiguous comparison window of at least 0.9 seconds')
    center = (left + right) / 2
    return center - length / 2, center + length / 2


def interpolator(reference, length):
    # Linear interpolation at 4 kHz alters near-Nyquist harmonics and can imitate
    # a tiny second-source delay. Interpolate a band-limited 8x reconstruction.
    if id(reference) not in _oversampled:
        _oversampled[id(reference)] = resample_poly(reference, 8, 1)
    high = _oversampled[id(reference)]; grid = np.arange(length) * 8
    def sample(position):
        start = position * 8; integer = int(np.floor(start)); fraction = start - integer
        indices = grid + integer
        if indices[0] < 0 or indices[-1] + 1 >= len(high): raise ValueError('Reference boundary')
        return high[indices] * (1 - fraction) + high[indices + 1] * fraction
    return sample


def fit_single(reference, audio):
    anchor, score, alternate = locate(reference, audio)
    sample = interpolator(reference, len(audio)); power = max(float(audio @ audio), 1e-20)
    def difference(phase):
        template = sample(anchor * RATE + phase[0])
        gain = float(template @ audio / max(template @ template, 1e-20))
        return (template * gain - audio) / np.sqrt(power)
    fit = least_squares(difference, [0.], bounds=([-2], [2]), diff_step=1e-3)
    correlation = float(np.sqrt(max(0, 1 - fit.fun @ fit.fun)))
    return {'anchorReferenceSeconds': anchor + float(fit.x[0]) / RATE,
            'fitCorrelation': correlation, 'valid': correlation > .98 and score - alternate > .05,
            'delayMs': 0}


def fit_pair(reference, audio, anchor_weight=2):
    anchor, score, alternate = locate(reference, audio)
    center = anchor * RATE
    sample = interpolator(reference, len(audio))
    primary = sample(center)
    gain = float(primary @ audio / max(primary @ primary, 1e-20))
    residual = audio - primary * gain
    lo = max(0, int(center - RATE * 2)); hi = min(len(reference), int(center + RATE * 2 + len(audio)))
    secondary, _, _ = locate(reference[lo:hi], residual)
    second = lo + secondary * RATE
    power = max(float(audio @ audio), 1e-20)
    def difference(parameters):
        template = anchor_weight * sample(center + parameters[0]) + sample(center + parameters[0] + parameters[1])
        amplitude = float(template @ audio / max(template @ template, 1e-20))
        return (template * amplitude - audio) / np.sqrt(power)
    seeds = [second - center, 0, *[sign * delay * RATE for sign in [-1, 1]
             for delay in [.001, .003, .01, .025, .05, .1, .15, .3, .6, 1.0]]]
    results = []
    for seed in seeds:
        fit = least_squares(difference, [0, np.clip(seed, -2 * RATE + 1, 2 * RATE - 1)],
                            bounds=([-RATE * .08, -2 * RATE], [RATE * .08, 2 * RATE]),
                            diff_step=1e-3, max_nfev=70, ftol=1e-7, xtol=1e-6, gtol=1e-7)
        results.append((float(fit.fun @ fit.fun), fit.x))
    error, parameters = min(results, key=lambda result: result[0])
    return {'delayMs': -float(parameters[1]) / RATE * 1000,
            'fitCorrelation': float(np.sqrt(max(0, 1 - error))),
            'relativeResidualRms': float(np.sqrt(error)),
            'anchorReferenceSeconds': float((center + parameters[0]) / RATE),
            'anchorCorrelation': score, 'alternateAnchorCorrelation': alternate,
            'valid': error < .04 and score - alternate > .05}


def validate(reference):
    rng = np.random.default_rng(7); grid = np.arange(RATE * 1.8) + RATE * 8.3172173
    sample = interpolator(reference, len(grid))
    rows = []
    for weight, delay in [(2, value) for value in [0, .001, -.003, .15, .30, -.53325]] + [(3, .12835)]:
        audio = .13 * (weight * sample(grid[0]) + sample(grid[0] - delay * RATE))
        audio += rng.normal(0, 1e-6, len(audio))
        result = fit_pair(reference, audio, weight)
        if abs(result['delayMs'] - delay * 1000) > .6 or not result['valid']:
            raise AssertionError((delay, result))
        rows.append({'expectedMs': delay * 1000, 'anchorWeight': weight, **result})
    return rows


def analyze(root, label=None):
    reference = sosfiltfilt(FILTER, reference_audio(root / 'reference.ogg'))
    report = {'method': __doc__, 'syntheticValidation': validate(reference),
              'reportingResolutionMs': 1, 'trials': []}
    if label and (root / 'paired-analysis.json').exists():
        report['trials'] = [trial for trial in json.loads((root / 'paired-analysis.json').read_text())['trials'] if trial['label'] != label]
    for path in sorted(root.glob((label or '*') + '.json')):
        metadata = json.loads(path.read_text())
        layout = metadata.get('result', {}).get('gating')
        if layout not in {'anchor-pairs-2-to-1', 'continuous-3-to-1'}: continue
        continuous = layout == 'continuous-3-to-1'
        initial = next(e['utcMillis'] for e in metadata['initial']['events'] if e['event'] == 'began')
        final = next(e['utcMillis'] for e in metadata['result']['events'] if e['event'] == 'began')
        if initial != final or metadata['mode'] != metadata['result']['mode']:
            report['trials'].append({'label': metadata['label'], 'valid': False,
                                     'reason': 'Controller replaced by an overlapping trial'})
            continue
        rate, samples = wavfile.read(path.with_suffix('.wav'))
        audio = sosfiltfilt(FILTER, resample_poly(samples.mean(axis=1) / 32768, 40, 441))
        stamp = json.loads(Path(str(path.with_suffix('.wav')) + '.timing.json').read_text())
        try: timeline = Timeline(Path(str(path.with_suffix('.wav')) + '.timing.json'))
        except ValueError as error:
            report['trials'].append({'label': metadata['label'], 'valid': False, 'reason': str(error)})
            continue
        ready = metadata['capture'][0]
        first_utc = ready['readyUtcSeconds'] + (stamp['packets'][0]['qpc'] - ready['readyQpc100ns']) / 1e7
        offset = metadata['clockCalibration']['serverMinusPcSeconds']
        rows = []; visits = {}; continuous_quality = None
        for event in metadata['result']['events']:
            if event['event'] != ('observe' if continuous else 'pair') or event['voice'] < 0: continue
            voice = event['voice']; phase = 'early' if not visits.get(voice) else 'late'; visits[voice] = 1
            if continuous and voice == 0: phase = 'baseline'
            gate = event['utcMillis'] / 1000 - offset - first_utc
            try: start, finish = contiguous_window(timeline, gate + .65, gate + 2.8)
            except ValueError as error:
                rows.append({'voice': voice, 'pass': phase, 'valid': False, 'reason': str(error)})
                continue
            begin, end = timeline.samples(start), timeline.samples(finish)
            row = {'voice': voice, 'pass': phase, 'windowStartSeconds': start,
                   'windowSeconds': finish - start,
                   'captureGapMs': (finish - start - (end - begin)) * 1000}
            if abs(row['captureGapMs']) > 2:
                row.update(valid=False, reason='Capture timeline gap intersects comparison window')
            elif voice == 0:
                row.update(fit_single(reference, audio[round(begin * RATE):round(end * RATE)]))
            else:
                row.update(fit_pair(reference, audio[round(begin * RATE):round(end * RATE)], 3 if continuous else 2))
                if continuous and phase == 'early':
                    continuous_quality = fit_single(reference, audio[round(begin * RATE):round(end * RATE)])
            rows.append(row)
        result = {'label': metadata['label'], 'mode': metadata['mode'], 'windows': rows,
                  'valid': len(rows) == (3 if continuous else 6) and all(row['valid'] for row in rows),
                  'continuousPlayback': continuous,
                  'clockCalibrationUncertaintyMs': metadata['clockCalibration']['roundTripSeconds'] * 500,
                  'foregroundFraction': sum(row['minecraftForeground'] for row in metadata['focus']) / len(metadata['focus'])}
        result['peak'] = float(np.max(np.abs(samples.astype(float))) / 32768)
        result['clippedFraction'] = float(np.mean(np.abs(samples.astype(float)) >= 32760))
        positions = [event['listenerPosition'] for event in metadata['result']['events'] if 'listenerPosition' in event]
        displacement = float(np.max(np.linalg.norm(np.array(positions) - positions[0], axis=1))) if positions else 0
        result['listenerDisplacementBlocks'] = displacement
        if displacement > .05:
            result.update(valid=False, reason='Listener moved; co-located comparison gain is no longer controlled')
            for row in rows: row.update(valid=False, reason=result['reason'])
        completed = next((event for event in metadata['capture'] if event['event'] == 'complete'), {})
        result['capture'] = completed
        if any(completed.get(key, 0) for key in ['gapFrames', 'discontinuities', 'timestampErrors']):
            result.update(valid=False, reason='Capture reports dropped frames or invalid timestamps')
            for row in rows: row.update(valid=False, reason=result['reason'])
        mixed = next((event for event in metadata['result']['events'] if event['event'] == 'pair' and event['voice'] == -1), None)
        if mixed:
            start = mixed['utcMillis'] / 1000 - offset - first_utc + 1.25
            begin, end = timeline.samples(start), timeline.samples(start + 1.4)
            if abs((end - begin) - 1.4) < .002:
                result['mixedVoicesQuality'] = fit_single(reference, audio[round(begin * RATE):round(end * RATE)])
            else: result['mixedVoicesQuality'] = {'valid': False, 'reason': 'Capture timeline gap'}
        elif continuous_quality:
            result['mixedVoicesQuality'] = continuous_quality
        if continuous:
            baseline = next((row for row in rows if row['pass'] == 'baseline' and row['valid']), None)
            if baseline:
                epoch = baseline['windowStartSeconds'] - baseline['anchorReferenceSeconds']
                result['existingTimelineShiftMs'] = {row['pass']: (row['windowStartSeconds']
                        - row['anchorReferenceSeconds'] - epoch) * 1000
                        for row in rows if row['pass'] != 'baseline' and row['valid']}
        for phase in ['early', 'late']:
            selected = [row for row in rows if row['pass'] == phase]
            values = [row['delayMs'] for row in selected if row['valid']]
            baseline = not continuous or any(row['pass'] == 'baseline' and row['valid'] for row in rows)
            result[phase + 'SpreadMs'] = (max([0, *values]) - min([0, *values])) if len(values) == (1 if continuous else 3) and baseline else None
        report['trials'].append(result)
        print(result['label'], result['valid'], result['earlySpreadMs'], result['lateSpreadMs'], flush=True)
    (root / 'paired-analysis.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('root', type=Path)
    parser.add_argument('--label', help='Analyze one new trial, retaining previous results')
    args = parser.parse_args(); analyze(args.root, args.label)

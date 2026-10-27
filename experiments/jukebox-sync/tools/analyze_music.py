"""Compare captured eight-source output against a captured synchronized reference.

Only one global integer-sample shift and one scalar gain are fitted per capture.
No time stretching, local realignment, equalization, or denoising is applied.
"""
import argparse
import html
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from scipy import signal
from scipy.io import wavfile


def rms(x):
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def db(x):
    return float(20 * np.log10(max(float(x), 1e-15)))


def load(path):
    rate, data = wavfile.read(path)
    if data.dtype.kind in 'iu':
        data = data.astype(np.float64) / np.iinfo(data.dtype).max
    return rate, np.asarray(data, dtype=np.float64)


def match(reference, recording):
    correlation = signal.correlate(recording.mean(axis=1), reference.mean(axis=1), mode='valid', method='fft')
    offset = int(np.argmax(correlation))
    return offset, recording[offset:offset + len(reference)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--exclude-from-selection', action='append', default=[], metavar='RECORDING')
    parser.add_argument('--exclusion-reason', default='')
    args = parser.parse_args()
    if args.exclude_from_selection and not args.exclusion_reason:
        raise ValueError('An explicit reason is required; excluded captures remain in every report')
    root = args.directory.resolve()
    capture = json.loads((root / 'capture.json').read_text())
    timing = json.loads((root / 'source-timing.json').read_text())
    if capture.get('status') != 'complete' or timing.get('status') != 'complete':
        raise ValueError('Only completed recordings can be analyzed')
    rate, raw_reference = load(root / 'reference-a.wav')
    # Locate music onset using 5 ms RMS blocks, then exclude the initial 500 ms.
    window = int(.005 * rate)
    energy = np.array([rms(raw_reference[i:i + window]) for i in range(0, len(raw_reference), window)])
    onset = int(np.flatnonzero(energy > energy.max() * .05)[0] * window)
    start = onset + int(.5 * rate)
    length = int((timing['secondsPerRecording'] - 1.5) * rate)
    reference = raw_reference[start:start + length]
    if len(reference) != length or length < rate:
        raise ValueError('Reference too short')
    rows = []
    aligned = {}
    source_results = {r['id']: r for r in timing['recordings']}
    for info in capture['captures']:
        name = info['id']
        if info['callbackStatuses']:
            raise ValueError(f'Capture overrun: {name}')
        fs, raw = load(root / f'{name}.wav')
        if fs != rate or raw.shape[1] != reference.shape[1]:
            raise ValueError('Inconsistent capture formats')
        offset, actual = match(reference, raw)
        gain = float(np.sum(actual * reference) / np.sum(reference * reference))
        residual = actual - gain * reference
        nrmse = rms(residual) / max(rms(actual), 1e-30)
        observations = source_results[name]['observations']
        local_lags = []
        # Independent diagnostic only: these local shifts are never applied to audio.
        for second in np.linspace(.2, len(reference) / rate - 1.2, 5):
            segment_start = int(second * rate)
            template = reference[segment_start:segment_start + rate]
            expected = offset + segment_start
            pad = int(.003 * rate)
            region = raw[expected - pad:expected + rate + pad]
            local_offset, _ = match(template, region)
            local_lags.append((local_offset - pad) / rate * 1000)
        flattened_ref = reference.ravel() - reference.mean()
        flattened_actual = actual.ravel() - actual.mean()
        correlation = float(np.dot(flattened_ref, flattened_actual) /
                            np.sqrt(np.dot(flattened_ref, flattened_ref) * np.dot(flattened_actual, flattened_actual)))
        row = {
            'id': name, 'globalAlignmentSamples': offset,
            'excludedFromListeningSelection': name in args.exclude_from_selection,
            'exclusionReason': args.exclusion_reason if name in args.exclude_from_selection else '',
            'gainRelativeToReference': gain, 'gainDifferenceDb': db(abs(gain)),
            'correlation': correlation, 'residualRmsPercent': 100 * nrmse,
            'residualDbRelativeToSignal': db(nrmse),
            'unscaledDifferencePercentOfReference': 100 * rms(actual - reference) / rms(reference),
            'maxSourceSpreadMs': max(o['spreadMs'] for o in observations),
            'sourceSpreadChangeMs': observations[-1]['spreadMs'] - observations[0]['spreadMs'],
            'localAlignmentDeviationMs': local_lags,
            'maxLocalAlignmentChangeMs': max(local_lags) - min(local_lags),
            'quietLeadInRmsDbfs': db(rms(raw[:int(.3 * rate)])),
            'peak': float(np.max(np.abs(raw))),
            'samplesAtOrAboveFullScale': int(np.count_nonzero(np.abs(raw) >= .9999))
        }
        rows.append(row)
        aligned[name] = actual
    candidates = [r for r in rows if r['id'].startswith('candidate-')]
    eligible = [r for r in candidates if not r['excludedFromListeningSelection']]
    worst = max(eligible, key=lambda r: r['residualRmsPercent'])
    floor = next(r for r in rows if r['id'] == 'reference-b')
    controls = [r for r in rows if r['id'].startswith('delay-')]
    if any(r['maxSourceSpreadMs'] < 5 or r['residualRmsPercent'] < max(floor['residualRmsPercent'] * 3, .1) for r in controls):
        raise ValueError('Delayed-source control did not exceed the reference repeatability floor')
    analysis = {
        'method': 'Captured atomic eight-source reference, same asset/positions/gains; one global sample alignment and scalar gain fit; no time warping',
        'referenceRepeat': floor,
        'selectedCandidate': worst['id'],
        'selection': 'Largest measured residual among vanilla packet-start trials without explicitly flagged recording contamination',
        'selectionExclusions': {r['id']: r['exclusionReason'] for r in candidates if r['excludedFromListeningSelection']},
        'sampleRate': rate, 'comparedSeconds': length / rate,
        'referenceMusicOnsetSample': onset,
        'caveats': ['Endpoint loopback, not analog/acoustic output',
                    'Mono downmix and Vorbis encoding are common to reference and candidate, so excluded from synchronization error',
                    'Reference requires client-only atomic start; candidate uses vanilla server packets',
                    'Scalar fitting removes overall level changes but does not fix spectral or timing differences',
                    'One device, fixed listener, eight sources, short excerpts; not a full-song drift study'],
        'recordings': rows
    }
    out = root / 'listening'
    out.mkdir(exist_ok=True)
    selected = aligned[worst['id']]
    # One common gain for every listening file preserves actual level differences.
    peak = max(np.max(np.abs(a)) for a in aligned.values())
    listen_gain = min(.85 / max(peak, 1e-20), 20)

    def write(name, pcm, multiplier=1):
        audio = np.clip(pcm * listen_gain * multiplier, -.999, .999)
        wavfile.write(out / name, rate, np.round(audio * 32767).astype(np.int16))

    write('reference.wav', reference)
    write('eight-speakers.wav', selected)
    write('delay-10ms.wav', aligned['delay-10ms'])
    write('delay-50ms.wav', aligned['delay-50ms'])
    write('reference-b.wav', aligned['reference-b'])
    for candidate in candidates:
        write(candidate['id'] + '.wav', aligned[candidate['id']])
    difference = selected - worst['gainRelativeToReference'] * reference
    difference_boost = min(100, .8 / max(np.max(np.abs(difference)) * listen_gain, 1e-20))
    write('difference-amplified.wav', difference, difference_boost)
    analysis['listeningCommonGain'] = listen_gain
    analysis['residualExtraGain'] = difference_boost
    (root / 'analysis.json').write_text(json.dumps(analysis, indent=2))
    fig, axes = plt.subplots(3, 1, figsize=(12, 10), constrained_layout=True)
    center = int(np.argmax(np.abs(np.diff(reference[:, 0]))))
    a = max(0, min(center - int(.025 * rate), length - int(.08 * rate)))
    b = a + int(.08 * rate)
    time_ms = np.arange(b - a) / rate * 1000
    axes[0].plot(time_ms, reference[a:b, 0], label='Aligned reference', linewidth=1.5)
    axes[0].plot(time_ms, selected[a:b, 0], label=f'Eight speakers ({worst["id"]})', linewidth=.8, alpha=.8)
    axes[0].set(xlabel='Time within excerpt (ms)', ylabel='Left-channel amplitude', title='Actual captured waveforms: 80 ms around a transient')
    axes[0].legend()
    for name, pcm in [('Aligned reference', reference), ('Eight speakers', selected), ('Deliberate 10 ms mismatch', aligned['delay-10ms'])]:
        frequency, power = signal.welch(pcm, fs=rate, nperseg=16384, axis=0)
        axes[1].semilogx(frequency, 10 * np.log10(np.maximum(power.mean(axis=1), 1e-20)), label=name, alpha=.8)
    axes[1].set(xlim=(50, 16000), xlabel='Frequency (Hz)', ylabel='Power spectral density (dB/Hz)', title='Same output path; a delayed half-group changes the spectrum')
    axes[1].legend()
    compared = [r for r in rows if r['id'] != 'reference-a']
    axes[2].bar([r['id'] + (' *' if r['excludedFromListeningSelection'] else '') for r in compared], [-r['residualDbRelativeToSignal'] for r in compared],
                color=['#40877a' if r['id'].startswith('candidate') else '#ad7342' for r in compared])
    axes[2].set(ylabel='Signal / residual (dB; higher = closer)', title='Residual after one global alignment and gain fit; reference-b measures repeatability')
    axes[2].tick_params(axis='x', rotation=25)
    if args.exclude_from_selection:
        axes[2].set_xlabel('* Additional sound in recording; retained in the results, excluded from main listening selection')
    for ax in axes:
        ax.grid(alpha=.2)
    fig.suptitle('Midnight In A Perfect World: eight-source buffered playback', fontsize=15)
    fig.savefig(out / 'waveform-comparison.png', dpi=160)
    fig.savefig(out / 'waveform-comparison.svg')
    table_rows = ''.join(f'<tr><td><a href="{"reference" if r["id"] == "reference-a" else html.escape(r["id"])}.wav">{html.escape(r["id"])}</a>{" *" if r["excludedFromListeningSelection"] else ""}</td><td>{r["maxSourceSpreadMs"]:.4f}</td><td>{r["correlation"]:.8f}</td><td>{r["residualRmsPercent"]:.4f}%</td><td>{r["residualDbRelativeToSignal"]:.1f}</td></tr>' for r in rows)
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eight-speaker listening test</title><style>
body{background:#111820;color:#e8edf3;font:17px/1.6 system-ui;max-width:1050px;margin:40px auto;padding:0 24px}h1{line-height:1.2}section{background:#1b2631;padding:24px;border-radius:14px;margin:24px 0}button{background:#afdacf;color:#10231e;border:0;border-radius:7px;padding:12px 20px;font:inherit;cursor:pointer;margin:5px}audio{width:100%}img{width:100%;background:white}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:8px;text-align:left;border-bottom:1px solid #394957}small{color:#b9c6d4}a{color:#afdacf}</style>
<h1>Eight speakers, one music buffer</h1>
<p>Actual Minecraft output captured from Windows, using your copy of <i>Midnight In A Perfect World</i>. The reference uses the same eight sources and positions, with a client-only atomic restart. The tested version starts through ordinary server packets.</p>
<section><h2>Listen and switch</h2><p>Switching keeps the same playback position. Every version uses the same volume multiplier; no separate loudness normalization.</p>
<button onclick="selectTrack('reference.wav','Aligned reference')">A · aligned reference</button>
<button onclick="selectTrack('eight-speakers.wav','Eight speakers')">B · eight speakers</button>
<button onclick="selectTrack('delay-10ms.wav','Deliberate 10 ms delay')">10 ms control</button>
<button onclick="selectTrack('delay-50ms.wav','Deliberate 50 ms delay')">50 ms control</button>
<p id="label">Eight speakers</p><audio id="player" controls src="eight-speakers.wav"></audio>
<small>Playback switches can click at the transition. Compare the sustained sound after switching. Mono source material is used for positional speakers; the captured output is stereo.</small></section>
<section><h2>What remains after subtraction</h2><p>Selected recording: SELECTED. It has the largest measured residual among the candidate trials without flagged recording contamination. Residual RMS: RESIDUAL% of signal (RESIDUALDB dB). The repeated aligned reference measures FLOORDB dB.</p>
<audio controls src="difference-amplified.wav"></audio><small>The subtraction residual above is amplified BOOST× beyond the common listening gain. It includes capture/rendering differences and is not a direct recording of an audible echo.</small></section>
<img src="waveform-comparison.png" alt="Captured waveform, spectrum, and residual comparisons">
<section><h2>Every recording</h2><table><tr><th>Recording</th><th>Source spread (ms)</th><th>Correlation</th><th>Residual RMS</th><th>Residual (dB)</th></tr>ROWS</table><p>EXCLUSIONS</p></section>
<p><small>Only a global time shift and scalar gain were fitted for analysis. No time stretching or equalization. The source MP3 was downmixed and encoded once; that conversion is shared by all versions. One output device and fixed listener; this is not an analog microphone measurement or a full-song drift test.</small></p>
<script>const player=document.getElementById('player');function selectTrack(file,label){const time=player.currentTime;const playing=!player.paused;player.src=file;document.getElementById('label').textContent=label;player.addEventListener('loadedmetadata',()=>{player.currentTime=Math.min(time,player.duration||time);if(playing)player.play();},{once:true});player.load();}</script></html>'''
    for key, value in {'SELECTED': worst['id'], 'RESIDUALDB': f'{worst["residualDbRelativeToSignal"]:.1f}',
                       'RESIDUAL': f'{worst["residualRmsPercent"]:.4f}', 'FLOORDB': f'{floor["residualDbRelativeToSignal"]:.1f}',
                       'BOOST': f'{difference_boost:.1f}', 'ROWS': table_rows,
                       'EXCLUSIONS': html.escape('* ' + args.exclusion_reason) if args.exclude_from_selection else 'No captures excluded.'}.items():
        page = page.replace(key, value)
    (out / 'index.html').write_text(page, encoding='utf-8')
    print(json.dumps({'selected': worst, 'referenceRepeat': floor, 'controls': controls, 'listening': str(out / 'index.html')}, indent=2))


if __name__ == '__main__':
    main()

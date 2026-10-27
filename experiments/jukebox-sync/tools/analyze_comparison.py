"""Paired real-music comparison, resource counters, long-run timing and local listening page."""
import argparse
import json
from pathlib import Path
import statistics

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from scipy import signal
from scipy.io import wavfile
from analyze_music import load, match, rms, db


def audio_cpu(performance):
    return sum(v for k, v in performance['jvmThreadCpuMs'].items() if 'sound' in k.lower())


def mode_of(name):
    if name.startswith('reference'): return 'atomic'
    return name.split('-')[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    root = args.directory.resolve()
    capture = json.loads((root / 'capture.json').read_text())
    timing = json.loads((root / 'source-timing.json').read_text())
    assert timing.get('status') == 'complete' and capture.get('status') == 'complete'
    assert len(timing['recordings']) == timing['expectedTrials']
    assert len(capture['captures']) == timing['expectedCaptures']
    rate, raw_reference = load(root / 'reference-a.wav')
    block = int(.005 * rate)
    energy = np.array([rms(raw_reference[i:i+block]) for i in range(0, len(raw_reference), block)])
    onset = int(np.flatnonzero(energy > energy.max() * .05)[0] * block)
    start = onset + int(.5 * rate)
    count = int((timing['secondsPerRecording'] - 1.5) * rate)
    reference = raw_reference[start:start + count]
    assert len(reference) == count and rms(reference) > 1e-5
    captured = {c['id']: c for c in capture['captures']}
    aligned = {}
    rows = []
    for trial in timing['recordings']:
        name = trial['id']; observations = trial['observations']
        for o in observations:
            assert len(o['sources']) == timing['speakers']
            assert len({s['source'] for s in o['sources']}) == timing['speakers']
            assert all(s['state'] == 4114 and s['error'] == 0 for s in o['sources'])
        first = observations[0]; last = observations[-1]
        assert last['elapsedSeconds'] >= trial['durationSeconds']
        initial_starts = np.array([s['inferredStartSeconds'] for s in first['sources']])
        first_relative = initial_starts.copy()
        first_relative -= first_relative[0]
        drift = []
        clock_slip = []
        for o in observations:
            starts = np.array([s['inferredStartSeconds'] for s in o['sources']])
            clock_slip.append(float(np.max(np.abs(starts - initial_starts)) * 1000))
            relative = starts - starts[0]
            drift.append(float(np.max(np.abs(relative - first_relative)) * 1000))
        final_buffers = trial['finalBuffers']
        if name.startswith('streamed'):
            assert final_buffers['uniqueStaticBuffers'] == 0
            assert all(s['streamed'] for s in final_buffers['sources'])
        else:
            assert final_buffers['uniqueStaticBuffers'] == 1
            assert all(not s['streamed'] for s in final_buffers['sources'])
        queue_seconds = sum(s['streamQueue'].get('queuedSeconds', 0) for s in final_buffers['sources'])
        decoded_bytes = sum(s['streamQueue'].get('decodedBytes', 0) for s in final_buffers['sources'])
        cpu = trial['playbackPerformance']
        row = {
            'id': name, 'mode': mode_of(name), 'captured': trial['captured'],
            'durationSeconds': trial['durationSeconds'],
            'initialSpreadMs': first['spreadMs'],
            'maxSpreadMs': max(o['spreadMs'] for o in observations),
            'maxRelativeDriftMs': max(drift),
            'maxAbsoluteClockSlipMs': max(clock_slip),
            'approximateFirstStartMs': trial['approximateFirstStartMs'],
            'readyMs': trial['observedReadyMs'],
            'playbackAudioJvmCpuMs': audio_cpu(cpu),
            'playbackAudioJvmCorePercent': audio_cpu(cpu) / cpu['wallMs'] * 100,
            'startupAudioJvmCpuMs': audio_cpu(trial['startupPerformance']),
            'playbackGcMs': cpu['gcMillis'],
            'uniqueStaticBuffers': final_buffers['uniqueStaticBuffers'],
            'staticPcmBytes': final_buffers['staticPcmBytes'],
            'queuedStreamPcmBytes': round(queue_seconds * 48000 * 2),
            'streamDecodedBytes': decoded_bytes,
            'firstSongOffsetSeconds': first['sources'][0]['offsetSeconds'],
            'lastSongOffsetSeconds': last['sources'][0]['offsetSeconds']
        }
        if trial['captured']:
            info = captured[name]
            assert not info['callbackStatuses']
            fs, full = load(root / (name + '.wav'))
            assert fs == rate and np.max(np.abs(full)) < .9999
            # Compare the same early musical passage even for long-run captures.
            raw = full[:int((timing['secondsPerRecording'] + 30) * rate)]
            offset, actual = match(reference, raw)
            gain = float(np.sum(reference * actual) / np.sum(reference * reference))
            residual = actual - gain * reference
            relative_error = rms(residual) / rms(actual)
            block_errors = [100 * rms(residual[i:i+rate]) / max(rms(actual[i:i+rate]), 1e-20)
                            for i in range(0, len(actual)-rate+1, rate)]
            row.update({
                'globalAlignmentSamples': offset,
                'gain': gain,
                'outputRmsVsReferenceDb': db(rms(actual) / rms(reference)),
                'residualRmsPercent': 100 * relative_error,
                'residualDb': db(relative_error),
                'correlation': float(np.corrcoef(reference.ravel(), actual.ravel())[0, 1]),
                'perSecondResidualPercent': block_errors,
                'peak': info['peak'],
            })
            aligned[name] = actual
        rows.append(row)
    summary = {}
    for mode in ['streamed', 'buffered', 'warm', 'atomic']:
        selected = [r for r in rows if r['mode'] == mode and not r['id'].endswith('-999')]
        short_audio = [r for r in selected if r['captured'] and r['id'] != 'reference-a']
        summary[mode] = {
            'starts': len(selected),
            'startsOverOneSample': sum(r['initialSpreadMs'] > 1000/48000 for r in selected),
            'medianStartSpreadMs': statistics.median(r['initialSpreadMs'] for r in selected),
            'maxStartSpreadMs': max(r['initialSpreadMs'] for r in selected),
            'capturedStarts': len(short_audio),
            'minApproximateFirstStartMs': min(r['approximateFirstStartMs'] for r in selected),
            'medianApproximateFirstStartMs': statistics.median(r['approximateFirstStartMs'] for r in selected),
            'maxApproximateFirstStartMs': max(r['approximateFirstStartMs'] for r in selected),
            'medianCapturedApproximateFirstStartMs': statistics.median(r['approximateFirstStartMs'] for r in short_audio),
            'maxRelativeDriftMs': max(r['maxRelativeDriftMs'] for r in selected),
            'medianResidualRmsPercent': statistics.median(r['residualRmsPercent'] for r in short_audio),
            'medianOutputRmsVsReferenceDb': statistics.median(r['outputRmsVsReferenceDb'] for r in short_audio),
            'medianPlaybackAudioJvmCorePercent': statistics.median(r['playbackAudioJvmCorePercent'] for r in short_audio),
            'medianStaticPcmBytes': statistics.median(r['staticPcmBytes'] for r in selected),
            'medianQueuedStreamPcmBytes': statistics.median(r['queuedStreamPcmBytes'] for r in selected),
        }
    output = {
        'status': 'complete', 'device': timing['device'], 'speakers': timing['speakers'],
        'stressThreads': timing['stressThreads'], 'mods': timing['mods'],
        'summary': summary, 'trials': rows,
        'method': 'Same full-track OGG, same source positions and gain, real jukebox packets. Captured atomic reference. One global time shift and gain fit; no time warping.',
        'limits': [
            'Instrumented Fabric client; renderer mods, if present, are listed. No modified sound scheduling in packet-start cases.',
            'Native mixer and output-driver CPU are not included in JVM Sound engine thread CPU.',
            'PCM sizes measure audio payload, not total process memory or peak decoder allocations.',
            'First-start latency is estimated from wall time minus the audio playhead; approximately one mixer interval uncertainty and not physical output latency.',
            'Windows endpoint recordings can contain unrelated sounds. No recordings are silently excluded.',
            'Warm means actual replay of a native buffer retained from the preceding cold trial; it requires no client readiness acknowledgement.',
            'Source progress includes removed queued-buffer durations, so stream queue rotation is not misreported as drift.',
        ]
    }
    listening = root / 'comparison'
    listening.mkdir(exist_ok=True)
    representatives = {'atomic': 'reference-b'}
    for mode in ['streamed', 'buffered', 'warm']:
        choices = sorted([r for r in rows if r['mode'] == mode and r['captured'] and not r['id'].endswith('-999')], key=lambda r: r['residualRmsPercent'])
        representatives[mode] = choices[len(choices)//2]['id']
    representatives['warm-worst'] = max([r for r in rows if r['mode'] == 'warm' and r['captured']], key=lambda r:r['residualRmsPercent'])['id']
    signals = {key: aligned[name] for key, name in representatives.items()}
    common_gain = .8 / max(np.max(np.abs(x)) for x in signals.values())
    target_rms = min(rms(x) for x in signals.values())
    for key, pcm in signals.items():
        wavfile.write(listening / (key + '.wav'), rate, np.round(np.clip(pcm * common_gain, -.999, .999)*32767).astype(np.int16))
        matched = pcm * common_gain * target_rms / rms(pcm)
        wavfile.write(listening / (key + '-matched.wav'), rate, np.round(np.clip(matched,-.999,.999)*32767).astype(np.int16))
    output['listeningSelection'] = representatives
    output['listeningSelectionRule'] = 'Upper median residual in each method; warm-worst is the largest residual captured warm replay. All metrics retained.'
    (root / 'comparison.json').write_text(json.dumps(output, indent=2))
    fig, axes = plt.subplots(2, 2, figsize=(13, 9), constrained_layout=True)
    labels = ['Vanilla streaming', 'Buffered first use', 'Buffered replay', 'Atomic reference']
    modes = ['streamed', 'buffered', 'warm', 'atomic']
    colors = ['#cb6340','#2989a0','#5f9270','#8c72ac']
    for i, mode in enumerate(modes):
        selected = [r for r in rows if r['mode']==mode and not r['id'].endswith('-999')]
        xs = [i + ((j%9)-4)*.025 for j in range(len(selected))]
        axes[0,0].scatter(xs,[r['initialSpreadMs'] for r in selected],color=colors[i],alpha=.6,s=24)
    axes[0,0].set(ylabel='Earliest-to-latest start (ms)',title='Every observed start; horizontal spacing only separates dots')
    axes[0,0].set_xticks(range(4),labels,rotation=15)
    residuals = [summary[m]['medianResidualRmsPercent'] for m in modes]
    bars = axes[0,1].bar(labels, residuals, color=colors)
    axes[0,1].bar_label(bars, labels=[f'{v:.3f}%' for v in residuals], padding=4)
    axes[0,1].set(ylabel='Median waveform residual RMS (%)',title='Same musical passage versus recorded atomic reference')
    axes[0,1].tick_params(axis='x',rotation=15)
    axes[1,0].bar(labels[:3],[summary[m]['medianPlaybackAudioJvmCorePercent'] for m in modes[:3]],color=colors[:3])
    axes[1,0].set(ylabel='One CPU core (%)',title='JVM sound-thread CPU during playback; excludes native mixer')
    axes[1,0].tick_params(axis='x',rotation=15)
    for mode in ['streamed','buffered']:
        long_trial = next((r for r in timing['recordings'] if r['id']==mode+'-999'),None)
        if long_trial:
            obs=long_trial['observations'];axes[1,1].plot([o['elapsedSeconds'] for o in obs],[o['spreadMs'] for o in obs],label=mode)
    axes[1,1].set(xlabel='Elapsed playback (s)',ylabel='Source separation (ms)',title='Long playback; stream queue rotation accounted for')
    if axes[1,1].lines: axes[1,1].legend()
    for ax in axes.ravel():ax.grid(axis='y',alpha=.2)
    fig.suptitle(f'{timing["speakers"]} sources — real-song comparison',fontsize=16)
    fig.savefig(listening/'comparison.png',dpi=150)
    fig.savefig(listening/'comparison.svg')
    # A second figure shows what the metric means in the recorded audio.
    fig2, (wave, spectrum) = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True)
    center = int(np.argmax(np.abs(reference[:, 0])))
    center = min(max(center, int(.025 * rate)), len(reference) - int(.025 * rate) - 1)
    left, right = center - int(.025 * rate), center + int(.025 * rate)
    for key, color, label in zip(['atomic', 'streamed', 'buffered', 'warm'],
                                 ['#8c72ac', '#cb6340', '#2989a0', '#5f9270'],
                                 ['Atomic repeat', 'Vanilla streaming', 'Buffered first use', 'Buffered replay']):
        pcm = signals[key] * rms(reference) / rms(signals[key])
        wave.plot(np.arange(right-left) / rate * 1000, pcm[left:right, 0], label=label, color=color, alpha=.8)
        f, p = signal.welch(pcm, rate, nperseg=8192, axis=0)
        spectrum.semilogx(f[1:], 10*np.log10(np.maximum(p[1:].mean(axis=1), 1e-20)), label=label, color=color, alpha=.8)
    wave.set(xlabel='Time within excerpt (ms)', ylabel='Left-channel amplitude', title='Same 50 ms passage, globally aligned and average-level matched')
    spectrum.set(xlabel='Frequency (Hz)', ylabel='Power density (dB/Hz)', xlim=(30, 18000), title='Recorded spectrum after average-level matching')
    for ax in [wave, spectrum]: ax.grid(alpha=.2); ax.legend()
    fig2.savefig(listening/'waveforms.png', dpi=150)
    fig2.savefig(listening/'waveforms.svg')
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jukebox playback comparison</title>
<style>body{background:#121b23;color:#e6edf3;font:17px/1.6 system-ui;max-width:1050px;margin:32px auto;padding:0 20px}section{background:#1d2b37;padding:22px;margin:22px 0;border-radius:12px}button,select{padding:10px;margin:5px;font:inherit;border-radius:7px}button{cursor:pointer}audio,img{width:100%}small{color:#bdc9d4}h1{line-height:1.2}</style>
<h1>Does the speaker system improve the sound?</h1><p>Actual Minecraft recordings of your track through the same speaker layout. Streaming, buffered first playback, buffered replay, and an atomic client-side reference.</p>
<section><h2>Direct comparison</h2><label><input id="matched" type="checkbox" checked> Match average level</label><p>Level matching helps compare sound quality separately from volume. Each example is selected near the middle of its method’s measured waveform errors.</p>
<button onclick="choose('streamed','Vanilla streaming')">Vanilla streaming</button><button onclick="choose('buffered','Buffered first use')">Buffered first use</button><button onclick="choose('warm','Buffered replay')">Buffered replay</button><button onclick="choose('atomic','Atomic reference')">Atomic reference</button><button onclick="choose('warm-worst','Largest captured replay error')">Largest replay error</button>
<p id="label">Buffered first use</p><audio id="player" controls src="buffered-matched.wav"></audio><small>Switches preserve position; a switch itself may click. Compare the sustained sound afterward.</small></section>
<section><h2>Blind listening check</h2><p>Choose a pair, listen to A, B and X, then identify X. Results appear after 10 answers. This evaluates your listening result on these selected clips, not all hardware or songs.</p>
<select id="pair"><option value="streamed,buffered">Streaming versus buffered</option><option value="buffered,atomic">Buffered versus atomic reference</option><option value="warm,atomic">Buffered replay versus atomic reference</option></select><button onclick="startTest()">Start / reset 10 trials</button>
<div><button onclick="abxListen(0)">Listen A</button><button onclick="abxListen(1)">Listen B</button><button onclick="abxListen(2)">Listen X</button></div><div><button onclick="answer(0)">X is A</button><button onclick="answer(1)">X is B</button></div><p id="score">Not started.</p></section>
<img src="comparison.png" alt="Measured start spread, waveform residual, audio-thread CPU and long-run separation">
<img src="waveforms.png" alt="Level-matched recorded waveform and spectrum comparison">
<p><small>The atomic reference requires client-side control. Ordinary packet-start cases use the vanilla sound engine. All methods share the same mono conversion. PCM output recordings are stereo. Endpoint capture is not an acoustic measurement.</small></p>
<script>const player=document.getElementById('player');let key='buffered';function playFile(file,label,force=false){let t=player.currentTime;let play=force||!player.paused;player.src=file;document.getElementById('label').textContent=label;player.addEventListener('loadedmetadata',()=>{player.currentTime=Math.min(t,Math.max(0,player.duration-.05));if(play)player.play();},{once:true});player.load()}function choose(k,label){key=k;playFile(k+(document.getElementById('matched').checked?'-matched':'')+'.wav',label)}document.getElementById('matched').onchange=()=>choose(key,key);let test=null;function randomBit(){return crypto.getRandomValues(new Uint32Array(1))[0]&1}function startTest(){let p=document.getElementById('pair').value.split(',');if(randomBit())p.reverse();test={pair:p,n:0,right:0,x:randomBit()};document.getElementById('score').textContent='Trial 1 of 10';}function abxListen(which){if(!test)startTest();let i=which===2?test.x:which;playFile(test.pair[i]+'-matched.wav',['A','B','X'][which],true)}function answer(i){if(!test)return;test.right+=Number(i===test.x);test.n++;if(test.n===10){let k=test.right,p=0;for(let j=k;j<=10;j++){let c=1;for(let z=1;z<=j;z++)c=c*(11-z)/z;p+=c/1024}document.getElementById('score').textContent=k+'/10 correct; chance probability of this many or more: '+(p*100).toFixed(2)+'%. A='+test.pair[0]+', B='+test.pair[1]+'.';test=null;}else{test.x=randomBit();document.getElementById('score').textContent='Trial '+(test.n+1)+' of 10';}}</script></html>'''
    (listening/'index.html').write_text(page,encoding='utf-8')
    print(json.dumps({'summary':summary,'listening':str(listening/'index.html')},indent=2))


if __name__ == '__main__': main()

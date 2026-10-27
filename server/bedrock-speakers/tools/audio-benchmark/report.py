"""Export the measured audio offsets and every accepted/rejected trial as HTML and PNG."""
import argparse
import html
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def format_ms(value):
    return 'unavailable' if value is None else '<1 ms' if abs(value) < 1 else f'{value:.1f} ms'


def report(root):
    data = json.loads((root / 'paired-analysis.json').read_text())
    cases = [('pair-raw-01', 'Unprepared start'), ('production-before-01', 'Old translator, warm cache'),
             ('production-after-rejoin-01', 'Prepared start after reconnect'),
             ('production-late-01', 'Late attachment, gated test'),
             ('production-late-continuous-01', 'Late attachment, continuous audio')]
    lookup = {trial['label']: trial for trial in data['trials']}
    selected = [(label, lookup[key]['lateSpreadMs']) for key, label in cases
                if key in lookup and lookup[key].get('lateSpreadMs') is not None]
    fig, ax = plt.subplots(figsize=(10, 4.6), constrained_layout=True)
    for index, (label, value) in enumerate(selected):
        ax.barh(index, max(value, 1), color='#2563eb' if value < 1 else '#d97706', height=.6)
        ax.text(max(value, 1) * 1.12, index, format_ms(value), va='center', fontsize=11)
    ax.set_yticks(range(len(selected)), [label for label, _ in selected]); ax.invert_yaxis()
    ax.set_xscale('log'); ax.set_xlim(.5, max(2000, max((value for _, value in selected), default=1) * 3))
    ax.set_xticks([1, 10, 100, 1000], ['1', '10', '100', '1000'])
    ax.set_xlabel('Relative audio spread (ms, logarithmic scale; reporting floor 1 ms)')
    ax.set_title('Measured Minecraft Bedrock audio offsets\nAccepted windows; rejected or partial runs remain in the report', loc='left', pad=15)
    ax.grid(axis='x', alpha=.2); ax.set_axisbelow(True)
    fig.savefig(root / 'audio-offsets.png', dpi=160); plt.close(fig)
    rows = []
    for trial in data['trials']:
        quality = trial.get('mixedVoicesQuality', {})
        reason = trial.get('reason') or '; '.join(sorted({row.get('reason', 'Low correlation')
                 for row in trial.get('windows', []) if not row['valid']}))
        cells = [trial['label'], 'Accepted' if trial['valid'] else 'Rejected / partial windows only',
                 format_ms(trial.get('earlySpreadMs')), format_ms(trial.get('lateSpreadMs')),
                 f"{quality['fitCorrelation']:.6f}" if 'fitCorrelation' in quality else 'unavailable', reason]
        rows.append('<tr>' + ''.join('<td>' + html.escape(cell) + '</td>' for cell in cells) + '</tr>')
    document = '''<!doctype html><meta charset="utf-8"><title>Bedrock audio measurements</title>
<style>body{font:16px system-ui;margin:3rem;max-width:1200px;color:#172033}img{max-width:100%}
table{border-collapse:collapse;width:100%}td,th{padding:.6rem;border-bottom:1px solid #ddd;text-align:left}</style>
<h1>Bedrock audio measurements</h1><p>Process-only WASAPI capture of Minecraft for Windows, matched against
the exact source recording. Simultaneous pairs share a continuously audible anchor. Capture QPC timestamps
reject gaps; band-limited interpolation avoids mistaking interpolation error for sub-millisecond delays.</p>
<p>The reporting resolution is 1 ms. Synthetic delays validate the analysis, not the client. Warm and
unprepared starts are different test conditions. Only valid windows contribute to numeric spreads;
an overall rejected run remains listed and must not be counted as a full pass.</p>
<img src="audio-offsets.png" alt="Measured relative audio offsets">
<table><tr><th>Trial</th><th>Status</th><th>Early spread</th><th>Late spread</th><th>All voices correlation</th><th>Reason</th></tr>'''
    (root / 'report.html').write_text(document + ''.join(rows) + '</table>', encoding='utf-8')
    print(root / 'report.html')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('root', type=Path)
    report(parser.parse_args().root)

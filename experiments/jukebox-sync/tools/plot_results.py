"""Plot completed, comparable world runs from their raw per-source measurements."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument('reports', nargs='+', type=Path)
parser.add_argument('--output', type=Path, default=Path('results/start-spread.png'))
args = parser.parse_args()
reports = [(path.stem, json.loads(path.read_text())) for path in args.reports]
if any(report.get('status') != 'complete' for _, report in reports):
    raise SystemExit('Only completed runs can be plotted')
fig, axes = plt.subplots(1, len(reports), figsize=(5 * len(reports), 4.6), sharey=True, squeeze=False)
colors = {'streamed': '#d45b37', 'buffered-cold': '#297fa3', 'preloaded': '#439064'}
for ax, (name, report) in zip(axes[0], reports):
    for index, mode in enumerate(colors):
        for delivery, marker, dx in [('individual', 'o', -.15), ('bundle', 'x', .15)]:
            values = [max(t['initialSpreadMs'], t['laterSpreadMs']) for t in report['trials']
                      if t['mode'] == mode and t.get('delivery') == delivery and t['speakers'] == 8]
            # Deterministic horizontal spacing exposes repeated readings without changing y values.
            xs = [index + dx + ((i % 7) - 3) * .025 for i in range(len(values))]
            ax.scatter(xs, values, marker=marker, s=22, alpha=.6, color=colors[mode],
                       label=delivery if index == 0 else None)
    ax.set_xticks(range(3), ['Streamed', 'Buffered\ncold cache', 'Buffer ready'])
    ax.set_title(name.replace('world-', '').capitalize())
    ax.grid(axis='y', alpha=.2)
    ax.set_axisbelow(True)
    ax.legend(fontsize=8)
axes[0, 0].set_ylabel('Earliest-to-latest source start spread (ms)')
fig.suptitle('Eight speakers in a loaded world — individual trials', fontsize=14)
fig.text(.5, .01, 'One Windows client/audio device; 12 s and 180 s fixtures pooled. Zero observed offset is not a synchronization guarantee.',
         ha='center', fontsize=8)
fig.tight_layout(rect=(0, .04, 1, .93))
args.output.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(args.output, dpi=160)
fig.savefig(args.output.with_suffix('.svg'))
print(args.output)

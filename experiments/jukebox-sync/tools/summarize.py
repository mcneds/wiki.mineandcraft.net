"""Summarize raw audio-clock measurements; do not equate no measured offset with a guarantee."""
import argparse
import csv
from collections import defaultdict
import json
import math
from pathlib import Path
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('reports', nargs='+', type=Path)
parser.add_argument('--csv', type=Path)
args = parser.parse_args()
rows = []
for path in args.reports:
    report = json.loads(path.read_text())
    if report.get('status') != 'complete':
        raise SystemExit(f'{path}: incomplete run')
    if 'expectedTrials' in report and len(report['trials']) != report['expectedTrials']:
        raise SystemExit(f'{path}: incomplete scenario matrix')
    print(f'\n{path.name}: {len(report["trials"])} trials; {report["device"]}')
    groups = defaultdict(list)
    for trial in report['trials']:
        if len(trial['initial']) != trial['speakers'] or len(trial['later']) != trial['speakers']:
            raise SystemExit(f'{path}: missing sources')
        if any(sample['state'] != 4114 or sample['error'] for sample in trial['initial'] + trial['later']):
            raise SystemExit(f'{path}: source not playing or OpenAL error')
        key = (trial.get('delivery', 'direct'), trial['mode'], trial.get('seconds', 12), trial['speakers'], trial.get('submitGapMs', 0))
        groups[key].append(trial)
    print('| Delivery / mode | Seconds | Sources | Gap control | N | Median ms | P95 ms | Max ms | >1 sample |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (delivery, mode, seconds, count, gap), trials in sorted(groups.items()):
        if sorted(t['repetition'] for t in trials) != list(range(report['rounds'])):
            raise SystemExit(f'{path}: missing or duplicated repetitions')
        spread = sorted(max(t['initialSpreadMs'], t['laterSpreadMs']) for t in trials)
        n = len(spread)
        rows.append([path.stem, delivery, mode, seconds, count, gap, n, statistics.median(spread),
                     spread[math.ceil(n * .95) - 1], spread[-1], sum(v > 1000 / 44100 for v in spread)])
        print(f'| {delivery} / {mode} | {seconds} | {count} | {gap} | {n} | {statistics.median(spread):.3f} | '
              f'{spread[math.ceil(n * .95) - 1]:.3f} | {spread[-1]:.3f} | {sum(v > 1000 / 44100 for v in spread)} |')
    print('Maximum change in spread between observations: '
          f'{max(abs(t["initialSpreadMs"] - t["laterSpreadMs"]) for t in report["trials"]):.6f} ms')
if args.csv:
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    with args.csv.open('w', newline='') as output:
        writer = csv.writer(output)
        writer.writerow(['run', 'delivery', 'mode', 'duration_seconds', 'speakers', 'control_gap_ms',
                         'n', 'median_ms', 'p95_ms', 'max_ms', 'above_one_sample'])
        writer.writerows(rows)

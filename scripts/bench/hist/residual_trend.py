#!/usr/bin/env python3
# Checkpoint/control residual trends against distance from the block centre (SAT-6).
# usage: residual_trend.py <run.json> <truth.json | gcp.csv> [stage ...]
# Per recon stage: control / checkpoint RMS, the vertical residual's r² trend (a bowl or
# dome, e.g. Earth curvature or a k1 trade-off) and |dH| against r, as the fit's value
# at 125 km with its correlation. Positions from a synthetic block's truth.json or a
# hist gcp.csv (x_map, y_map).
import json, math, re, sys
import csv
run = json.load(open(sys.argv[1]))
if sys.argv[2].endswith('.csv'):   # a hist gcp.csv: gcp_label, x_map, y_map
    pos = {r['gcp_label']: (float(r['x_map']), float(r['y_map'])) for r in csv.DictReader(open(sys.argv[2]))}
else:
    pos = {g['label']: (g['E'], g['N']) for g in json.load(open(sys.argv[2]))['gcps']}
stages = sys.argv[3:] or [k for k in run['stages'] if k.startswith('recon')]
def fit(xs, ys):
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs); syy = sum((y - my) ** 2 for y in ys) or 1e-12
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / sxx, sxy / math.sqrt(sxx * syy)
for st in stages:
    g = run['stages'][st].get('gcpResiduals')
    if not g or 'rows' not in g: print(st, 'no residuals'); continue
    rows = []
    for r in g['rows']:
        m = re.match(r'(\S+) (\w+): dE (\S+) dN (\S+) dU (\S+) m', r)
        n, role, e, nn, u = m.groups(); rows.append((n, role, float(e), float(nn), float(u)))
    E0 = sum(pos[r[0]][0] for r in rows) / len(rows); N0 = sum(pos[r[0]][1] for r in rows) / len(rows)
    R = [math.hypot(pos[r[0]][0] - E0, pos[r[0]][1] - N0) / 1000 for r in rows]
    U = [r[4] for r in rows]; H = [math.hypot(r[2], r[3]) for r in rows]
    bu, cu = fit([x * x for x in R], U); bh, ch = fit(R, H)
    c, k = g['control'], g['check']
    print(f"{st:14s} control H/V {c['rmsH']:.2f}/{c['rmsV']:.2f}  check H/V {k['rmsH']:.2f}/{k['rmsV']:.2f} (n {k['n']})  "
          f"dU~r²: {bu*125**2:+.1f} m at 125 km (corr {cu:.2f})  |dH|~r: {bh*125:+.1f} m at 125 km (corr {ch:.2f})")

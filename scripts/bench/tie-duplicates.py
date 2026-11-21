"""Near-duplicate tie points in a WebSfM replay's final tracks (dev/baselines.md ▸ B-tie-2026-11-21).

    python tie-duplicates.py <replay dir> [radius px]

Reads the decomposition replay's tie.* dump (tie.vcount.u32, tie.vcam.u32, tie.kx.f64,
tie.ky.f64, tie.ks.f32). Two different tie points whose observations in one photo lie within
`radius` (recorded keypoint positions, full-resolution px; default 1) are a close pair; they
are a duplicate track when they are close in at least two photos (one feature measured twice,
e.g. at neighbouring scales or as two orientations of one keypoint). Prints the close pairs,
how many sit at the same position (< 0.05 px: one keypoint at two orientations), the scale
ratio of the close pairs, and the duplicate tracks' share of points and observations.
"""
import json
import sys

import numpy as np
from scipy.spatial import cKDTree

d = sys.argv[1]
rad = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
vc = np.fromfile(f'{d}/tie.vcount.u32', '<u4').astype(np.int64)
cam = np.fromfile(f'{d}/tie.vcam.u32', '<u4').astype(np.int64)
kx = np.fromfile(f'{d}/tie.kx.f64')
ky = np.fromfile(f'{d}/tie.ky.f64')
ks = np.fromfile(f'{d}/tie.ks.f32', '<f4')
pt = np.repeat(np.arange(len(vc)), vc)
order = np.argsort(cam, kind='stable')
bounds = np.searchsorted(cam[order], np.arange(cam.max() + 2))
pairs = {}  # (p, q) -> photos where the two points are close
same = 0
close_obs = 0
ratios = []
for c in range(cam.max() + 1):
    idx = order[bounds[c]:bounds[c + 1]]
    if len(idx) < 2:
        continue
    pr = cKDTree(np.stack([kx[idx], ky[idx]], 1)).query_pairs(rad, output_type='ndarray')
    if not len(pr):
        continue
    a = idx[pr[:, 0]]
    b = idx[pr[:, 1]]
    close_obs += len(pr)
    same += int((np.hypot(kx[a] - kx[b], ky[a] - ky[b]) < 0.05).sum())
    for u, v in zip(np.minimum(pt[a], pt[b]).tolist(), np.maximum(pt[a], pt[b]).tolist()):
        pairs[(u, v)] = pairs.get((u, v), 0) + 1
    ratios.append(np.maximum(ks[a], ks[b]) / np.maximum(1e-6, np.minimum(ks[a], ks[b])))
dpts = {p for k, n in pairs.items() if n >= 2 for p in k}
sr = np.concatenate(ratios) if ratios else np.ones(1)
obs_in_dup = int(vc[list(dpts)].sum()) if dpts else 0
print(json.dumps({
    'radius_px': rad,
    'points': int(len(vc)),
    'observations': int(vc.sum()),
    'close_pairs': close_obs,
    'close_pairs_same_position': same,
    'close_pairs_scale_ratio_median_p90': [round(float(np.median(sr)), 3), round(float(np.percentile(sr, 90)), 3)],
    'duplicate_tracks': sum(1 for n in pairs.values() if n >= 2),
    'points_in_duplicates': len(dpts),
    'share_of_points': round(len(dpts) / len(vc), 5),
    'share_of_observations': round(obs_in_dup / int(vc.sum()), 5),
}))

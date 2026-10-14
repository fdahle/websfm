"""Score exported clouds (run-bench `exportCloudsProject`) against a synthetic block's
truth surface: height error of every point vs truth_dem.tif (bilinear), overall and by
view count for the sparse cloud.

    python score_points.py <truth_dem.tif> <run>.sparse.project.bin [<run>.dense.project.bin ...]
"""
import json
import sys

import numpy as np
import rasterio


def sample(ds, arr, x, y):
    col, row = ~ds.transform * (x, y)
    col, row = col - 0.5, row - 0.5
    c0, r0 = np.floor(col).astype(int), np.floor(row).astype(int)
    ok = (c0 >= 0) & (r0 >= 0) & (c0 < arr.shape[1] - 1) & (r0 < arr.shape[0] - 1)
    c0, r0 = np.where(ok, c0, 0), np.where(ok, r0, 0)
    fc, fr = col - c0, row - r0
    v = (arr[r0, c0] * (1 - fc) + arr[r0, c0 + 1] * fc) * (1 - fr) + (arr[r0 + 1, c0] * (1 - fc) + arr[r0 + 1, c0 + 1] * fc) * fr
    return np.where(ok, v, np.nan)


def stats(d):
    d = d[np.isfinite(d)]
    if not d.size:
        return {'n': 0}
    med = float(np.median(d))
    return {'n': int(d.size), 'mean': round(float(d.mean()), 2), 'median': round(med, 2),
            'nmad': round(float(1.4826 * np.median(np.abs(d - med))), 2), 'rmse': round(float(np.sqrt((d * d).mean())), 2)}


def main():
    ds = rasterio.open(sys.argv[1])
    arr = ds.read(1).astype(np.float64)
    out = {}
    for f in sys.argv[2:]:
        kind = 'sparse' if '.sparse.' in f else 'dense'
        v = np.fromfile(f, np.float64).reshape(-1, 4 if kind == 'sparse' else 3)
        d = v[:, 2] - sample(ds, arr, v[:, 0], v[:, 1])
        out[f] = {'all': stats(d)}
        if kind == 'sparse':
            for lo, hi in [(2, 2), (3, 3), (4, 5), (6, 99)]:
                out[f][f'views {lo}-{hi}'] = stats(d[(v[:, 3] >= lo) & (v[:, 3] <= hi)])
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()

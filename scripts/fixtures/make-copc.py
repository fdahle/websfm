"""COPC test files, written by PDAL (the reference COPC writer).

    conda create -n copc_tools -c conda-forge pdal python-pdal numpy
    conda run -n copc_tools python scripts/fixtures/make-copc.py tiny  <out dir>
    conda run -n copc_tools python scripts/fixtures/make-copc.py large <out dir> <scan.ply> ...

tiny:  a synthetic survey (ground, a building, trees) in EPSG:25832, LAS 1.4 point
       format 7 (RGB) with intensity, classes and returns, as COPC and as a plain LAZ
       of the same points. Small enough to commit (src/core/lod/fixtures/).
large: real laser scans (e.g. the ETH3D dslr_scan_eval PLYs) laid side by side in a
       grid in EPSG:25832, as COPC and as a plain LAZ (point format 6), to time the
       COPC import against the streamed LAZ import. Not committed.
"""
import json
import sys

import numpy as np
import pdal

WKT_SRS = 'EPSG:25832'


def tiny(out):
    rng = np.random.default_rng(7)
    n = 24_000
    x = rng.uniform(0, 120, n)
    y = rng.uniform(0, 80, n)
    ground = 2 + np.sin(x / 15) * 1.5 + y * 0.02
    z = ground.copy()
    cls = np.full(n, 2, np.uint8)
    building = (x > 40) & (x < 70) & (y > 20) & (y < 50)
    z[building] += 9
    cls[building] = 6
    trees = (~building) & (rng.uniform(0, 1, n) < 0.15)
    z[trees] += rng.uniform(2, 12, trees.sum())
    cls[trees] = 5
    returns = np.ones(n, np.uint8)
    nret = np.ones(n, np.uint8)
    nret[trees] = 2
    returns[trees] = rng.integers(1, 3, trees.sum()).astype(np.uint8)
    data = np.zeros(n, dtype=[
        ('X', 'f8'), ('Y', 'f8'), ('Z', 'f8'), ('Intensity', 'u2'), ('ReturnNumber', 'u1'),
        ('NumberOfReturns', 'u1'), ('Classification', 'u1'), ('Red', 'u2'), ('Green', 'u2'), ('Blue', 'u2'),
    ])
    data['X'] = 480_000 + x
    data['Y'] = 5_200_000 + y
    data['Z'] = z
    data['Intensity'] = (cls.astype(np.uint16) * 1000 + rng.integers(0, 500, n)).astype(np.uint16)
    data['ReturnNumber'] = returns
    data['NumberOfReturns'] = nret
    data['Classification'] = cls
    data['Red'] = np.where(cls == 6, 200, 60).astype(np.uint16) * 256
    data['Green'] = np.where(cls == 5, 180, 90).astype(np.uint16) * 256
    data['Blue'] = np.where(cls == 2, 140, 50).astype(np.uint16) * 256
    write(data, out, 'tiny', 7, scale=0.01)


def large(out, scans):
    parts = []
    side = int(np.ceil(np.sqrt(len(scans))))
    for k, path in enumerate(scans):
        arr = pdal.Reader.ply(path).pipeline()
        arr.execute()
        a = arr.arrays[0]
        x0, y0 = a['X'].min(), a['Y'].min()
        a['X'] = a['X'] - x0 + 480_000 + (k % side) * 200
        a['Y'] = a['Y'] - y0 + 5_200_000 + (k // side) * 200
        a['Z'] = a['Z'] - a['Z'].min() + 50
        parts.append(a[['X', 'Y', 'Z']])
        print(f'{path}: {len(a):,} points', flush=True)
    data = np.concatenate(parts)
    write(data, out, 'large', 6, scale=0.001)


def write(data, out, name, fmt, scale):
    common = {'a_srs': WKT_SRS, 'scale_x': scale, 'scale_y': scale, 'scale_z': scale,
              'offset_x': 'auto', 'offset_y': 'auto', 'offset_z': 'auto'}
    copc = pdal.Pipeline(json.dumps([{'type': 'writers.copc', 'filename': f'{out}/{name}.copc.laz', **common}]),
                         arrays=[data])
    copc.execute()
    laz = pdal.Pipeline(json.dumps([{'type': 'writers.las', 'filename': f'{out}/{name}.laz', 'compression': 'laszip',
                                     'minor_version': 4, 'dataformat_id': fmt, **common}]), arrays=[data])
    laz.execute()
    print(f'{name}: {len(data):,} points → {out}/{name}.copc.laz, {out}/{name}.laz')


if __name__ == '__main__':
    kind, out = sys.argv[1], sys.argv[2]
    if kind == 'tiny':
        tiny(out)
    else:
        large(out, sys.argv[3:])

"""Score a DEM GeoTIFF against a reference DEM, the way the Grenoble historical-image
benchmark evaluation did it (historic_sfm ▸ dem_diff.json): the test DEM is resampled
bilinearly onto the reference grid over their overlap, and dem - ref is summarised over
every cell valid in both.

    python score_dem.py <dem.tif> <reference.tif> [--out stats.json] [--diff diff.tif]
                        [--mask stable.tif]   cells where mask == 1 only (e.g. stable terrain)

Prints and writes: mean, median, std, rmse, nmad (1.4826 * MAD), count, plus the share
of the test DEM's bounding box that is valid (coverage). Streams the reference in row
blocks (peak ≈ 4 bytes per overlapping reference cell). Run with the hist_env3 interpreter (rasterio + numpy).
"""
import argparse
import json
import sys

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import Window, from_bounds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dem")
    ap.add_argument("ref")
    ap.add_argument("--out")
    ap.add_argument("--diff")
    ap.add_argument("--mask")
    ap.add_argument("--block-rows", type=int, default=2048)
    a = ap.parse_args()

    # Streamed over row blocks of the reference grid: the 1 m Casa Grande reference is
    # 1.1 G cells, and holding it, the resampled DEM and their temporaries at once took
    # 30–50 GB (the 2026-10-14 OOM kills). Valid differences go into one float32 buffer
    # (median and NMAD stay exact, computed in place); p90 |d| comes from a 1 cm histogram.
    with rasterio.open(a.dem) as src, rasterio.open(a.ref) as ref:
        ref_crs = ref.crs if ref.crs is not None else src.crs
        b = transform_bounds(src.crs, ref_crs, *src.bounds) if src.crs and ref_crs and src.crs != ref_crs else src.bounds
        left, bottom = max(b[0], ref.bounds.left), max(b[1], ref.bounds.bottom)
        right, top = min(b[2], ref.bounds.right), min(b[3], ref.bounds.top)
        if right <= left or top <= bottom:
            sys.exit("no overlap between DEM and reference")
        win = from_bounds(left, bottom, right, top, ref.transform).round_offsets().round_lengths()
        rt = ref.window_transform(win)
        H, W = int(win.height), int(win.width)
        s = src.read(1).astype(np.float32)
        if src.nodata is not None:
            s[s == src.nodata] = np.nan
        valid_box = float(np.isfinite(s).mean())
        mask_ds = rasterio.open(a.mask) if a.mask else None
        diff_ds = None
        if a.diff:
            diff_ds = rasterio.open(a.diff, "w", driver="GTiff", height=H, width=W, count=1, dtype="float32", crs=ref_crs,
                                    transform=rt, nodata=np.nan, compress="deflate", tiled=True, BIGTIFF="IF_SAFER")
        buf = np.empty(H * W, np.float32)  # virtual until written: only valid cells are touched
        n, s1, s2 = 0, 0.0, 0.0
        habs = np.zeros(200001, np.int64)  # |d| in 1 cm bins up to 2 km
        for r0 in range(0, H, a.block_rows):
            h = min(a.block_rows, H - r0)
            bw = Window(win.col_off, win.row_off + r0, W, h)
            r = ref.read(1, window=bw, masked=True).astype(np.float32)
            r = np.where(np.ma.getmaskarray(r), np.nan, r.data)
            if ref.nodata is not None:
                r[r == ref.nodata] = np.nan
            bt = ref.window_transform(bw)
            t = np.full(r.shape, np.nan, np.float32)
            reproject(s, t, src_transform=src.transform, src_crs=src.crs or ref_crs, src_nodata=np.nan,
                      dst_transform=bt, dst_crs=ref_crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
            t -= r
            if mask_ds is not None:
                mm = np.zeros(r.shape, np.float32)
                reproject(mask_ds.read(1).astype(np.float32), mm, src_transform=mask_ds.transform,
                          src_crs=mask_ds.crs or ref_crs, dst_transform=bt, dst_crs=ref_crs, resampling=Resampling.nearest)
                t[mm != 1] = np.nan
            if diff_ds is not None:
                diff_ds.write(t, 1, window=Window(0, r0, W, h))
            v = t[np.isfinite(t)]
            buf[n:n + v.size] = v
            n += v.size
            s1 += float(v.sum(dtype=np.float64))
            s2 += float(np.square(v, dtype=np.float64).sum())
            habs += np.bincount(np.minimum(np.abs(v) * 100, 200000).astype(np.int64), minlength=200001)
        if diff_ds is not None:
            diff_ds.close()

    if n == 0:
        out = {"count": 0}
    else:
        d = buf[:n]
        mean = s1 / n
        m = n // 2
        d.partition(m)
        med = float(d[m]) if n % 2 else float((d[m] + d[:m].max()) / 2)
        np.subtract(d, med, out=d)
        np.abs(d, out=d)
        d.partition(m)
        mad = float(d[m]) if n % 2 else float((d[m] + d[:m].max()) / 2)
        k = int(np.searchsorted(np.cumsum(habs), 0.9 * n))
        out = {
            "mean_diff": mean,
            "median_diff": med,
            "std_diff": float(np.sqrt(max(0.0, s2 / n - mean * mean))),
            "rmse_diff": float(np.sqrt(s2 / n)),
            "nmad_diff": float(1.4826 * mad),
            "p90_abs_diff": (k + 0.5) / 100,
            "count": int(n),
        }
    out["dem_valid_share_of_bbox"] = round(valid_box, 4)
    out["dem"] = a.dem
    out["ref"] = a.ref
    print(json.dumps(out, indent=2))
    if a.out:
        with open(a.out, "w") as f:
            json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()

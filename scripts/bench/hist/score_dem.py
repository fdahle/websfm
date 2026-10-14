"""Score a DEM GeoTIFF against a reference DEM, the way the Grenoble historical-image
benchmark evaluation did it (historic_sfm ▸ dem_diff.json): the test DEM is resampled
bilinearly onto the reference grid over their overlap, and dem - ref is summarised over
every cell valid in both.

    python score_dem.py <dem.tif> <reference.tif> [--out stats.json] [--diff diff.tif]
                        [--mask stable.tif]   cells where mask == 1 only (e.g. stable terrain)

Prints and writes: mean, median, std, rmse, nmad (1.4826 * MAD), count, plus the share
of the test DEM's bounding box that is valid (coverage) and of the reference cells it
covers. Run with the hist_env3 interpreter (rasterio + numpy).
"""
import argparse
import json
import sys

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import from_bounds


def stats(d):
    d = d[np.isfinite(d)]
    if d.size == 0:
        return {"count": 0}
    med = float(np.median(d))
    return {
        "mean_diff": float(d.mean()),
        "median_diff": med,
        "std_diff": float(d.std()),
        "rmse_diff": float(np.sqrt(np.mean(d * d))),
        "nmad_diff": float(1.4826 * np.median(np.abs(d - med))),
        "p90_abs_diff": float(np.percentile(np.abs(d), 90)),
        "count": int(d.size),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dem")
    ap.add_argument("ref")
    ap.add_argument("--out")
    ap.add_argument("--diff")
    ap.add_argument("--mask")
    a = ap.parse_args()

    with rasterio.open(a.dem) as src, rasterio.open(a.ref) as ref:
        ref_crs = ref.crs if ref.crs is not None else src.crs
        b = transform_bounds(src.crs, ref_crs, *src.bounds) if src.crs and ref_crs and src.crs != ref_crs else src.bounds
        # Overlap window on the reference grid.
        left, bottom = max(b[0], ref.bounds.left), max(b[1], ref.bounds.bottom)
        right, top = min(b[2], ref.bounds.right), min(b[3], ref.bounds.top)
        if right <= left or top <= bottom:
            sys.exit("no overlap between DEM and reference")
        win = from_bounds(left, bottom, right, top, ref.transform).round_offsets().round_lengths()
        r = ref.read(1, window=win, masked=True).astype(np.float32)
        rt = ref.window_transform(win)
        r = np.where(np.ma.getmaskarray(r), np.nan, r.data)
        if ref.nodata is not None:
            r[r == ref.nodata] = np.nan

        t = np.full(r.shape, np.nan, np.float32)
        s = src.read(1).astype(np.float32)
        if src.nodata is not None:
            s[s == src.nodata] = np.nan
        valid_box = float(np.isfinite(s).mean())
        reproject(s, t, src_transform=src.transform, src_crs=src.crs or ref_crs, src_nodata=np.nan,
                  dst_transform=rt, dst_crs=ref_crs, dst_nodata=np.nan, resampling=Resampling.bilinear)

    d = t - r
    if a.mask:
        with rasterio.open(a.mask) as m:
            mm = np.zeros(r.shape, np.float32)
            reproject(m.read(1).astype(np.float32), mm, src_transform=m.transform, src_crs=m.crs or ref_crs,
                      dst_transform=rt, dst_crs=ref_crs, resampling=Resampling.nearest)
            d[mm != 1] = np.nan
    out = stats(d)
    out["dem_valid_share_of_bbox"] = round(valid_box, 4)
    out["dem"] = a.dem
    out["ref"] = a.ref
    print(json.dumps(out, indent=2))
    if a.out:
        with open(a.out, "w") as f:
            json.dump(out, f, indent=2)
    if a.diff:
        prof = {"driver": "GTiff", "height": d.shape[0], "width": d.shape[1], "count": 1, "dtype": "float32",
                "crs": ref_crs, "transform": rt, "nodata": np.nan, "compress": "deflate", "tiled": True,
                "BIGTIFF": "IF_SAFER"}
        with rasterio.open(a.diff, "w", **prof) as o:
            o.write(d, 1)


if __name__ == "__main__":
    main()

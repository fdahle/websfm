"""Score a TMA glacier DEM the way the hist_sfm2 paper does, beside the paper's own.

    python tma_score.py --glacier "Rachel Glacier" --dem websfm.dem.tif [--support websfm.support.tif]
                        --metashape dem.tif --rema rema-2m.vrt --rock rock_mask_ap.shp
                        --outlines glaciers.shp --reference North_and_Barrows_DEM.tif [--json out.json]

Everything is resampled (cell averages) onto one 20 m grid in EPSG:3031 over the
websfm DEM's extent. Stable terrain is the rock mask eroded by 60 m with a REMA slope
below 45°. The paper's spatial holdout splits it: 3 km blocks, group (3 bx + 2 by)
mod 5, group 0 withheld. Each statistic is computed for websfm and Metashape on the
same cells (both DEMs valid), so the two are compared like for like:

  rock vs REMA       withheld rock (full extent, outline + 5 km, outline) and all rock
  vs North–Barrows   inside the outline, ice included
  by support         websfm's measured vs interpolated cells (the support layer)

Needs rasterio, geopandas, scipy (the hist_env3 env); run with -I.
"""

import argparse
import json
import os

import pyproj

os.environ.setdefault("PROJ_DATA", pyproj.datadir.get_data_dir())

import geopandas as gpd  # noqa: E402
import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.enums import Resampling  # noqa: E402
from rasterio.features import rasterize  # noqa: E402
from rasterio.transform import from_origin  # noqa: E402
from rasterio.warp import reproject  # noqa: E402
from scipy.ndimage import binary_erosion  # noqa: E402

CELL = 20.0
CRS = "EPSG:3031"


def grid_for(path):
    with rasterio.open(path) as r:
        b = r.bounds
    x0, y1 = np.floor(b.left / CELL) * CELL, np.ceil(b.top / CELL) * CELL
    w = int(np.ceil((b.right - x0) / CELL))
    h = int(np.ceil((y1 - b.bottom) / CELL))
    return from_origin(x0, y1, CELL, CELL), (h, w)


def on_grid(path, transform, shape, resampling=Resampling.average):
    out = np.full(shape, np.nan, dtype="float32")
    with rasterio.open(path) as r:
        src_nodata = r.nodata
        reproject(
            rasterio.band(r, 1),
            out,
            src_nodata=src_nodata,
            dst_transform=transform,
            dst_crs=CRS,
            dst_nodata=np.nan,
            resampling=resampling,
        )
    return out


def stats(d):
    d = d[np.isfinite(d)]
    if d.size == 0:
        return None
    med = float(np.median(d))
    return {
        "n": int(d.size),
        "median": round(med, 2),
        "nmad": round(float(1.4826 * np.median(np.abs(d - med))), 2),
        "rmse": round(float(np.sqrt(np.mean(d**2))), 2),
    }


def main():
    ap = argparse.ArgumentParser()
    for k in ["glacier", "dem", "metashape", "rema", "rock", "outlines", "reference"]:
        ap.add_argument(f"--{k}", required=True)
    ap.add_argument("--support")
    ap.add_argument("--json")
    a = ap.parse_args()

    transform, shape = grid_for(a.dem)
    ours = on_grid(a.dem, transform, shape)
    theirs = on_grid(a.metashape, transform, shape)
    rema = on_grid(a.rema, transform, shape)
    nb = on_grid(a.reference, transform, shape)
    support = on_grid(a.support, transform, shape) if a.support else None
    if support is not None:
        support[support > 100] = np.nan  # nodata 255 averaged in at the edges

    rows, cols = np.indices(shape)
    xs = transform.c + (cols + 0.5) * CELL
    ys = transform.f - (rows + 0.5) * CELL

    outlines = gpd.read_file(a.outlines).to_crs(CRS)
    outline = outlines[outlines.glac_name == a.glacier].union_all()
    rock = gpd.read_file(a.rock, bbox=tuple(rasterio.transform.array_bounds(*shape, transform)[i] for i in (0, 1, 2, 3)))
    raster = lambda geoms: rasterize([(g, 1) for g in geoms], out_shape=shape, transform=transform, fill=0).astype(bool)  # noqa: E731
    in_outline = raster([outline])
    in_buffer = raster([outline.buffer(5000)])
    rock_cells = binary_erosion(raster(rock.to_crs(CRS).geometry), iterations=3)  # 60 m
    gy, gx = np.gradient(rema, CELL)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    stable = rock_cells & (slope < 45)
    withheld = ((3 * np.floor(xs / 3000) + 2 * np.floor(ys / 3000)) % 5) == 0

    both = np.isfinite(ours) & np.isfinite(theirs)
    out = {"glacier": a.glacier, "grid": {"cell_m": CELL, "shape": shape}}
    out["coverage"] = {
        "outline_cells": int(in_outline.sum()),
        "websfm_valid_pct": round(100 * float((np.isfinite(ours) & in_outline).sum() / in_outline.sum()), 1),
        "metashape_valid_pct": round(100 * float((np.isfinite(theirs) & in_outline).sum() / in_outline.sum()), 1),
    }
    if support is not None:
        out["coverage"]["websfm_direct_support_pct"] = round(
            100 * float(((support >= 50) & in_outline).sum() / in_outline.sum()), 1
        )

    def pair(sel):
        sel = sel & both
        return {"websfm": stats(ours[sel] - rema[sel]), "metashape": stats(theirs[sel] - rema[sel])}

    out["rock_vs_rema"] = {
        "withheld_full": pair(stable & withheld),
        "withheld_outline_5km": pair(stable & withheld & in_buffer),
        "withheld_outline": pair(stable & withheld & in_outline),
        "all_rock_outline_5km": pair(stable & in_buffer),
    }
    sel = in_outline & both & np.isfinite(nb)
    out["vs_north_barrows_outline"] = {"websfm": stats(ours[sel] - nb[sel]), "metashape": stats(theirs[sel] - nb[sel])}
    out["websfm_vs_metashape_outline"] = stats(ours[in_outline & both] - theirs[in_outline & both])
    if support is not None:
        direct, interp = support >= 50, support < 50
        out["websfm_by_support"] = {
            "rock_vs_rema_outline_5km": {
                "direct": stats((ours - rema)[stable & in_buffer & direct]),
                "interpolated": stats((ours - rema)[stable & in_buffer & interp]),
            },
            "vs_north_barrows_outline": {
                "direct": stats((ours - nb)[in_outline & direct]),
                "interpolated": stats((ours - nb)[in_outline & interp]),
            },
        }
    text = json.dumps(out, indent=1)
    print(text)
    if a.json:
        open(a.json, "w").write(text)


if __name__ == "__main__":
    main()

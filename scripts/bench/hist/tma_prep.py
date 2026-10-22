"""A TMA glacier block from hist_sfm2 as a bench dataset (bench config `hist`).

    python tma_prep.py <hist_sfm2 images.csv> <out dir> [--derived-masks <dir>]
                       [--cameras <camera-extrinsics.csv>]

Writes, without copying any scan:

  images/           a symlink per scan, named <image_id>.tif
  masks/            a symlink per scan to its mask, under the image's own name: the
                    derived mask (scan mask + horizon cut on the obliques) when
                    --derived-masks has one, else the scan's own mask
  fiducials.csv     the 4 corner + 4 midside marks per scan, in the column layout of
                    detected_fiducial_markers.csv (hist.fiducials.csv)
  footprints.geojson  the approximate footprints (EPSG:3031), property `image`
  sensors.csv       image, role (L/V/R from the camera digits 31/32/33), focal (mm)
  cameras.csv       with --cameras: the Metashape run's camera centres (EPSG:3031)

Run with any Python 3 (standard library only).
"""

import argparse
import csv
import json
import os
import re
from pathlib import Path

ROLE = {"31": "L", "32": "V", "33": "R"}
SLOTS = {
    "corner_top_left": "c_tl",
    "corner_top_right": "c_tr",
    "corner_bottom_right": "c_br",
    "corner_bottom_left": "c_bl",
    "midside_top": "m_t",
    "midside_right": "m_r",
    "midside_bottom": "m_b",
    "midside_left": "m_l",
}


def link(src, dst):
    if dst.is_symlink() or dst.exists():
        dst.unlink()
    dst.symlink_to(src)


def wkt_polygon(wkt):
    nums = re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", wkt)
    pts = [[float(nums[i]), float(nums[i + 1])] for i in range(0, len(nums) - 1, 2)]
    return [pts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images_csv")
    ap.add_argument("out")
    ap.add_argument("--derived-masks")
    ap.add_argument("--cameras")
    a = ap.parse_args()

    out = Path(a.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "masks").mkdir(exist_ok=True)
    rows = list(csv.DictReader(open(a.images_csv)))
    derived = Path(a.derived_masks) if a.derived_masks else None

    fid_rows, features, sensors = [], [], []
    n_derived = 0
    for r in rows:
        name = f"{r['image_id']}.tif"
        link(Path(r["image_path"]), out / "images" / name)
        mask = derived / name if derived and (derived / name).exists() else Path(r["mask_path"])
        n_derived += mask.parent == derived
        link(mask, out / "masks" / name)
        fid = {"image_id": name}
        for col, src in SLOTS.items():
            fid[f"{col}_x"] = r[f"{src}_x"]
            fid[f"{col}_y"] = r[f"{src}_y"]
        fid_rows.append(fid)
        if r.get("footprint_wkt"):
            features.append(
                {
                    "type": "Feature",
                    "properties": {"image": name},
                    "geometry": {"type": "Polygon", "coordinates": wkt_polygon(r["footprint_wkt"])},
                }
            )
        sensors.append({"image": name, "role": ROLE.get(r["image_id"][6:8], "?"), "focal_mm": r["focal_length_mm"]})

    with open(out / "fiducials.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(fid_rows[0]))
        w.writeheader()
        w.writerows(fid_rows)
    with open(out / "footprints.geojson", "w") as f:
        json.dump(
            {
                "type": "FeatureCollection",
                "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3031"}},
                "features": features,
            },
            f,
        )
    with open(out / "sensors.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["image", "role", "focal_mm"])
        w.writeheader()
        w.writerows(sensors)
    if a.cameras:
        with open(a.cameras) as src, open(out / "cameras.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["image", "x", "y", "z"])
            for r in csv.DictReader(src):
                w.writerow([f"{r['image_id']}.tif", r["x"], r["y"], r["z"]])
    print(
        f"{len(rows)} scans → {out}: {n_derived} derived masks, {len(rows) - n_derived} scan masks, "
        f"{len(features)} footprints"
    )


if __name__ == "__main__":
    main()

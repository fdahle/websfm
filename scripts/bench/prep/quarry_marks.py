"""Checkpoint inputs for the Pix4D quarry (347 S.O.D.A. images, nine surveyed targets that
come with no image marks): the GCPs in ETRS89, their image marks, and the RTK camera
table, so WebSfM and Metashape are scored on the same checkpoints (docs/BENCHMARKS.md).

    python quarry_marks.py --data <quarry-full> --aligned <aligned quarry .psx> \
        --grids <dir with the swisstopo grids> --out <dir>

1. GCPs: inputs/gcpPositionsXYZ_EPSG21781.csv is CH1903/LV03 with LN02 heights. They go
   to ETRS89 latitude, longitude and ellipsoidal height through swisstopo's own grids,
   ch_swisstopo_CHENyx06_ETRS.tif and ch_swisstopo_chgeo2004_ETRS89_LN02.tif (cdn.proj.org,
   CC BY 4.0, swisstopo). The p4d's lat/lng come from an approximate datum shift and are
   0.35 m west, 0.56 m south of these: don't use them.
2. Marks: each GCP is projected through an aligned quarry project (any Metashape alignment
   of these photos; only used to find the target, never to place the mark). Each target is
   a yellow disc about 6 px across. The mark is its brightness centroid (mean-shift, so an
   off-centre first peak doesn't cut the disc), pixel-edge convention (pixel i covers
   [i, i+1), Metashape's and the bench's). Where brightness is ambiguous (pale discs on
   pale ground), yellowness finds the disc and brightness still gives the centre: lateral
   chromatic aberration puts the yellowness peak on one rim. Marks are triangulated and
   the worst dropped until every one is within 2 px of its point. 2026-11-10: 225 marks on
   9 targets (4 to 59 each), median residual 0.22 to 0.42 px; checked by eye.
3. Cameras: EXIF GPS (ellipsoidal heights: the p4d's are 49.97 m lower, the geoid here)
   with the per-photo RTK accuracy from XMP Camera:GPSXYAccuracy / GPSZAccuracy, as a
   reference.mjs camera table (sigmaColumns [4, 5, 6]). The EXIF frame agrees with the
   ETRS89 GCPs to 2 cm horizontally (mean of the triangulated targets).

Writes <out>/quarry_gcps_etrs89.txt, <out>/marks.psx (+ .files: the bench's
`reference.metashape`, metashape_checkpoints.py --marks), <out>/marks.json and
<out>/cameras_exif_rtk.txt. Needs hist_env3 (Metashape, pyproj, scipy, PIL) and exiftool;
QT_QPA_PLATFORM=offscreen.
"""
import argparse
import json
import math
import re
import subprocess
from pathlib import Path

import Metashape
import numpy as np
from PIL import Image
from scipy import ndimage

R = 36  # search half-size around the projected point, px
MAXRES = 2.0  # px: a mark further from its triangulated point is dropped


def gcps_etrs89(data, grids):
    from pyproj import Transformer, datadir

    datadir.append_data_dir(str(Path(grids).resolve()))

    t = Transformer.from_pipeline(
        "+proj=pipeline "
        "+step +inv +proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 "
        "+x_0=600000 +y_0=200000 +ellps=bessel "
        "+step +proj=hgridshift +grids=ch_swisstopo_CHENyx06_ETRS.tif "
        "+step +proj=vgridshift +grids=ch_swisstopo_chgeo2004_ETRS89_LN02.tif +multiplier=1 "
        "+step +proj=unitconvert +xy_in=rad +xy_out=deg"
    )
    out = []
    for line in (Path(data) / "inputs/gcpPositionsXYZ_EPSG21781.csv").read_text().splitlines():
        if not line.strip():
            continue
        label, x, y, z = line.split(",")
        lon, lat, h = t.transform(float(x), float(y), float(z))
        if not all(map(math.isfinite, (lon, lat, h))):
            raise SystemExit(f"GCP {label}: the grids were not found in {grids}")
        out.append((label, lat, lon, h))
    return out


def blob1(im, x, y, start=None):
    """Brightest disc in a crop: (x, y, peak, second peak) in image px, or None."""
    sm = ndimage.gaussian_filter(im, 1.2)
    bg = ndimage.median_filter(im, size=15)
    resp = sm - bg
    if start is None:
        iy, ix = np.unravel_index(np.argmax(resp), resp.shape)
    else:
        sx, sy = int(round(start[0])), int(round(start[1]))
        if not (3 <= sx < resp.shape[1] - 3 and 3 <= sy < resp.shape[0] - 3):
            return None
        sub = resp[sy - 3 : sy + 4, sx - 3 : sx + 4]
        jy, jx = np.unravel_index(np.argmax(sub), sub.shape)
        iy, ix = sy - 3 + jy, sx - 3 + jx
    peak = resp[iy, ix]
    r2 = resp.copy()
    r2[max(0, iy - 6) : iy + 7, max(0, ix - 6) : ix + 7] = -1e9
    second = max(r2.max(), 1e-6)
    cx, cy = ix + 0.0, iy + 0.0
    gy, gx = np.mgrid[0 : resp.shape[0], 0 : resp.shape[1]]
    for _ in range(10):  # mean-shift: re-centre a radius-6 window until it settles
        w = np.where((gx - cx) ** 2 + (gy - cy) ** 2 <= 36, np.clip(resp - 0.5 * peak, 0, None), 0)
        if w.sum() <= 0:
            return None
        nx, ny = (w * gx).sum() / w.sum(), (w * gy).sum() / w.sum()
        if abs(nx - cx) < 0.01 and abs(ny - cy) < 0.01:
            break
        cx, cy = nx, ny
    return (int(x) - R + cx + 0.5, int(y) - R + cy + 0.5, float(peak), float(second))


def find_mark(path, x, y):
    rgb = np.asarray(Image.open(path).crop((int(x) - R, int(y) - R, int(x) + R, int(y) + R)), dtype=float)
    lum = rgb @ [0.299, 0.587, 0.114]
    yel = (rgb[..., 0] + rgb[..., 1]) / 2 - rgb[..., 2]
    r = blob1(lum, x, y)
    if r and r[2] > 25 and r[2] > 1.6 * r[3]:
        return r + ("lum",)
    r = blob1(yel, x, y)
    if not (r and r[2] > 12 and r[2] > 1.6 * r[3]):
        return None
    q = blob1(lum, x, y, start=(r[0] - (int(x) - R) - 0.5, r[1] - (int(y) - R) - 0.5))
    if q and q[2] > 6 and abs(q[0] - r[0]) < 4 and abs(q[1] - r[1]) < 4:
        return (q[0], q[1], r[2], r[3], "yel")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="the quarry-full folder")
    ap.add_argument("--aligned", required=True, help="an aligned Metashape project of the 347 photos")
    ap.add_argument("--grids", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    img = Path(a.data) / "images/images"

    gcps = gcps_etrs89(a.data, a.grids)
    (out / "quarry_gcps_etrs89.txt").write_text(
        "# label lat lon ellipsoidal-height (ETRS89), from EPSG:21781 + LN02 via swisstopo CHENyx06 + CHGeo2004\n"
        + "".join(f"{l}\t{la:.9f}\t{lo:.9f}\t{h:.3f}\n" for l, la, lo, h in gcps)
    )

    doc = Metashape.Document()
    doc.open(a.aligned, read_only=True)
    c = doc.chunk
    T = c.transform.matrix
    marks = {}
    for label, lat, lon, h in gcps:
        v = T.inv().mulp(c.crs.unproject(Metashape.Vector([lon, lat, h])))
        m = c.addMarker()
        found = {}
        for cam in c.cameras:
            if not cam.transform or cam.transform.inv().mulp(v).z <= 0:
                continue
            p = cam.project(v)
            if p is None or not (R + 2 < p.x < cam.sensor.width - R - 2 and R + 2 < p.y < cam.sensor.height - R - 2):
                continue
            b = find_mark(img / f"{cam.label}.JPG", p.x, p.y)
            if b:
                found[cam.label] = (cam, b)
                m.projections[cam] = Metashape.Marker.Projection(Metashape.Vector([b[0], b[1]]), True)
        res = {}
        while m.position is not None:
            res = {}
            for lab, (cam, b) in found.items():
                if cam in m.projections.keys():
                    q = cam.project(m.position)
                    res[lab] = math.hypot(q.x - b[0], q.y - b[1])
            worst = max(res, key=res.get, default=None)
            if worst is None or res[worst] <= MAXRES:
                break
            m.projections[found[worst][0]] = None
        marks[label] = {lab: [b[0], b[1], round(res[lab], 2), b[4]] for lab, (cam, b) in found.items() if lab in res}
        med = np.median([v[2] for v in marks[label].values()]) if marks[label] else float("nan")
        print(f"GCP {label}: {len(marks[label])} marks of {len(found)} found, median residual {med:.2f} px", flush=True)
    json.dump(marks, open(out / "marks.json", "w"), indent=1)

    mdoc = Metashape.Document()
    mdoc.save(str(out / "marks.psx"))
    mc = mdoc.addChunk()
    mc.addPhotos(sorted(str(p) for p in img.iterdir() if p.suffix.lower() == ".jpg"))
    mc.crs = mc.marker_crs = Metashape.CoordinateSystem("EPSG::4326")
    cams = {x.label: x for x in mc.cameras}
    for label, lat, lon, h in gcps:
        m = mc.addMarker()
        m.label = label
        m.reference.location = Metashape.Vector([lon, lat, h])
        m.reference.accuracy = Metashape.Vector([0.02, 0.02, 0.02])
        for lab, (x, y, _, _) in marks[label].items():
            m.projections[cams[lab]] = Metashape.Marker.Projection(Metashape.Vector([x, y]), True)
    mdoc.save()

    tags = ["-FileName", "-GPSLatitude", "-GPSLongitude", "-GPSAltitude"]
    tags += ["-XMP-Camera:GPSXYAccuracy", "-XMP-Camera:GPSXYAccuracy", "-XMP-Camera:GPSZAccuracy"]
    rows = subprocess.run(["exiftool", "-n", "-T", *tags, str(img)], capture_output=True, text=True, check=True).stdout
    rows = "\n".join(sorted(r for r in rows.splitlines() if re.search(r"\.jpg\t", r, re.I)))
    (out / "cameras_exif_rtk.txt").write_text(
        "# file lat lon h(ellipsoidal) sn se su: EXIF GPS + XMP Camera:GPSXY/ZAccuracy (S.O.D.A. RTK)\n" + rows + "\n"
    )


if __name__ == "__main__":
    main()

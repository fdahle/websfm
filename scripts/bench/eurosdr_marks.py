"""Checkpoint inputs for the EuroSDR RPAS benchmark (Wards Hill Quarry, Newcastle University;
Zenodo 10.5281/zenodo.10059050, CC BY 4.0): image marks for its 59 surveyed points and the
RTK camera table, so WebSfM and Metashape are scored on the same checkpoints
(docs/BENCHMARKS.md). The set ships coordinates only, no marks.

    python eurosdr_marks.py --images <flat folder of the block's JPGs> \
        --points <eurosdr_points_etrs89.txt> --out <dir> [--aligned <aligned .psx>]

1. Points: label, latitude, longitude, ellipsoidal height in ETRS89, one per line (made
   from GCPsandCPs_coords.xlsx, whose names sit one row above their coordinates: see the
   file's header). G* are the set's GCPs, the rest its checkpoints; here all are scored as
   checkpoints (the solve uses RTK camera positions only).
2. Alignment: without --aligned, the block is aligned once in Metashape with the EXIF RTK
   positions (<out>/aligned.psx). It is only used to find each target, never to place a mark.
3. Marks: the targets are discs about 20 px across at 55 m (yellow on the GCPs, white on the
   checkpoints) with a dark centre dot. Each point is projected into every photo; in a
   window around it the disc is the brightest round blob, and the mark is the darkness-
   weighted centroid of the dot inside it (the disc's own centroid when no dot shows),
   pixel-edge convention (pixel i covers [i, i+1), Metashape's and the bench's). Marks are
   triangulated and the worst dropped until every one is within 2 px of its point; a point
   with fewer than 3 marks is left out. A point whose target is not a disc (GF8 in the
   sheet is a painted triangle beside the road) gets no marks.
4. Cameras: EXIF GPS (ellipsoidal heights, RTK fixed: XMP drone-dji:RtkFlag 50) with the
   per-photo accuracy from XMP RtkStdLat / RtkStdLon / RtkStdHgt, as a reference.mjs
   camera table (sigmaColumns [4, 5, 6]).

Writes <out>/marks.psx (+ .files: the bench's `reference.metashape`,
metashape_checkpoints.py --marks), <out>/marks.json, <out>/cameras_exif_rtk.txt and
<out>/marks-sheet.png (a crop of every point in up to four photos, the mark drawn: check by
eye). Needs hist_env3 (Metashape, scipy, PIL) and exiftool; QT_QPA_PLATFORM=offscreen.
"""

import argparse
import json
import math
import subprocess
from pathlib import Path

import Metashape
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

R = 40  # search half-size around the projected point, px
MAXRES = 2.0  # px: a mark further from its triangulated point is dropped
MINMARKS = 3


def read_points(path):
    out = []
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        label, lat, lon, h = line.split()
        out.append((label, float(lat), float(lon), float(h)))
    return out


def align(images, out):
    doc = Metashape.Document()
    doc.save(str(out / "aligned.psx"))
    c = doc.addChunk()
    c.addPhotos(images)
    c.crs = Metashape.CoordinateSystem("EPSG::4326")
    c.camera_location_accuracy = Metashape.Vector([0.03, 0.03, 0.05])
    c.matchPhotos(downscale=1, generic_preselection=True, reference_preselection=True,
                  keypoint_limit=40000, tiepoint_limit=4000)
    c.alignCameras()
    c.optimizeCameras()
    doc.save()
    n = sum(1 for x in c.cameras if x.transform)
    print(f"aligned {n}/{len(c.cameras)} photos", flush=True)
    return str(out / "aligned.psx")


def find_mark(path, x, y):
    """The disc's centre dot near (x, y): (x, y, contrast, kind) in image px, or None."""
    x0, y0 = int(x) - R, int(y) - R
    rgb = np.asarray(Image.open(path).crop((x0, y0, x0 + 2 * R, y0 + 2 * R)), dtype=float)
    lum = rgb @ [0.299, 0.587, 0.114]
    sm = ndimage.gaussian_filter(lum, 1.0)
    resp = sm - ndimage.median_filter(sm, size=31)
    peak = resp.max()
    if peak < 30:
        return None
    lab, n = ndimage.label(resp > 0.5 * peak)
    best = None
    for i in range(1, n + 1):
        blob = lab == i
        disc = ndimage.binary_fill_holes(ndimage.binary_closing(blob, iterations=2)) | blob
        area = disc.sum()
        if not (60 <= area <= 1500):
            continue
        ys, xs = np.nonzero(disc)
        r = math.sqrt(area / math.pi)
        # Round: the blob fills most of its bounding circle, and is not a line or a sign.
        fill = area / (math.pi * (max(np.ptp(xs), np.ptp(ys)) / 2 + 0.5) ** 2)
        if fill < 0.6:
            continue
        score = resp[blob].mean()
        if best is None or score > best[0]:
            best = (score, blob, disc, r)
    if best is None:
        return None
    score, blob, disc, r = best
    hole = disc & ~blob
    gy, gx = np.mgrid[0 : 2 * R, 0 : 2 * R]
    cx, cy = gx[disc].mean(), gy[disc].mean()
    kind = "disc"
    if hole.sum() >= 3:
        w = np.where(hole, np.clip(sm[blob].mean() - sm, 0, None), 0)
        if w.sum() > 0:
            hx, hy = (w * gx).sum() / w.sum(), (w * gy).sum() / w.sum()
            if math.hypot(hx - cx, hy - cy) < 0.5 * r:
                cx, cy, kind = hx, hy, "dot"
    return (x0 + cx + 0.5, y0 + cy + 0.5, float(score), kind)


def sheet(images_by_label, points, marks, path):
    tiles = []
    for label, *_ in points:
        ms = sorted(marks.get(label, {}).items(), key=lambda kv: kv[1][2])[:4]
        row = []
        for cam, (x, y, res, kind) in ms:
            im = Image.open(images_by_label[cam]).crop((int(x) - 30, int(y) - 30, int(x) + 30, int(y) + 30))
            im = im.resize((120, 120), Image.NEAREST)
            d = ImageDraw.Draw(im)
            px, py = (x - (int(x) - 30)) * 2, (y - (int(y) - 30)) * 2
            d.line((px - 8, py, px + 8, py), fill=(255, 0, 255))
            d.line((px, py - 8, px, py + 8), fill=(255, 0, 255))
            row.append(im)
        tiles.append((label, row))
    W, H = 80 + 4 * 124, 124 * len(tiles)
    out = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(out)
    for i, (label, row) in enumerate(tiles):
        d.text((4, i * 124 + 54), f"{label} ({len(marks.get(label, {}))})", fill="black")
        for j, im in enumerate(row):
            out.paste(im, (80 + j * 124, i * 124))
    out.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--points", required=True)
    ap.add_argument("--aligned", help="an aligned Metashape project of these photos (else one is made)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    images = sorted(str(p) for p in Path(a.images).iterdir() if p.suffix.lower() == ".jpg")
    by_label = {Path(p).stem: p for p in images}
    points = read_points(a.points)
    aligned = a.aligned or align(images, out)

    doc = Metashape.Document()
    doc.open(aligned, read_only=True)
    c = doc.chunk
    T = c.transform.matrix
    marks = {}
    for label, lat, lon, h in points:
        v = T.inv().mulp(c.crs.unproject(Metashape.Vector([lon, lat, h])))
        m = c.addMarker()
        found = {}
        for cam in c.cameras:
            if not cam.transform or cam.transform.inv().mulp(v).z <= 0:
                continue
            p = cam.project(v)
            if p is None or not (R + 2 < p.x < cam.sensor.width - R - 2 and R + 2 < p.y < cam.sensor.height - R - 2):
                continue
            b = find_mark(by_label[cam.label], p.x, p.y)
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
        kept = {lab: [b[0], b[1], round(res[lab], 2), b[3]] for lab, (cam, b) in found.items() if lab in res}
        if len(kept) < MINMARKS:
            kept = {}
        marks[label] = kept
        med = np.median([v[2] for v in kept.values()]) if kept else float("nan")
        print(f"{label}: {len(kept)} marks of {len(found)} found, median residual {med:.2f} px", flush=True)
    json.dump(marks, open(out / "marks.json", "w"), indent=1)
    sheet(by_label, points, marks, out / "marks-sheet.png")

    mdoc = Metashape.Document()
    mdoc.save(str(out / "marks.psx"))
    mc = mdoc.addChunk()
    mc.addPhotos(images)
    mc.crs = mc.marker_crs = Metashape.CoordinateSystem("EPSG::4326")
    cams = {x.label: x for x in mc.cameras}
    for label, lat, lon, h in points:
        if not marks[label]:
            continue
        m = mc.addMarker()
        m.label = label
        m.reference.location = Metashape.Vector([lon, lat, h])
        m.reference.accuracy = Metashape.Vector([0.01, 0.01, 0.01])
        for lab, (x, y, _, _) in marks[label].items():
            m.projections[cams[lab]] = Metashape.Marker.Projection(Metashape.Vector([x, y]), True)
    mdoc.save()

    tags = ["-FileName", "-GPSLatitude", "-GPSLongitude", "-GPSAltitude"]
    tags += ["-XMP-drone-dji:RtkStdLat", "-XMP-drone-dji:RtkStdLon", "-XMP-drone-dji:RtkStdHgt", "-XMP-drone-dji:RtkFlag"]
    rows = subprocess.run(["exiftool", "-n", "-T", *tags, a.images], capture_output=True, text=True, check=True).stdout
    rows = sorted(r.split("\t") for r in rows.splitlines() if r.lower().split("\t")[0].endswith(".jpg"))
    notfixed = [r[0] for r in rows if r[7].strip() != "50"]
    print(f"cameras: {len(rows)} photos, {len(rows) - len(notfixed)} RTK fixed" + (f"; not fixed: {notfixed}" if notfixed else ""))
    (out / "cameras_exif_rtk.txt").write_text(
        "# file lat lon h(ellipsoidal) sn se su: EXIF GPS + XMP drone-dji:RtkStdLat/Lon/Hgt (P4 RTK, RtkFlag 50)\n"
        + "".join("\t".join(r[:7]) + "\n" for r in rows)
    )


if __name__ == "__main__":
    main()

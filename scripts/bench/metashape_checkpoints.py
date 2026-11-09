"""Metashape's checkpoint error on a finished alignment: the GCPs as check points, from the
same image marks the WebSfM bench uses (docs/BENCHMARKS.md ▸ positions in the solve).

    python metashape_checkpoints.py --project <ws>/project.psx --gcps GCPs_WGS84.txt \
        --marks <Metashape project .files dir> [--exclude 19 ...] [--out checkpoints.json]

The project is the one metashape_full.py or metashape_align.py made (cameras aligned with
their references in the solve). Each GCP becomes a marker with the marks of the given
Metashape project (`--marks`: GeoScan's own Project_aerial_GCPs.files), its reference
disabled, so it does not move the solve: Metashape triangulates it from its marks, and
the error is that position against the surveyed one, in metres east / north / up. The
project is opened read-only and not saved.

--gcps: a table `label lat lon ellipsoidal-height` (WGS84), '#' lines skipped, as GeoScan's
GCPs_WGS84.txt. --exclude: labels reported but left out of the RMS (GeoScan's 19, whose
reference was never converted out of its datum; reference.mjs excludeGcps).

Run with an interpreter that has the Metashape module (hist_env3), QT_QPA_PLATFORM=offscreen.
"""
import argparse
import json
import math
import re
import zipfile
from pathlib import Path

import Metashape


def zip_entry(path, entry="doc.xml"):
    with zipfile.ZipFile(path) as z:
        return z.read(entry).decode("utf-8")


def metashape_marks(files_dir):
    """Markers of a Metashape project folder → {label: [(camera label, x, y)]}, as
    scripts/bench/reference.mjs metashapeMarks reads them."""
    d = Path(files_dir)
    chunk = zip_entry(d / "0" / "chunk.zip")
    frame = zip_entry(d / "0" / "0" / "frame.zip")
    cams = dict(re.findall(r'<camera id="(\d+)"[^>]*label="([^"]*)"', chunk))
    labels = dict(re.findall(r'<marker id="(\d+)" label="([^"]*)"', chunk))
    out = {}
    for mid, body in re.findall(r'<marker marker_id="(\d+)">([\s\S]*?)</marker>', frame):
        if mid not in labels:
            continue
        marks = []
        for loc in re.findall(r"<location [^>]*/>", body):
            a = dict(re.findall(r'(\w+)="([^"]*)"', loc))
            if a.get("camera_id") in cams:
                marks.append((cams[a["camera_id"]], float(a["x"]), float(a["y"])))
        out[labels[mid]] = marks
    return out


def read_gcps(path):
    out = []
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        f = line.split()
        try:
            out.append((f[0], float(f[1]), float(f[2]), float(f[3])))
        except (IndexError, ValueError):
            continue
    return out


def stem(label):
    return re.sub(r"\.[^.]+$", "", label).lower()


def rms(values):
    return math.sqrt(sum(v * v for v in values) / len(values)) if values else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--gcps", required=True)
    ap.add_argument("--marks", required=True)
    ap.add_argument("--exclude", nargs="*", default=[])
    ap.add_argument("--out")
    a = ap.parse_args()

    doc = Metashape.Document()
    doc.open(a.project, read_only=True, ignore_lock=True)
    chunk = doc.chunk
    if chunk.transform.matrix is None:
        raise SystemExit("the chunk has no georeference: align it with camera references first")
    cameras = {stem(c.label): c for c in chunk.cameras if c.transform}
    marks = metashape_marks(a.marks)
    wgs84 = Metashape.CoordinateSystem("EPSG::4326")

    rows = []
    for label, lat, lon, h in read_gcps(a.gcps):
        m = chunk.addMarker()
        m.label = f"check {label}"
        used = 0
        for cam_label, x, y in marks.get(label, []):
            cam = cameras.get(stem(cam_label))
            if cam is None:
                continue
            m.projections[cam] = Metashape.Marker.Projection(Metashape.Vector([x, y]), True)
            used += 1
        m.reference.location = Metashape.Vector([lon, lat, h])
        m.reference.enabled = False  # a check point: it does not move the solve
        if m.position is None:
            rows.append({"label": label, "marks": used, "error": None})
            continue
        est = chunk.transform.matrix.mulp(m.position)  # geocentric
        ref = wgs84.unproject(Metashape.Vector([lon, lat, h]))
        e = wgs84.localframe(est).mulv(est - ref)  # east, north, up
        rows.append({"label": label, "marks": used, "error": [round(e.x, 4), round(e.y, 4), round(e.z, 4)]})

    scored = [r for r in rows if r["error"] and r["label"] not in a.exclude]
    summary = {
        "project": a.project,
        "metashape": Metashape.app.version,
        "count": len(scored),
        "excluded": [r["label"] for r in rows if r["label"] in a.exclude],
        "unscored": [r["label"] for r in rows if not r["error"]],
        "rmsH": rms([math.hypot(r["error"][0], r["error"][1]) for r in scored]),
        "rmsV": rms([r["error"][2] for r in scored]),
        "meanV": sum(r["error"][2] for r in scored) / len(scored) if scored else None,
        "gcps": rows,
    }
    text = json.dumps(summary, indent=2)
    if a.out:
        Path(a.out).write_text(text)
    print(text)


if __name__ == "__main__":
    main()

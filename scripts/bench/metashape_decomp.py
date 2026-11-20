"""Metashape on equal terms with WebSfM's bench, and its tie points out (dev/baselines.md ▸
B-decomp, the Metashape decomposition of GeoScan PUTI's accuracy gap).

    python metashape_decomp.py align --images <dir> --cameras Cameras_WGS84.txt \
        --sigma-columns 8 9 10 --lever-arm GNSS_offset.txt --ws <dir> [--downscale 1]
    python metashape_decomp.py export --project <ws>/project.psx --out <dir>
    python metashape_decomp.py inject --run <replay dir> --images <dir> --cameras … \
        --lever-arm … --ws <dir> [--size-scale 1]

inject: a WebSfM replay's final tracks (its tie.* dump and model.json) loaded into a fresh
chunk through the API (TiePoints tracks, points and per-camera projections, which the 2.x
API lets a script set once the chunk owns an empty TiePoints), its cameras and
calibration as the start, the same control as `align`, then Optimize Cameras at its
default terms. Projection size = WebSfM's keypoint scale (full-resolution σ, the same
kind of number as Metashape's key point size) × --size-scale. Writes model-start.json
(before) and model.json (after).

align: Align Photos with the control WebSfM's bench gives its own solve: the RTK camera
positions with their per-camera σ (columns n, e, u of the camera file, zero-based) and the
antenna offset (as GNSS_offset.txt writes it, Metashape's own axes, held fixed), rotations
off, no GCP as control. Matching at Metashape's API defaults (40,000 / 4,000 key / tie
points, generic + reference preselection) at `--downscale` (1 = High, 2 = Medium), then
alignCameras and optimizeCameras at their default terms (f, cx, cy, k1–k3, p1, p2).
Writes <ws>/project.psx and <ws>/align.json (seconds per stage, counts).

export: from a saved project, for the scorer (metashape-decomp-score.mjs) and the
payload builder (metashape-tiepoints.mjs):
  model.json      calibration (Metashape's convention: cx, cy from the image centre, pixel
                  centres at +½), its σ, the chunk transform, and every aligned camera's
                  4×4 transform in the chunk's internal frame
  tiepoints.bin   valid tie points: header (int32 counts), then per point x y z (f64,
                  internal frame) and track id (int32); per projection camera index,
                  track id (int32), x, y, size (f32), Metashape's pixel convention

Run with an interpreter that has the Metashape module (hist_env3), QT_QPA_PLATFORM=offscreen.
"""
import argparse
import json
import os
import struct
import time
from pathlib import Path

import Metashape

PHOTO_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff")


def read_cameras(path, cols):
    """Camera table: name lat lon h … with σ n, e, u in the given zero-based columns."""
    out = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        f = [v.strip() for v in line.split("\t")]
        stem = os.path.splitext(f[0])[0].lower()
        out[stem] = dict(lat=float(f[1]), lon=float(f[2]), h=float(f[3]), sn=float(f[cols[0]]), se=float(f[cols[1]]), su=float(f[cols[2]]))
    return out


def read_arm(path):
    vals = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line:
            k, v = line.split("=")
            vals[k.strip().lower()] = float(v)
    return [vals["x"], vals["y"], vals["z"]]


def align(a):
    ws = Path(a.ws)
    ws.mkdir(parents=True, exist_ok=True)
    gpus = len(Metashape.app.enumGPUDevices())
    Metashape.app.gpu_mask = (1 << gpus) - 1
    Metashape.app.cpu_enable = True
    doc = Metashape.Document()
    doc.save(str(ws / "project.psx"))
    chunk = doc.addChunk()
    files = sorted(str(Path(a.images) / f) for f in os.listdir(a.images) if f.lower().endswith(PHOTO_EXT))
    seconds = {}

    def stage(name, fn):
        print(f"== {name}", flush=True)
        t0 = time.time()
        fn()
        seconds[name] = round(time.time() - t0, 1)
        print(f"   {seconds[name]} s", flush=True)

    stage("addPhotos", lambda: chunk.addPhotos(files))
    n = set_references(chunk, a)
    arm = read_arm(a.lever_arm)
    print(f"   {n} camera references, antenna {arm}", flush=True)
    stage(
        "matching",
        lambda: chunk.matchPhotos(
            downscale=a.downscale,
            keypoint_limit=40000,
            tiepoint_limit=4000,
            generic_preselection=True,
            reference_preselection=True,
            reference_preselection_mode=Metashape.ReferencePreselectionSource,
        ),
    )
    stage("alignment", lambda: chunk.alignCameras())
    doc.save()
    # The calibration and cameras straight after alignment, before Optimize Cameras.
    export_model(chunk, ws / "model-aligned.json")
    stage("optimize", lambda: chunk.optimizeCameras())
    doc.save()
    summary = {
        "metashape": Metashape.app.version,
        "gpus": gpus,
        "downscale": a.downscale,
        "images": len(chunk.cameras),
        "aligned": sum(1 for c in chunk.cameras if c.transform),
        "tiePoints": len(chunk.tie_points.points),
        "referenced": n,
        "antenna": arm,
        "seconds": seconds,
    }
    json.dump(summary, open(ws / "align.json", "w"), indent=2)
    print(json.dumps(summary), flush=True)


def calib_dict(cal):
    keys = ["f", "cx", "cy", "b1", "b2", "k1", "k2", "k3", "k4", "p1", "p2"]
    return {k: getattr(cal, k) for k in keys} | {"width": cal.width, "height": cal.height}


def export_model(chunk, path):
    s = chunk.sensors[0]
    cov = None
    if s.calibration.covariance_params:
        params = list(s.calibration.covariance_params)
        m = s.calibration.covariance_matrix
        cov = {p: m[i, i] ** 0.5 for i, p in enumerate(params)}
    T = chunk.transform.matrix
    model = {
        "calibration": calib_dict(s.calibration),
        "sigma": cov,
        "antenna": list(s.antenna.location) if s.antenna.location else None,
        "chunkTransform": [T[i, j] for i in range(4) for j in range(4)],
        "cameras": {
            c.label: [c.transform[i, j] for i in range(4) for j in range(4)] for c in chunk.cameras if c.transform
        },
    }
    Path(path).write_text(json.dumps(model))


def export(a):
    doc = Metashape.Document()
    doc.open(a.project, read_only=True, ignore_lock=True)
    chunk = doc.chunk
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    export_model(chunk, out / "model.json")
    cams = [c for c in chunk.cameras if c.transform]
    tp = chunk.tie_points
    pts = [p for p in tp.points if p.valid]
    valid_tracks = {p.track_id for p in pts}
    proj_rows = []
    for ci, c in enumerate(cams):
        for pr in tp.projections[c]:
            if pr.track_id in valid_tracks:
                proj_rows.append((ci, pr.track_id, pr.coord.x, pr.coord.y, pr.size))
    with open(out / "tiepoints.bin", "wb") as f:
        f.write(struct.pack("<3i", len(cams), len(pts), len(proj_rows)))
        for p in pts:
            v = p.coord
            f.write(struct.pack("<3di", v.x / v.w, v.y / v.w, v.z / v.w, p.track_id))
        for r in proj_rows:
            f.write(struct.pack("<2i3f", *r))
    (out / "tiepoints-cameras.json").write_text(json.dumps([c.label for c in cams]))
    print(json.dumps({"cameras": len(cams), "points": len(pts), "projections": len(proj_rows)}))


def set_references(chunk, a):
    chunk.crs = Metashape.CoordinateSystem("EPSG::4326")
    ref = read_cameras(a.cameras, a.sigma_columns)
    n = 0
    for c in chunk.cameras:
        p = ref.get(c.label.lower())
        c.reference.rotation_enabled = False
        if not p:
            c.reference.location_enabled = False
            continue
        c.reference.location = Metashape.Vector([p["lon"], p["lat"], p["h"]])
        c.reference.location_accuracy = Metashape.Vector([p["se"], p["sn"], p["su"]])
        c.reference.location_enabled = True
        n += 1
    arm = read_arm(a.lever_arm)
    for s in chunk.sensors:
        s.antenna.location_ref = Metashape.Vector(arm)
        s.antenna.location_fixed = True
    return n


def inject(a):
    """WebSfM's final tracks into a fresh chunk (M2): its cameras and calibration as the
    start, its observations at their recorded pixels (pixel centres → Metashape's edges,
    +½) with the keypoint size `--size-scale` × WebSfM's scale, then Optimize Cameras with
    the same control as `align`."""
    import numpy as np

    ws = Path(a.ws)
    ws.mkdir(parents=True, exist_ok=True)
    run = Path(a.run)
    model = json.loads((run / "model.json").read_text())
    stems = model["camStems"]
    rd = lambda n, t: np.fromfile(run / n, dtype=t)
    pos = rd("tie.pos.f64", "<f8").reshape(-1, 3)
    vcount = rd("tie.vcount.u32", "<u4")
    vcam = rd("tie.vcam.u32", "<u4")
    kx, ky, ks = rd("tie.kx.f64", "<f8"), rd("tie.ky.f64", "<f8"), rd("tie.ks.f32", "<f4")
    pi = np.repeat(np.arange(len(vcount)), vcount)
    doc = Metashape.Document()
    doc.save(str(ws / "project.psx"))
    chunk = doc.addChunk()
    files = sorted(str(Path(a.images) / f) for f in os.listdir(a.images) if os.path.splitext(f)[0].lower() in model["cameras"])
    chunk.addPhotos(files)
    any_cam = next(iter(model["cameras"].values()))
    K, d = any_cam["K"], any_cam.get("dist") or {}
    if any_cam.get("selfCal"):
        raise SystemExit("a composed self-cal bag: not handled")
    W, H = 6000, 4000
    cal = Metashape.Calibration()
    cal.width, cal.height = W, H
    cal.f = (K["fx"] + K["fy"]) / 2
    cal.cx = K["cx"] + 0.5 - W / 2
    cal.cy = K["cy"] + 0.5 - H / 2
    cal.k1, cal.k2, cal.k3 = d.get("k1", 0), d.get("k2", 0), d.get("k3", 0)
    cal.p1, cal.p2 = d.get("p2", 0), d.get("p1", 0)  # OpenCV order → Metashape's
    s = chunk.sensors[0]
    s.user_calib = cal
    s.fixed = False
    for c in chunk.cameras:
        m = model["cameras"][c.label.lower()]
        R = np.array(m["R"])
        C = -R.T @ np.array(m["t"])
        T = np.eye(4)
        T[:3, :3] = R.T
        T[:3, 3] = C
        c.transform = Metashape.Matrix(T.tolist())
    cam_of = {c.label.lower(): c for c in chunk.cameras}
    tp = Metashape.TiePoints()
    chunk.tie_points = tp
    tp = chunk.tie_points
    tr = tp.tracks.copy()
    tr.resize(len(vcount))
    tp.tracks = tr
    pts = Metashape.TiePoints.Points()
    pts.resize(len(vcount))
    for i in range(len(vcount)):
        pts[i].coord = Metashape.Vector([pos[i, 0], pos[i, 1], pos[i, 2], 1.0])
        pts[i].track_id = i
        pts[i].valid = True
    tp.points = pts
    order = np.argsort(vcam, kind="stable")
    bounds = np.searchsorted(vcam[order], np.arange(len(stems) + 1))
    for ci, st in enumerate(stems):
        idx = order[bounds[ci] : bounds[ci + 1]]
        if st not in cam_of or not len(idx):
            continue
        pr = Metashape.TiePoints.Projections()
        pr.resize(len(idx))
        for j, k in enumerate(idx):
            pr[j].coord = Metashape.Vector([kx[k] + 0.5, ky[k] + 0.5])
            pr[j].size = float(ks[k] * a.size_scale) if ks[k] > 0 else 1.0
            pr[j].track_id = int(pi[k])
        tp.projections[cam_of[st]] = pr
    n = set_references(chunk, a)
    chunk.updateTransform()
    doc.save()
    export_model(chunk, ws / "model-start.json")
    t0 = time.time()
    chunk.optimizeCameras()
    secs = round(time.time() - t0, 1)
    doc.save()
    export_model(chunk, ws / "model.json")
    summary = {"referenced": n, "points": len(vcount), "observations": int(len(vcam)), "optimizeSeconds": secs, "sizeScale": a.size_scale}
    json.dump(summary, open(ws / "inject.json", "w"), indent=2)
    print(json.dumps(summary), flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    ij = sub.add_parser("inject")
    ij.add_argument("--run", required=True)
    ij.add_argument("--images", required=True)
    ij.add_argument("--cameras", required=True)
    ij.add_argument("--sigma-columns", type=int, nargs=3, default=[8, 9, 10])
    ij.add_argument("--lever-arm", required=True)
    ij.add_argument("--ws", required=True)
    ij.add_argument("--size-scale", type=float, default=1.0)
    al = sub.add_parser("align")
    al.add_argument("--images", required=True)
    al.add_argument("--cameras", required=True)
    al.add_argument("--sigma-columns", type=int, nargs=3, default=[8, 9, 10])
    al.add_argument("--lever-arm", required=True)
    al.add_argument("--ws", required=True)
    al.add_argument("--downscale", type=int, default=1)
    ex = sub.add_parser("export")
    ex.add_argument("--project", required=True)
    ex.add_argument("--out", required=True)
    a = ap.parse_args()
    {"align": align, "export": export, "inject": inject}[a.cmd](a)


if __name__ == "__main__":
    main()

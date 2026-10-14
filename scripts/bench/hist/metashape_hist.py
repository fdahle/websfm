"""Plain Metashape reference run for a historical frame set with surveyed GCPs (Grenoble
benchmark layout), with Metashape's own defaults so it sits beside websfm and COLMAP as a
method comparison: High accuracy matching (40k key / 4k tie points, generic
preselection, masks), alignment, GCP markers from gcp.csv as control, optimisation
(f, cx, cy, k1-3, p1, p2), depth maps at High (downscale 2) with mild filtering,
point cloud, DEM from the point cloud, exported in the GCP CRS and scored.

    python metashape_hist.py --images <dir> --mask <mask.tif> --gcps <gcp.csv>
        --intrinsics <camera_model_intrinsics.csv> --ws <dir> --epsg 6341
        [--ref-dem <ref.tif>] [--check-every 4]   every 4th GCP is a checkpoint
        [--downscale-depth 2] [--dem-res 2]

Run with an interpreter that has the Metashape module (hist_env3). Stages that already
ran in the saved project are skipped.
"""
import argparse
import csv
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import Metashape
import numpy as np

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--mask")
    ap.add_argument("--gcps", required=True)
    ap.add_argument("--intrinsics")
    ap.add_argument("--ws", required=True)
    ap.add_argument("--epsg", default="6341")
    ap.add_argument("--ref-dem")
    ap.add_argument("--check-every", type=int, default=4)
    ap.add_argument("--downscale-depth", type=int, default=2)
    ap.add_argument("--dem-res", type=float, default=2.0)
    ap.add_argument("--no-gcps", action="store_true", help="align + a GCP similarity only (no marker optimisation)")
    a = ap.parse_args()

    ws = Path(a.ws)
    ws.mkdir(parents=True, exist_ok=True)
    psx = ws / "project.psx"
    timings = json.load(open(ws / "timings.json")) if (ws / "timings.json").exists() else {}

    def stage(name, fn):
        if name in timings:
            return
        print(f"== {name}", flush=True)
        t0 = time.time()
        fn()
        timings[name] = round(time.time() - t0, 1)
        doc.save()
        json.dump(timings, open(ws / "timings.json", "w"), indent=2)
        print(f"   {timings[name]} s", flush=True)

    doc = Metashape.Document()
    if psx.exists():
        doc.open(str(psx))
        chunk = doc.chunk
    else:
        doc.save(str(psx))
        chunk = doc.addChunk()
    crs = Metashape.CoordinateSystem(f"EPSG::{a.epsg}")

    def add():
        files = sorted(str(Path(a.images) / f) for f in os.listdir(a.images) if f.lower().endswith((".tif", ".tiff", ".jpg")))
        chunk.addPhotos(files)
        chunk.crs = crs
        s = chunk.sensors[0]
        for c in chunk.cameras:
            c.sensor = s
        for extra in chunk.sensors[1:]:
            chunk.remove(extra)
        if a.intrinsics:
            r = next(csv.DictReader(open(a.intrinsics)))
            s.focal_length = float(r["focal_length"])
            s.pixel_width = s.pixel_height = float(r["pixel_pitch"])
        if a.mask:
            png = ws / "mask.png"
            if not png.exists():
                import rasterio
                from PIL import Image
                m = rasterio.open(a.mask).read(1)
                keep = m == m[m.shape[0] // 2, m.shape[1] // 2]  # centre = terrain = the kept class
                Image.fromarray((keep * 255).astype(np.uint8)).save(png)
            chunk.generateMasks(path=str(png), masking_mode=Metashape.MaskingMode.MaskingModeFile,
                                mask_operation=Metashape.MaskOperation.MaskOperationReplacement)
    stage("add", add)

    def align():
        chunk.matchPhotos(downscale=1, generic_preselection=True, reference_preselection=False,
                          keypoint_limit=40000, tiepoint_limit=4000, filter_mask=bool(a.mask))
        chunk.alignCameras()
    stage("align", align)

    rows = list(csv.DictReader(open(a.gcps)))
    labels = sorted({r["gcp_label"] for r in rows})
    checks = set(labels[::a.check_every]) if a.check_every else set()

    def gcps():
        cams = {c.label: c for c in chunk.cameras}
        stems = {Path(c.label).stem: c for c in chunk.cameras}
        by = {}
        for r in rows:
            by.setdefault(r["gcp_label"], []).append(r)
        for label in labels:
            rs = by[label]
            m = chunk.addMarker()
            m.label = label
            for r in rs:
                c = cams.get(r["image_file_name"]) or stems.get(Path(r["image_file_name"]).stem)
                if c is not None:
                    m.projections[c] = Metashape.Marker.Projection(Metashape.Vector([float(r["x"]), float(r["y"])]), True)
            r0 = rs[0]
            m.reference.location = Metashape.Vector([float(r0["x_map"]), float(r0["y_map"]), float(r0["elev"])])
            m.reference.accuracy = Metashape.Vector([float(r0.get("x_map_acc") or 0.5), float(r0.get("y_map_acc") or 0.5),
                                                     float(r0.get("elev_acc") or 0.5)])
            m.reference.enabled = label not in checks
        for c in chunk.cameras:
            c.reference.enabled = False
        chunk.marker_crs = crs
        chunk.crs = crs
        chunk.updateTransform()
        if not a.no_gcps:
            chunk.optimizeCameras(fit_f=True, fit_cx=True, fit_cy=True, fit_k1=True, fit_k2=True, fit_k3=True,
                                  fit_p1=True, fit_p2=True)
    stage("gcps", gcps)

    def marker_errors():
        out = {}
        T = chunk.transform.matrix
        for m in chunk.markers:
            if m.position is None:
                continue
            est = chunk.crs.project(T.mulp(m.position))
            ref = m.reference.location
            d = est - ref
            out[m.label] = {"check": not m.reference.enabled, "dE": d.x, "dN": d.y, "dU": d.z,
                            "projections": len(m.projections)}
        return out

    def depth():
        chunk.buildDepthMaps(downscale=a.downscale_depth, filter_mode=Metashape.FilterMode.MildFiltering)
    stage("depth", depth)
    stage("dense", lambda: chunk.buildPointCloud())

    def dem():
        proj = Metashape.OrthoProjection()
        proj.crs = crs
        chunk.buildDem(source_data=Metashape.DataSource.PointCloudData, projection=proj, resolution=a.dem_res)
        chunk.exportRaster(str(ws / "dem.tif"), source_data=Metashape.DataSource.ElevationData, projection=proj,
                           resolution=a.dem_res, nodata_value=-9999)
    stage("dem", dem)

    me = marker_errors()
    rms = lambda sel, keys: float(np.sqrt(np.mean([sum(v[k] ** 2 for k in keys) for v in sel]))) if sel else None
    ctrl = [v for v in me.values() if not v["check"]]
    chk = [v for v in me.values() if v["check"]]
    cal = chunk.sensors[0].calibration
    summary = {
        "registered": sum(1 for c in chunk.cameras if c.transform), "images": len(chunk.cameras),
        "tie_points": len(chunk.tie_points.points) if chunk.tie_points else 0,
        "dense_points": chunk.point_cloud.point_count if chunk.point_cloud else 0,
        "calibration": {"f": cal.f, "cx": cal.cx, "cy": cal.cy, "k1": cal.k1, "k2": cal.k2, "k3": cal.k3, "p1": cal.p1, "p2": cal.p2},
        "control_rms_h": rms(ctrl, ["dE", "dN"]), "control_rms_v": rms(ctrl, ["dU"]),
        "check_rms_h": rms(chk, ["dE", "dN"]), "check_rms_v": rms(chk, ["dU"]),
        "n_control": len(ctrl), "n_check": len(chk), "markers": me, "timings": timings,
    }
    if a.ref_dem:
        r = subprocess.run([sys.executable, str(HERE / "score_dem.py"), str(ws / "dem.tif"), a.ref_dem, "--out", str(ws / "dem_score.json")],
                           capture_output=True, text=True)
        print(r.stdout[-1500:], r.stderr[-500:])
        summary["dem_score"] = json.load(open(ws / "dem_score.json"))
    json.dump(summary, open(ws / "summary.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k != "markers"}, indent=2))


if __name__ == "__main__":
    main()

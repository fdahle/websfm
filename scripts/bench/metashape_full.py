"""Metashape's whole pipeline at its API defaults, positions in the solve, as a user runs it:
the full-run column beside WebSfM and ODM (docs/BENCHMARKS.md ▸ WebSfM against ODM).

    python metashape_full.py --images <dir> --ws <dir> [--reference <json>] [--cloud-crs EPSG::32632]

Align Photos (High, 40,000 / 4,000 points, generic and reference preselection), Build
Depth Maps (Medium = 1/4 of the photo size per side, mild filtering), Point Cloud, Model
(from depth maps, high face count), UV + Texture (8,192 px), DEM (from the point cloud)
and Orthomosaic (on the model): each at the API's defaults, timed per stage.

--reference: {"positions": {stem: {lat, lon, alt, sn?, se?, su?}}, "leverArm": [x, y, z]?}
sets the camera references (WGS84) with their accuracies, and the GNSS antenna offset in
Metashape's camera axes (as Metashape exports it), held fixed. Without it the photos' EXIF
positions are used, as Metashape reads them.

Writes <ws>/colmap/model (cameras, for the bench's position check), <ws>/cloud.las when
--cloud-crs is given (the LiDAR check), and <ws>/metashape.json (seconds per stage, peak
memory, counts). Run with an interpreter that has the Metashape module (hist_env3),
QT_QPA_PLATFORM=offscreen.
"""
import argparse
import json
import os
import resource
import time
from pathlib import Path

import Metashape

from metashape_align import apply_reference

PHOTO_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--ws", required=True)
    ap.add_argument("--reference")
    ap.add_argument("--cloud-crs")
    a = ap.parse_args()

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

    referenced = apply_reference(chunk, a.reference) if a.reference else 0

    stage("matching", lambda: chunk.matchPhotos())
    stage("alignment", lambda: chunk.alignCameras())
    doc.save()
    stage("depthMaps", lambda: chunk.buildDepthMaps())
    stage("pointCloud", lambda: chunk.buildPointCloud())
    doc.save()
    stage("mesh", lambda: chunk.buildModel())
    stage("uv", lambda: chunk.buildUV())
    stage("texture", lambda: chunk.buildTexture())
    doc.save()
    stage("dem", lambda: chunk.buildDem())
    stage("orthomosaic", lambda: chunk.buildOrthomosaic())
    doc.save()

    out = ws / "colmap"
    out.mkdir(exist_ok=True)
    chunk.exportCameras(
        str(out / "model"),
        format=Metashape.CamerasFormatColmap,
        save_images=False,
        image_path="{filename}.{fileext}",
    )
    if a.cloud_crs:
        chunk.exportPointCloud(
            str(ws / "cloud.las"),
            format=Metashape.PointCloudFormatLAS,
            crs=Metashape.CoordinateSystem(a.cloud_crs),
            save_point_normal=False,
            save_point_confidence=False,
        )

    aligned = sum(1 for c in chunk.cameras if c.transform)
    summary = {
        "metashape": Metashape.app.version,
        "gpus": gpus,
        "images": len(chunk.cameras),
        "aligned": aligned,
        "referenced": referenced,
        "tiePoints": len(chunk.tie_points.points) if chunk.tie_points else 0,
        "densePoints": chunk.point_cloud.point_count if chunk.point_cloud else 0,
        "faces": len(chunk.model.faces) if chunk.model else 0,
        "seconds": {
            **seconds,
            "sfmTotal": round(seconds["matching"] + seconds["alignment"], 1),
            "total": round(sum(seconds.values()), 1),
        },
        # ru_maxrss is in KiB on Linux: the peak of this process, which runs Metashape in-process.
        "peakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024,
    }
    json.dump(summary, open(ws / "metashape.json", "w"), indent=2)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()

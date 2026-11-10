"""Metashape's sparse alignment of one photo set at its own defaults, for the scoreboard
beside WebSfM and COLMAP (metashape-ref.mjs runs it and scores the result).

    python metashape_align.py --images <dir> --ws <dir> [--preselect-reference]
        [--reference <json>] [--optimize]

Align Photos as the API defaults it: High accuracy (downscale 1), 40,000 key points,
4,000 tie points, generic preselection, then alignCameras. With --preselect-reference
the photos' EXIF positions also steer pair selection (Metashape's reference
preselection), as WebSfM's position preselection and COLMAP's spatial matcher do; the
positions enter the solve only without --no-pose-priors (Metashape's alignment uses enabled
camera references); with it, the block is a pure SfM result. --reference replaces the EXIF
positions with the bench's reference cameras and their accuracies (apply_reference, as
metashape_full.py), so a run with positions in the solve gets the same σ as WebSfM's;
--optimize adds Optimize Cameras after alignment (Metashape's usual next step).
All GPUs and the CPU are used. Writes <ws>/colmap/sparse/0/*.txt (COLMAP text model,
original image names) and <ws>/metashape.json (seconds per stage, peak memory, counts).

Run with an interpreter that has the Metashape module (hist_env3), QT_QPA_PLATFORM=offscreen.
"""
import argparse
import json
import os
import resource
import time
from pathlib import Path

import Metashape

PHOTO_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff")


def apply_reference(chunk, path):
    """Camera references from the bench's reference.json: {"positions": {stem: {lat, lon,
    alt, sn?, se?, su?}}, "leverArm": [x, y, z]?} (WGS84; the antenna offset in Metashape's
    camera axes, held fixed). Returns how many cameras got one."""
    ref = json.load(open(path))
    chunk.crs = Metashape.CoordinateSystem("EPSG::4326")
    pos = ref.get("positions") or {}
    referenced = 0
    for c in chunk.cameras:
        p = pos.get(c.label.lower())  # reference.mjs keys are lower-case stems
        if not p:
            continue
        c.reference.location = Metashape.Vector([p["lon"], p["lat"], p["alt"]])
        c.reference.location_enabled = True
        if p.get("sn"):
            c.reference.location_accuracy = Metashape.Vector([p["se"], p["sn"], p["su"]])
        referenced += 1
    if ref.get("leverArm"):
        for s in chunk.sensors:
            s.antenna.location_ref = Metashape.Vector(ref["leverArm"])
            s.antenna.location_fixed = True
    print(f"   {referenced} camera references from the reference file", flush=True)
    return referenced


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--ws", required=True)
    ap.add_argument("--preselect-reference", action="store_true")
    ap.add_argument(
        "--no-pose-priors",
        action="store_true",
        help="disable the photos' own positions and angles in the solve (pure SfM)",
    )
    ap.add_argument("--reference", help="reference.json: camera positions with accuracies")
    ap.add_argument("--optimize", action="store_true", help="Optimize Cameras after alignment")
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
    # Metashape's alignment includes the photos' EXIF positions when they are enabled; a
    # pure-SfM comparison (the bench's posePriors: false) switches them off, as WebSfM's
    # run leaves them out. Reference preselection still pairs by them.
    if a.no_pose_priors:
        for c in chunk.cameras:
            c.reference.location_enabled = False
            c.reference.rotation_enabled = False
    stage(
        "matching",
        lambda: chunk.matchPhotos(
            downscale=1,
            keypoint_limit=40000,
            tiepoint_limit=4000,
            generic_preselection=True,
            reference_preselection=a.preselect_reference,
            reference_preselection_mode=Metashape.ReferencePreselectionSource,
        ),
    )
    stage("alignment", lambda: chunk.alignCameras())
    if a.optimize:
        stage("optimize", lambda: chunk.optimizeCameras())
    doc.save()

    out = ws / "colmap"
    out.mkdir(exist_ok=True)
    chunk.exportCameras(
        str(out / "model"),
        format=Metashape.CamerasFormatColmap,
        save_images=False,
        image_path="{filename}.{fileext}",
    )
    aligned = sum(1 for c in chunk.cameras if c.transform)
    summary = {
        "metashape": Metashape.app.version,
        "gpus": gpus,
        "images": len(chunk.cameras),
        "aligned": aligned,
        "tiePoints": len(chunk.tie_points.points) if chunk.tie_points else 0,
        "seconds": {**seconds, "sfmTotal": round(seconds["matching"] + seconds["alignment"], 1)},
        # ru_maxrss is in KiB on Linux: the peak of this process, which runs Metashape in-process.
        "peakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024,
        "referencePreselection": a.preselect_reference,
        "posePriors": not a.no_pose_priors,
        "referenced": referenced,
        "optimize": a.optimize,
    }
    json.dump(summary, open(ws / "metashape.json", "w"), indent=2)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()

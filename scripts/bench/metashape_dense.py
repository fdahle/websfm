"""Metashape's dense cloud of one ETH3D scene from the scene's ground-truth cameras, for the
dense scoreboard beside WebSfM and COLMAP (scored by scripts/bench/eth3d.mjs or ETH3D's
own evaluator, in the ground-truth frame).

    python metashape_dense.py --scene <ETH3D scene dir> --ws <dir> [--downscale 4]

Sets <scene>/dslr_calibration_undistorted (COLMAP text model) as fixed sensors and poses,
triangulates tie points from them, builds
depth maps (downscale 2 = Metashape's High, 4 = Medium; mild filtering, the default) and
the point cloud, and writes <ws>/dense.ply in the cameras' frame plus <ws>/metashape.json
(seconds per stage, peak memory, point count). A check exports the cameras again and
reports how far their centres moved from the ground truth (should be ~0).

Run with an interpreter that has the Metashape module (hist_env3), QT_QPA_PLATFORM=offscreen.
"""
import argparse
import json
import os
import resource
import time
from pathlib import Path

import Metashape


def colmap_centres(images_txt):
    """name -> camera centre (-Rᵀt) from a COLMAP images.txt."""
    import math

    out = {}
    lines = [l for l in open(images_txt) if l.strip() and not l.startswith("#")]
    for l in lines[0::2]:
        p = l.split()
        qw, qx, qy, qz, tx, ty, tz = map(float, p[1:8])
        name = os.path.basename(p[9])
        # R from the quaternion (COLMAP: world → camera)
        R = [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
            [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
            [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
        ]
        t = [tx, ty, tz]
        out[name] = [-sum(R[r][c] * t[r] for r in range(3)) for c in range(3)]
    _ = math
    return out


def apply_colmap(chunk, calib, cameras):
    """Give Metashape's cameras ETH3D's ground truth: one fixed sensor per COLMAP camera
    (PINHOLE) and each photo's pose. Metashape imports no COLMAP model, and its XML import
    kept its own EXIF sensor, so both are set through the API. Its frame model is
    x = w/2 + cx + x'(f + b1), y = h/2 + cy + y'·f: f = fy, b1 = fx − fy, cx, cy offsets
    from the centre; a camera's transform is camera → world (COLMAP's R, t: world → camera).
    `cameras` are matched to images.txt by label (the file name without extension)."""
    sensors = {}
    for l in open(calib / "cameras.txt"):
        if not l.strip() or l.startswith("#"):
            continue
        p = l.split()
        if p[1] != "PINHOLE":
            raise SystemExit(f"camera model {p[1]} not handled (ETH3D undistorted is PINHOLE)")
        w, h = int(p[2]), int(p[3])
        fx, fy, cx, cy = map(float, p[4:8])
        s = chunk.addSensor()
        s.label = f"gt{p[0]}"
        s.type = Metashape.Sensor.Type.Frame
        s.width, s.height = w, h
        cal = Metashape.Calibration()
        cal.width, cal.height = w, h
        cal.f, cal.cx, cal.cy, cal.b1 = fy, cx - w / 2, cy - h / 2, fx - fy
        s.user_calib = cal
        s.calibration = cal
        s.fixed_calibration = True
        sensors[p[0]] = s
    lines = [x for x in open(calib / "images.txt") if x.strip() and not x.startswith("#")][0::2]
    # By label: addPhotos sorts the photos by name, whatever order it is given.
    by_label = {c.label: c for c in cameras}
    for l in lines:
        p = l.split()
        cam = by_label[os.path.splitext(os.path.basename(p[9]))[0]]
        qw, qx, qy, qz, tx, ty, tz = map(float, p[1:8])
        R = [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
            [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
            [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
        ]
        t = [tx, ty, tz]
        C = [-sum(R[r][c] * t[r] for r in range(3)) for c in range(3)]
        cam.sensor = sensors[p[8]]
        cam.transform = Metashape.Matrix(
            [
                [R[0][0], R[1][0], R[2][0], C[0]],
                [R[0][1], R[1][1], R[2][1], C[1]],
                [R[0][2], R[1][2], R[2][2], C[2]],
                [0, 0, 0, 1],
            ]
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True)
    ap.add_argument("--ws", required=True)
    ap.add_argument("--downscale", type=int, default=4)
    a = ap.parse_args()

    scene = Path(a.scene)
    calib = scene / "dslr_calibration_undistorted"
    img_dir = scene / "images" / "dslr_images_undistorted"
    ws = Path(a.ws)
    ws.mkdir(parents=True, exist_ok=True)
    gpus = len(Metashape.app.enumGPUDevices())
    Metashape.app.gpu_mask = (1 << gpus) - 1
    Metashape.app.cpu_enable = True

    doc = Metashape.Document()
    doc.save(str(ws / "project.psx"))
    chunk = doc.addChunk()
    seconds = {}

    def stage(name, fn):
        print(f"== {name}", flush=True)
        t0 = time.time()
        fn()
        seconds[name] = round(time.time() - t0, 1)
        print(f"   {seconds[name]} s", flush=True)

    names = [l.split()[9] for l in [x for x in open(calib / "images.txt") if x.strip() and not x.startswith("#")][0::2]]
    files = [str(img_dir / os.path.basename(n)) for n in names]
    stage("addPhotos", lambda: chunk.addPhotos(files))
    stage("importCameras", lambda: apply_colmap(chunk, calib, list(chunk.cameras)))
    posed = sum(1 for c in chunk.cameras if c.transform)
    print(f"   {posed}/{len(chunk.cameras)} cameras posed", flush=True)

    # The imported frame must be the ground truth's: export the cameras again and compare.
    chk = ws / "check"
    chk.mkdir(exist_ok=True)
    chunk.exportCameras(
        str(chk / "model"),
        format=Metashape.CamerasFormatColmap,
        save_images=False,
        image_path="{filename}.{fileext}",
    )
    gt = colmap_centres(calib / "images.txt")
    found = next(chk.rglob("images.txt"), None)
    moved = None
    if found:
        got = colmap_centres(found)
        d = [sum((got[k][i] - gt[k][i]) ** 2 for i in range(3)) ** 0.5 for k in gt if k in got]
        moved = max(d) if d else None
    print(f"   camera centres vs ground truth: max {moved}", flush=True)

    # Depth maps take their depth range from tie points: match, then triangulate them from
    # the fixed cameras (no alignment, so the poses stay the ground truth's).
    stage(
        "tiePoints",
        lambda: (
            chunk.matchPhotos(downscale=1, keypoint_limit=40000, tiepoint_limit=4000, generic_preselection=True),
            chunk.triangulateTiePoints(),
        ),
    )
    stage(
        "depthMaps",
        lambda: chunk.buildDepthMaps(downscale=a.downscale, filter_mode=Metashape.MildFiltering),
    )
    stage("pointCloud", lambda: chunk.buildPointCloud())
    doc.save()
    stage(
        "export",
        lambda: chunk.exportPointCloud(
            str(ws / "dense.ply"),
            source_data=Metashape.PointCloudData,
            save_point_color=False,
            save_point_normal=False,
            binary=True,
            format=Metashape.PointCloudFormatPLY,
        ),
    )
    summary = {
        "metashape": Metashape.app.version,
        "gpus": gpus,
        "downscale": a.downscale,
        "cameras": len(chunk.cameras),
        "posed": posed,
        "cameraCentreMaxMove": moved,
        "points": chunk.point_cloud.point_count if chunk.point_cloud else 0,
        "seconds": {**seconds, "denseTotal": round(seconds["depthMaps"] + seconds["pointCloud"], 1)},
        "peakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024,
    }
    json.dump(summary, open(ws / "metashape.json", "w"), indent=2)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()

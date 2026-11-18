"""Metashape's checkpoint error with rolling-shutter compensation off and on, over the
leave-one-out GCP splits the WebSfM bench ran (RSH-5, dev/TODO.md ▸ 3: the Mavic Air 2
block, mavic-rs5-HV-0*.json).

    python metashape_rs.py --images <dir> --gcps GCPs.csv --splits <dir> --ws <dir>
        [--models off,on,full] [--variants base,norefs,center,norefs-center] [--out result.json]

For each model (off: Shutter.Model.Disabled, on: Shutter.Model.Regularized, which
Agisoft recommends for drones, full: Shutter.Model.Full) the photos are aligned once at Metashape's API defaults
(High accuracy, 40,000 key points, 4,000 tie points, generic and reference
preselection), with the photos' EXIF positions as camera references (default accuracy),
as WebSfM's run used them (posePriors). Then, for each split file in --splits
(gcp-check-HV-0*.csv, the bench's `hist.gcps`: label prefix "1-" control, "0-" check),
a copy of the aligned chunk gets the GCPs as markers with the split's pixel marks, the
control ones enabled with their surveyed σ, the checkpoint disabled, and Optimize
Cameras runs (f, cx, cy, k1–k3, p1, p2, and the rolling shutter when on). The error of a
marker is its estimated position against its reference in metres east / north / up.

--gcps: GCPs.csv (pnt, lat, lon, h_ellip, …, sigma_x, sigma_y, sigma_z), WGS84
ellipsoidal heights. Marks are in pixels from the image's top-left corner (WebSfM's
pixel-edge convention), the convention Metashape's marker projections use too.

Run with an interpreter that has the Metashape module (hist_env3), QT_QPA_PLATFORM=offscreen.
"""
import argparse
import csv
import json
import math
import time
from pathlib import Path

import Metashape

PHOTO_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff")
MODELS = {
    "off": Metashape.Shutter.Model.Disabled,
    "on": Metashape.Shutter.Model.Regularized,
    "full": Metashape.Shutter.Model.Full,
}


def read_gcps(path):
    out = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            out[r["pnt"].strip()] = {
                "lon": float(r["lon"]),
                "lat": float(r["lat"]),
                "h": float(r["h_ellip"]),
                "sigma": [float(r["sigma_x"]), float(r["sigma_y"]), float(r["sigma_z"])],
            }
    return out


def read_split(path):
    """{label: {"role": "control" | "check", "marks": [(image, x, y)]}}"""
    out = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            prefix, label = r["gcp_label"].split("-", 1)
            g = out.setdefault(label, {"role": "check" if prefix == "0" else "control", "marks": []})
            g["marks"].append((r["image_file_name"], float(r["x"]), float(r["y"])))
    return out


def marker_error(chunk, marker):
    """Estimated minus reference position, metres east / north / up, or None."""
    if marker.position is None:
        return None
    T = chunk.transform.matrix
    est = T.mulp(marker.position)
    ref = chunk.crs.unproject(marker.reference.location)
    local = chunk.crs.localframe(est)
    d = local.mulv(est - ref)
    return [d.x, d.y, d.z]


def rms(values):
    return math.sqrt(sum(v * v for v in values) / len(values)) if values else None


def align(doc, images, model):
    chunk = doc.addChunk()
    chunk.label = f"aligned-{model}"
    chunk.addPhotos([str(p) for p in images])
    for sensor in chunk.sensors:
        sensor.rolling_shutter = MODELS[model]
    t0 = time.time()
    chunk.matchPhotos(
        downscale=1,
        keypoint_limit=40000,
        tiepoint_limit=4000,
        generic_preselection=True,
        reference_preselection=True,
    )
    chunk.alignCameras()
    return chunk, time.time() - t0


def offset_enu(chunk, est_internal, ref_geo):
    """est (chunk internal) minus ref (chunk CRS), metres east / north / up."""
    T = chunk.transform.matrix
    est = T.mulp(est_internal)
    ref = chunk.crs.unproject(ref_geo)
    d = chunk.crs.localframe(est).mulv(est - ref)
    return [d.x, d.y, d.z]


def camera_offsets(chunk):
    """Mean and spread of the aligned cameras' positions against their EXIF references
    (the up part shows a datum offset: DJI writes heights above sea level)."""
    ds = [offset_enu(chunk, cam.center, cam.reference.location) for cam in chunk.cameras
          if cam.transform is not None and cam.reference.location is not None]
    if not ds:
        return None
    mean = [sum(d[k] for d in ds) / len(ds) for k in range(3)]
    sd = [math.sqrt(sum((d[k] - mean[k]) ** 2 for d in ds) / len(ds)) for k in range(3)]
    return {"mean": mean, "sd": sd, "n": len(ds)}


def run_split(chunk, gcps, split, variant):
    """variant: {"refs": the cameras' EXIF positions stay references, "shift": px added
    to every mark (−0.5 reads a top-left-edge mark as pixel-centre)}."""
    c = chunk.copy()
    by_name = {Path(cam.photo.path).name: cam for cam in c.cameras if cam.photo}
    if not variant["refs"]:
        for cam in c.cameras:
            cam.reference.enabled = False
            cam.reference.location_enabled = False
            cam.reference.rotation_enabled = False
    markers = {}
    for label, g in split.items():
        ref = gcps[label]
        m = c.addMarker()
        m.label = label
        m.reference.location = Metashape.Vector([ref["lon"], ref["lat"], ref["h"]])
        m.reference.accuracy = Metashape.Vector(ref["sigma"])
        m.reference.enabled = g["role"] == "control"
        for image, x, y in g["marks"]:
            cam = by_name.get(image)
            if cam is not None:
                p = Metashape.Vector([x + variant["shift"], y + variant["shift"]])
                m.projections[cam] = Metashape.Marker.Projection(p, True)
        markers[label] = (m, g["role"])
    t0 = time.time()
    c.optimizeCameras(fit_f=True, fit_cx=True, fit_cy=True, fit_k1=True, fit_k2=True, fit_k3=True,
                      fit_p1=True, fit_p2=True)
    seconds = time.time() - t0
    out = {"seconds": seconds, "markers": {}}
    for label, (m, role) in markers.items():
        out["markers"][label] = {"role": role, "error": marker_error(c, m), "marks": len(m.projections)}
    out["aligned"] = sum(1 for cam in c.cameras if cam.transform is not None)
    cal = c.sensors[0].calibration if c.sensors else None
    if cal is not None:
        out["calibration"] = {k: getattr(cal, k) for k in ("f", "cx", "cy", "k1", "k2", "k3", "p1", "p2")}
    out["cameraOffsets"] = camera_offsets(c)
    return out


def summarise(splits):
    checks = [m["error"] for s in splits.values() for m in s["markers"].values()
              if m["role"] == "check" and m["error"]]
    controls = [m["error"] for s in splits.values() for m in s["markers"].values()
                if m["role"] == "control" and m["error"]]
    return (
        {"H": rms([math.hypot(e[0], e[1]) for e in checks]), "V": rms([e[2] for e in checks]), "n": len(checks),
         "meanE": sum(e[0] for e in checks) / len(checks), "meanN": sum(e[1] for e in checks) / len(checks),
         "meanU": sum(e[2] for e in checks) / len(checks)},
        {"H": rms([math.hypot(e[0], e[1]) for e in controls]), "V": rms([e[2] for e in controls]),
         "n": len(controls)},
    )


VARIANTS = {
    "base": {"refs": True, "shift": 0.0},
    "norefs": {"refs": False, "shift": 0.0},
    "center": {"refs": True, "shift": -0.5},
    "norefs-center": {"refs": False, "shift": -0.5},
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--gcps", required=True)
    ap.add_argument("--splits", required=True)
    ap.add_argument("--ws", required=True)
    ap.add_argument("--models", default="off,on")
    ap.add_argument("--variants", default="base", help=",".join(VARIANTS))
    ap.add_argument("--out")
    a = ap.parse_args()

    images = sorted(p for p in Path(a.images).iterdir() if p.suffix.lower() in PHOTO_EXT)
    gcps = read_gcps(a.gcps)
    splits = {p.stem: read_split(p) for p in sorted(Path(a.splits).glob("gcp-check-*.csv"))}
    ws = Path(a.ws)
    ws.mkdir(parents=True, exist_ok=True)
    result = {"images": len(images), "splits": list(splits), "models": {}}
    for model in a.models.split(","):
        doc = Metashape.Document()
        doc.save(str(ws / f"project-{model}.psx"))
        chunk, align_s = align(doc, images, model)
        doc.save()
        per = {"alignSeconds": align_s, "aligned": sum(1 for c in chunk.cameras if c.transform is not None),
               "alignedOffsets": camera_offsets(chunk), "variants": {}}
        sensor = chunk.sensors[0] if chunk.sensors else None
        per["sensor"] = {"rolling_shutter": str(sensor.rolling_shutter) if sensor else None}
        for vname in a.variants.split(","):
            splits_out = {name: run_split(chunk, gcps, split, VARIANTS[vname]) for name, split in splits.items()}
            check, control = summarise(splits_out)
            per["variants"][vname] = {"checkRms": check, "controlRms": control, "splits": splits_out}
            print(model, vname, "check", json.dumps(check), "control", json.dumps(control), flush=True)
        result["models"][model] = per
    text = json.dumps(result, indent=1)
    if a.out:
        Path(a.out).write_text(text)
    print(text)


if __name__ == "__main__":
    main()

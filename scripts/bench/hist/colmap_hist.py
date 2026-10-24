"""COLMAP reference run for a historical aerial / satellite frame set with surveyed GCPs
(Grenoble benchmark layout: preprocessed_images/, image_mask.tif, gcp.csv,
camera_model_intrinsics.csv), scored the same way as websfm and Metashape:

  features (masked) → matching → mapper → GCP similarity (7-parameter Helmert from the
  GCPs triangulated in the model, leave-one-out checkpoint residuals) → undistort →
  PatchMatch → fusion → DEM (median per cell) in the GCP CRS → score_dem.py

    python colmap_hist.py --images <dir> --mask <mask.tif> --gcps <gcp.csv>
        --intrinsics <camera_model_intrinsics.csv> --ws <workspace> --epsg 6341
        [--ref-dem <ref.tif>] [--dense-size 4570] [--dem-res 2] [--matcher exhaustive]
        [--camera-model SIMPLE_RADIAL] [--skip-dense] [--colmap <binary>]

COLMAP's defaults otherwise: one shared camera (a single film camera), the prior focal
length from the calibration certificate, SIFT on the GPU. Stages that already produced
their output in --ws are skipped, so a rerun resumes. Run with the hist_env3 interpreter.
"""
import argparse
import csv
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

# The COLMAP binary: $COLMAP (e.g. a conda env's bin/colmap), else `colmap` on PATH.
COLMAP_DEFAULT = os.environ.get("COLMAP", "colmap")
HERE = Path(__file__).resolve().parent


def keep_mask(m):
    """Boolean keep-mask from a benchmark image_mask.tif. The sites disagree on the
    convention (Casa Grande: 1 = keep; Iceland: 0 = keep, 255 = border), so the value
    at the frame centre — always imaged terrain — is the kept class (stray edge values drop)."""
    return m == m[m.shape[0] // 2, m.shape[1] // 2]


def run(colmap, stage, cmd, opts, ws, timings):
    argv = [colmap, cmd] + [x for k, v in opts.items() for x in (f"--{k}", str(v))]
    print(f"== {stage}: {' '.join(argv)}", flush=True)
    t0 = time.time()
    with open(ws / f"{stage}.log", "w") as log:
        r = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, "QT_QPA_PLATFORM": "offscreen"})
    timings[stage] = round(time.time() - t0, 1)
    print(f"   {timings[stage]} s, exit {r.returncode}", flush=True)
    if r.returncode != 0:
        sys.exit(f"{stage} failed; see {ws / (stage + '.log')}")


# ── COLMAP text model ──
def read_model(d):
    cams, imgs = {}, {}
    for line in open(d / "cameras.txt"):
        if line.startswith("#") or not line.strip():
            continue
        p = line.split()
        cams[int(p[0])] = {"model": p[1], "w": int(p[2]), "h": int(p[3]), "params": [float(x) for x in p[4:]]}
    lines = [l for l in open(d / "images.txt") if not l.startswith("#")]
    for i in range(0, len(lines) - 1, 2):
        p = lines[i].split()
        if len(p) < 10:
            continue
        q = np.array([float(x) for x in p[1:5]])
        t = np.array([float(x) for x in p[5:8]])
        obs = lines[i + 1].split()
        imgs[p[9]] = {"id": int(p[0]), "R": qvec2rot(q), "t": t, "cam": int(p[8]),
                      "nobs": sum(1 for k in range(2, len(obs), 3) if obs[k] != "-1")}
    npts = sum(1 for l in open(d / "points3D.txt") if not l.startswith("#") and l.strip())
    return cams, imgs, npts


def qvec2rot(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y]])


def unproject(cam, u, v):
    """Pixel (COLMAP convention: top-left pixel centre at 0.5) → normalized image coords."""
    m, p = cam["model"], cam["params"]
    if m in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL"):
        f, cx, cy = p[0], p[1], p[2]
        fx = fy = f
        k1 = p[3] if len(p) > 3 else 0.0
        k2 = p[4] if m == "RADIAL" else 0.0
        p1 = p2 = 0.0
    elif m in ("PINHOLE", "OPENCV", "FULL_OPENCV"):
        fx, fy, cx, cy = p[:4]
        k1, k2, p1, p2 = (p[4:8] + [0, 0, 0, 0])[:4] if len(p) > 4 else (0, 0, 0, 0)
    else:
        raise ValueError(f"camera model {m} not handled")
    xd, yd = (u - cx) / fx, (v - cy) / fy
    x, y = xd, yd
    for _ in range(50):
        r2 = x * x + y * y
        rad = 1 + k1 * r2 + k2 * r2 * r2
        dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        x, y = (xd - dx) / rad, (yd - dy) / rad
    return x, y


def triangulate(obs):
    """obs: [(R, t, x, y)] normalized → least-squares DLT point + per-view reprojection (normalized)."""
    A = []
    for R, t, x, y in obs:
        P = np.hstack([R, t[:, None]])
        A.append(x * P[2] - P[0])
        A.append(y * P[2] - P[1])
    _, _, vt = np.linalg.svd(np.array(A))
    X = vt[-1]
    return X[:3] / X[3]


def umeyama(src, dst):
    """Similarity dst ≈ s R src + t."""
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    U, S, Vt = np.linalg.svd(b.T @ a / len(src))
    D = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (a * a).sum(1).mean()
    return s, R, md - s * R @ ms


def georef(model_dir, gcp_csv, out_json):
    cams, imgs, npts = read_model(model_dir)
    rows = list(csv.DictReader(open(gcp_csv)))
    gcps = {}
    for r in rows:
        g = gcps.setdefault(r["gcp_label"], {"xyz": [float(r["x_map"]), float(r["y_map"]), float(r["elev"])], "marks": []})
        g["marks"].append((r["image_file_name"], float(r["x"]), float(r["y"])))
    tri = {}
    for label, g in gcps.items():
        obs = []
        for name, u, v in g["marks"]:
            im = imgs.get(name)
            if im is None:
                continue
            x, y = unproject(cams[im["cam"]], u, v)
            obs.append((im["R"], im["t"], x, y))
        if len(obs) >= 2:
            tri[label] = triangulate(obs)
    labels = sorted(tri)
    if len(labels) < 3:
        sys.exit(f"only {len(labels)} GCPs triangulated; need >= 3")
    src = np.array([tri[k] for k in labels])
    dst = np.array([gcps[k]["xyz"] for k in labels])
    origin = np.round(dst.mean(0) / 1000) * 1000
    origin[2] = 0
    dstl = dst - origin

    # Robust fit: drop GCPs whose residual exceeds 3x the median (and > 5 m), refit.
    keep = np.ones(len(labels), bool)
    for _ in range(5):
        s, R, t = umeyama(src[keep], dstl[keep])
        res = np.linalg.norm((s * (R @ src.T)).T + t - dstl, axis=1)
        med = np.median(res[keep])
        new = res <= max(3 * med, 5.0)
        if (new == keep).all():
            break
        keep = new
    s, R, t = umeyama(src[keep], dstl[keep])
    fit = (s * (R @ src.T)).T + t - dstl
    # Leave-one-out checkpoints over the kept set.
    loo = {}
    for i in np.where(keep)[0]:
        k2 = keep.copy()
        k2[i] = False
        s2, R2, t2 = umeyama(src[k2], dstl[k2])
        loo[labels[i]] = ((s2 * (R2 @ src[i])) + t2 - dstl[i]).tolist()
    L = np.array(list(loo.values()))
    res = {
        "registered": len(imgs), "points": npts, "camera": cams,
        "gcps_triangulated": len(labels), "gcps_used": int(keep.sum()),
        "gcps_rejected": [labels[i] for i in np.where(~keep)[0]],
        "scale": s, "origin": origin.tolist(),
        "fit_rms_h": float(np.sqrt((fit[keep, :2] ** 2).sum(1).mean())),
        "fit_rms_v": float(np.sqrt((fit[keep, 2] ** 2).mean())),
        "loo_rms_h": float(np.sqrt((L[:, :2] ** 2).sum(1).mean())),
        "loo_rms_v": float(np.sqrt((L[:, 2] ** 2).mean())),
        "loo": loo,
    }
    json.dump(res, open(out_json, "w"), indent=2)
    # 3x4 similarity for model_transformer (model → local UTM, origin removed).
    M = np.hstack([s * R, t[:, None]])
    return res, M


def rot2qvec(R):
    w = np.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = np.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2
    y = np.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2
    z = np.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2
    x = np.copysign(x, R[2, 1] - R[1, 2])
    y = np.copysign(y, R[0, 2] - R[2, 0])
    z = np.copysign(z, R[1, 0] - R[0, 1])
    return np.array([w, x, y, z]) / np.linalg.norm([w, x, y, z])


def transform_model_txt(src, dst, M):
    """Apply X' = s R X + t (M = [sR | t]) to a COLMAP text model: points move, and each
    camera's world-to-camera pose becomes R_c R^T, s t_c - R_c R^T t. (COLMAP 4's
    model_transformer reads its transform file in a different layout.)"""
    sR, t = M[:, :3], M[:, 3]
    s = np.cbrt(np.linalg.det(sR))
    R = sR / s
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "cameras.txt").write_text((src / "cameras.txt").read_text())
    out, lines = [], (src / "images.txt").read_text().splitlines()
    data = [l for l in lines if not l.startswith("#")]
    out += [l for l in lines if l.startswith("#")]
    for i in range(0, len(data) - 1, 2):
        p = data[i].split()
        Rc = qvec2rot(np.array([float(x) for x in p[1:5]]))
        tc = np.array([float(x) for x in p[5:8]])
        R2 = Rc @ R.T
        t2 = s * tc - R2 @ t
        q = rot2qvec(R2)
        out.append(" ".join([p[0], *(f"{v:.17g}" for v in q), *(f"{v:.17g}" for v in t2), *p[8:]]))
        out.append(data[i + 1])
    (dst / "images.txt").write_text("\n".join(out) + "\n")
    pts = []
    for l in (src / "points3D.txt").read_text().splitlines():
        if l.startswith("#") or not l.strip():
            pts.append(l)
            continue
        p = l.split()
        X = s * (R @ np.array([float(v) for v in p[1:4]])) + t
        pts.append(" ".join([p[0], *(f"{v:.6f}" for v in X), *p[4:]]))
    (dst / "points3D.txt").write_text("\n".join(pts) + "\n")


def read_ply_xyz(path):
    with open(path, "rb") as f:
        n, props = 0, []
        while True:
            line = f.readline().decode().strip()
            if line.startswith("element vertex"):
                n = int(line.split()[-1])
            elif line.startswith("property"):
                props.append(line.split()[1:])
            elif line == "end_header":
                break
        fmt = {"float": "f4", "double": "f8", "uchar": "u1", "int": "i4", "uint": "u4", "short": "i2", "ushort": "u2"}
        dt = np.dtype([(p[1], "<" + fmt[p[0]]) for p in props])
        a = np.fromfile(f, dtype=dt, count=n)
    return np.stack([a["x"], a["y"], a["z"]], 1).astype(np.float64)


def grid_dem(xyz, origin, res, epsg, out_tif, fill_cells=0):
    import rasterio
    from rasterio.transform import from_origin
    e, n, z = xyz[:, 0] + origin[0], xyz[:, 1] + origin[1], xyz[:, 2] + origin[2]
    x0, y1 = np.floor(e.min() / res) * res, np.ceil(n.max() / res) * res
    W = int(np.ceil((e.max() - x0) / res)) + 1
    H = int(np.ceil((y1 - n.min()) / res)) + 1
    # ~13 bytes per cell (float32 grid + int64 index); a KH-9 frame (140 × 70 km) at the
    # 2 m default is 2.5 G cells and took 40 GB. Refuse rather than exhaust the machine.
    if W * H > 400_000_000:
        sys.exit(f"DEM grid {W}×{H} at {res} m is too large; pass a coarser --dem-res")
    col = ((e - x0) / res).astype(np.int64)
    row = ((y1 - n) / res).astype(np.int64)
    idx = row * W + col
    order = np.lexsort((z, idx))
    idx, z = idx[order], z[order]
    starts = np.r_[0, np.flatnonzero(np.diff(idx)) + 1]
    ends = np.r_[starts[1:], len(idx)]
    med = z[(starts + ends - 1) // 2]
    dem = np.full(H * W, np.nan, np.float32)
    dem[idx[starts]] = med
    dem = dem.reshape(H, W)
    prof = {"driver": "GTiff", "height": H, "width": W, "count": 1, "dtype": "float32", "crs": f"EPSG:{epsg}",
            "transform": from_origin(x0, y1, res, res), "nodata": -9999.0, "compress": "deflate", "tiled": True}
    out = np.where(np.isfinite(dem), dem, -9999.0).astype(np.float32)
    with rasterio.open(out_tif, "w", **prof) as o:
        o.write(out, 1)
    if fill_cells:
        from rasterio.fill import fillnodata
        with rasterio.open(out_tif, "r+") as o:
            a = o.read(1)
            o.write(fillnodata(a, mask=(a != -9999.0), max_search_distance=fill_cells, smoothing_iterations=0), 1)
    return {"cells": int(np.isfinite(dem).sum()), "width": W, "height": H}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--mask")
    ap.add_argument("--gcps", required=True)
    ap.add_argument("--intrinsics")
    ap.add_argument("--ws", required=True)
    ap.add_argument("--epsg", default="6341")
    ap.add_argument("--ref-dem")
    ap.add_argument("--dense-size", type=int, default=4570)
    ap.add_argument("--dem-res", type=float, default=2.0)
    ap.add_argument("--matcher", default="exhaustive")
    ap.add_argument("--camera-model", default="SIMPLE_RADIAL")
    ap.add_argument("--max-features", type=int, default=0, help="0 = COLMAP default")
    ap.add_argument("--skip-dense", action="store_true")
    ap.add_argument("--colmap", default=COLMAP_DEFAULT)
    a = ap.parse_args()

    ws = Path(a.ws)
    ws.mkdir(parents=True, exist_ok=True)
    timings = json.load(open(ws / "timings.json")) if (ws / "timings.json").exists() else {}
    save_t = lambda: json.dump(timings, open(ws / "timings.json", "w"), indent=2)
    images = sorted(f for f in os.listdir(a.images) if f.lower().endswith((".tif", ".tiff", ".jpg", ".png")))
    db = ws / "database.db"

    if not db.exists():
        opts = {"database_path": db, "image_path": a.images, "ImageReader.single_camera": 1,
                "ImageReader.camera_model": a.camera_model, "FeatureExtraction.use_gpu": 1}
        if a.max_features:
            opts["SiftExtraction.max_num_features"] = a.max_features
        if a.mask:
            # COLMAP wants <mask_path>/<image name>.png, 0 = ignore: one shared mask, linked per image.
            md = ws / "masks"
            md.mkdir(exist_ok=True)
            mpng = ws / "mask.png"
            if not mpng.exists():
                import rasterio
                from PIL import Image
                Image.fromarray((keep_mask(rasterio.open(a.mask).read(1)) * 255).astype(np.uint8)).save(mpng)
            for im in images:
                link = md / f"{im}.png"
                if not link.exists():
                    link.symlink_to(mpng)
            opts["ImageReader.mask_path"] = md
        if a.intrinsics:
            r = next(csv.DictReader(open(a.intrinsics)))
            f_px = float(r["focal_length"]) / float(r["pixel_pitch"])
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = None
            w, h = Image.open(Path(a.images) / images[0]).size
            ppx = w / 2 + float(r.get("principal_point_x_mm") or 0) / float(r["pixel_pitch"])
            ppy = h / 2 - float(r.get("principal_point_y_mm") or 0) / float(r["pixel_pitch"])
            base = {"SIMPLE_RADIAL": [f_px, ppx, ppy, 0], "RADIAL": [f_px, ppx, ppy, 0, 0],
                    "OPENCV": [f_px, f_px, ppx, ppy, 0, 0, 0, 0], "PINHOLE": [f_px, f_px, ppx, ppy]}[a.camera_model]
            opts["ImageReader.camera_params"] = ",".join(f"{v:.4f}" for v in base)
        run(a.colmap, "features", "feature_extractor", opts, ws, timings)
        save_t()
    if not (ws / "matches.done").exists():
        run(a.colmap, "matching", f"{a.matcher}_matcher", {"database_path": db, "FeatureMatching.use_gpu": 1}, ws, timings)
        (ws / "matches.done").touch()
        save_t()
    sparse = ws / "sparse"
    if not (sparse / "0").exists():
        sparse.mkdir(exist_ok=True)
        run(a.colmap, "mapper", "mapper", {"database_path": db, "image_path": a.images, "output_path": sparse}, ws, timings)
        save_t()
    # Largest model if the mapper split the set.
    models = sorted((p for p in sparse.iterdir() if p.is_dir() and p.name.isdigit()),
                    key=lambda p: os.path.getsize(p / "images.bin"), reverse=True)
    txt = ws / "sparse_txt"
    txt.mkdir(exist_ok=True)
    run(a.colmap, "to_txt", "model_converter", {"input_path": models[0], "output_path": txt, "output_type": "TXT"}, ws, timings)
    res, M = georef(txt, a.gcps, ws / "georef.json")
    res["models"] = len(models)
    print(f"== georef: {res['registered']}/{len(images)} registered, {res['points']} points, "
          f"{res['gcps_used']}/{res['gcps_triangulated']} GCPs, fit H {res['fit_rms_h']:.2f} V {res['fit_rms_v']:.2f} m, "
          f"LOO H {res['loo_rms_h']:.2f} V {res['loo_rms_v']:.2f} m", flush=True)
    np.savetxt(ws / "transform.txt", np.vstack([M, [0, 0, 0, 1]]))
    geo = ws / "sparse_geo"
    if not (geo / "images.txt").exists():
        transform_model_txt(txt, geo, M)
    summary = {"georef": {k: v for k, v in res.items() if k != "loo"}, "timings": timings}
    if not a.skip_dense:
        dense = ws / "dense"
        if not (dense / "sparse").exists():
            run(a.colmap, "undistort", "image_undistorter", {"image_path": a.images, "input_path": geo,
                "output_path": dense, "max_image_size": a.dense_size}, ws, timings)
            save_t()
        if not (dense / "pm.done").exists():
            run(a.colmap, "patch_match", "patch_match_stereo", {"workspace_path": dense,
                "PatchMatchStereo.geom_consistency": "true"}, ws, timings)
            (dense / "pm.done").touch()
            save_t()
        fused = dense / "fused.ply"
        if not fused.exists():
            run(a.colmap, "fusion", "stereo_fusion", {"workspace_path": dense, "output_path": fused}, ws, timings)
            save_t()
        xyz = read_ply_xyz(fused)
        summary["dense_points"] = len(xyz)
        dem = ws / "dem.tif"
        summary["dem"] = grid_dem(xyz, res["origin"], a.dem_res, a.epsg, dem)
        if a.ref_dem:
            r = subprocess.run([sys.executable, HERE / "score_dem.py", dem, a.ref_dem, "--out", ws / "dem_score.json"],
                               capture_output=True, text=True)
            print(r.stdout[-1500:], r.stderr[-500:])
            summary["dem_score"] = json.load(open(ws / "dem_score.json"))
    summary["timings"] = timings
    json.dump(summary, open(ws / "summary.json", "w"), indent=2, default=str)
    print(json.dumps(summary, indent=2, default=str)[:3000])


if __name__ == "__main__":
    main()

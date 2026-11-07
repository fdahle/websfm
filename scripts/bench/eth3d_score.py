"""ETH3D dense accuracy / completeness, a fast twin of scripts/bench/eth3d.mjs (same
definitions: scan-box crop grown by the largest tolerance, voxel thinning at min(tol)/2
keeping the first point per cell, accuracy / completeness / F1 per tolerance), with
SciPy's threaded k-d tree and the thinned ground truth cached per scene.

    python eth3d_score.py --scene <ETH3D scene dir> --recon <cloud.dense.bin | .ply>
        [--occlusion min] [--label x] [--out result.json]

--occlusion min approximates ETH3D's evaluator, which leaves reconstruction points in
space no scanner observed out of the accuracy: each scan gets a range image (--bin
degrees) seen from its scanner (the scan's alignment translation; every ETH3D scan PLY
has view_p = 0); a point behind the scanned surface (+ the largest tolerance) or in a
direction with no return is unobserved by that scan, and an inaccurate point counts
only where some scan observed it. On WebSfM (Full, Medium) it gave courtyard / office /
pipes F1 @2 cm 69.7 / 63.8 / 57.7 against the official evaluator's 74.3 / 62.4 / 53.7,
and pipes accuracy 89.4 % as the official one. Without it, a tool that fills space the
scanner never saw is penalised (courtyard 61.0): compare tools only with --occlusion.

Needs numpy and scipy (the Metashape env, hist_env3, has both).
"""
import argparse, json, re, os
import numpy as np
from scipy.spatial import cKDTree

TYPES = {"float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8", "uchar": "u1", "uint8": "u1",
         "char": "i1", "int8": "i1", "ushort": "<u2", "short": "<i2", "uint": "<u4", "int": "<i4",
         "uint32": "<u4", "int32": "<i4"}


def read_ply_xyz(path):
    with open(path, "rb") as f:
        head = b""
        while not head.endswith(b"end_header\n"):
            line = f.readline()
            if not line:
                raise SystemExit(f"bad ply {path}")
            head += line
        hdr = head.decode("ascii", "replace").splitlines()
        assert "binary_little_endian" in hdr[1] or any("binary_little_endian" in h for h in hdr)
        n = None
        props = []
        cur = None
        for h in hdr:
            p = h.split()
            if not p:
                continue
            if p[0] == "element":
                cur = p[1]
                if cur == "vertex":
                    n = int(p[2])
            elif p[0] == "property" and cur == "vertex":
                if p[1] == "list":
                    raise SystemExit("list property in vertex")
                props.append((p[2], TYPES[p[1]]))
        dt = np.dtype(props)
        a = np.fromfile(f, dtype=dt, count=n)
    return np.stack([a["x"], a["y"], a["z"]], axis=1).astype(np.float64)


def thin(p, cell):
    p = p[np.isfinite(p).all(axis=1)]
    k = np.floor(p / cell).astype(np.int64)
    k -= k.min(axis=0)
    span = k.max(axis=0) + 1
    key = (k[:, 0] * span[1] + k[:, 1]) * span[2] + k[:, 2]
    _, first = np.unique(key, return_index=True)
    return p[np.sort(first)]


ap = argparse.ArgumentParser()
ap.add_argument("--scene", required=True)
ap.add_argument("--recon", required=True)
ap.add_argument("--label")
ap.add_argument("--out")
ap.add_argument("--tolerances", default="0.01,0.02,0.05,0.1,0.2,0.5")
ap.add_argument("--cache", default=os.path.expanduser("~/.cache/websfm-eth3d-gt"))
ap.add_argument("--occlusion", choices=["none", "min", "max"], default="none",
                help="leave out of accuracy the points no scanner observed: per scan a range image "
                     "(--bin degrees) from its origin; a point behind the surface (+ tol) or in an "
                     "empty bin is unobserved by that scan. min/max = the bin's range statistic")
ap.add_argument("--bin", type=float, default=0.1)
a = ap.parse_args()
tols = [float(t) for t in a.tolerances.split(",")]
voxel = min(tols) / 2

os.makedirs(a.cache, exist_ok=True)
cache = os.path.join(a.cache, f"{os.path.basename(a.scene.rstrip('/'))}-{voxel}.npy")
ev = os.path.join(a.scene, "dslr_scan_eval")
mlp = open(os.path.join(ev, "scan_alignment.mlp")).read()
meshes = re.findall(r'<MLMesh[^>]*filename="([^"]+)"[^>]*>\s*<MLMatrix44>([\s\S]*?)</MLMatrix44>', mlp)
def range_image(p, o, bin_deg, stat):
    v = p - o
    r = np.linalg.norm(v, axis=1)
    az = np.degrees(np.arctan2(v[:, 1], v[:, 0])) + 180.0
    el = np.degrees(np.arcsin(np.clip(v[:, 2] / np.maximum(r, 1e-12), -1, 1))) + 90.0
    W, H = int(np.ceil(360 / bin_deg)), int(np.ceil(180 / bin_deg))
    idx = np.minimum((el / bin_deg).astype(np.int64), H - 1) * W + np.minimum((az / bin_deg).astype(np.int64), W - 1)
    img = np.full(W * H, np.nan if stat == "max" else np.inf, dtype=np.float64)
    if stat == "max":
        img = np.full(W * H, -np.inf); np.maximum.at(img, idx, r)
    else:
        np.minimum.at(img, idx, r)
    img[~np.isfinite(img)] = np.nan
    return img, W, H

def observed(q, o, img, W, H, bin_deg, tol):
    v = q - o
    r = np.linalg.norm(v, axis=1)
    az = np.degrees(np.arctan2(v[:, 1], v[:, 0])) + 180.0
    el = np.degrees(np.arcsin(np.clip(v[:, 2] / np.maximum(r, 1e-12), -1, 1))) + 90.0
    idx = np.minimum((el / bin_deg).astype(np.int64), H - 1) * W + np.minimum((az / bin_deg).astype(np.int64), W - 1)
    sr = img[idx]
    return np.isfinite(sr) & (r <= sr + tol)

scans = []
if os.path.exists(cache) and a.occlusion == "none":
    gt = np.load(cache)
    gt_raw = None
else:
    parts = []
    gt_raw = 0
    for fn, M in meshes:
        M = np.array(M.split(), dtype=np.float64).reshape(4, 4)
        p = read_ply_xyz(os.path.join(ev, fn))
        gt_raw += len(p)
        pw = p @ M[:3, :3].T + M[:3, 3]
        if a.occlusion != "none":
            o = M[:3, 3].copy()  # the scanner sits at its scan's origin (view_p = 0)
            scans.append((o, *range_image(pw, o, a.bin, a.occlusion)))
        parts.append(pw)
    if os.path.exists(cache):
        gt = np.load(cache)
    else:
        gt = thin(np.concatenate(parts), voxel)
        np.save(cache, gt)
    del parts

if a.recon.endswith(".bin"):
    rec = np.fromfile(a.recon, dtype="<f4")
    rec = rec[: len(rec) // 3 * 3].reshape(-1, 3).astype(np.float64)
else:
    rec = read_ply_xyz(a.recon)
recN = len(rec)
grow = max(tols)
lo, hi = gt.min(axis=0) - grow, gt.max(axis=0) + grow
rec = rec[((rec >= lo) & (rec <= hi)).all(axis=1)]
nIn = len(rec)
rec = thin(rec, voxel)

dRec, _ = cKDTree(gt).query(rec, k=1, workers=-1)
dGt, _ = cKDTree(rec).query(gt, k=1, workers=-1)
rows = []
obs = None
if scans:
    obs = np.zeros(len(rec), dtype=bool)
    for o, img, W, H in scans:
        obs |= observed(rec, o, img, W, H, a.bin, max(tols))
for t in tols:
    near = dRec <= t
    if obs is not None:
        keep = near | obs  # an accurate point always counts; an inaccurate one only where observed
        acc = float(near[keep].mean()) if keep.any() else 0.0
    else:
        acc = float(near.mean()) if len(dRec) else 0.0
    comp = float((dGt <= t).mean()) if len(dGt) else 0.0
    f1 = 2 * acc * comp / (acc + comp) if acc + comp > 0 else 0.0
    rows.append({"tolerance": t, "accuracy": round(100 * acc, 2), "completeness": round(100 * comp, 2),
                 "f1": round(100 * f1, 2)})
out = {"label": a.label or a.recon, "scene": a.scene, "recon": a.recon,
       "groundTruth": {"scans": len(meshes), "rawPoints": gt_raw, "thinnedPoints": len(gt), "voxel": voxel},
       "reconstruction": {"points": recN, "inScanBox": nIn, "thinnedPoints": len(rec),
                          "observedShare": None if obs is None else round(float(obs.mean()), 4)},
       "occlusion": a.occlusion, "binDeg": a.bin,
       "metric": "approximate ETH3D (no occlusion model; scan-box crop) — python twin of eth3d.mjs", "rows": rows}
print(out["label"] + ": " + " | ".join(f"{r['tolerance']*100:g}cm acc {r['accuracy']}% comp {r['completeness']}% F1 {r['f1']}" for r in rows), flush=True)
if a.out:
    json.dump(out, open(a.out, "w"), indent=2)

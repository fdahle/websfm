"""Tie points side by side (dev/baselines.md ▸ B-decomp): Metashape's (metashape_decomp.py
export) and a WebSfM replay's (the decomposition replay's tie.* dump), and how well the two
tools' keypoints agree on the same photos.

    python metashape-decomp-ties.py ms <export dir> [--json out.json]
    python metashape-decomp-ties.py ws <replay dir> [--json out.json]
    python metashape-decomp-ties.py agree <export dir> <replay dir with allkp.*> [--photos 20]
    python metashape-decomp-ties.py lens <export dir> <replay dir>

Per model: tie points (≥2 views) and the share seen in ≥3 photos, observations per photo
(median), the track length distribution, the reprojection error per observation (RMS,
p95; pixels and in units of the keypoint's own size: Metashape's key point size, WebSfM's
scale, each tool's own definition), the frame coverage (share of a 10 × 10 grid's cells
holding an observation, mean over photos) and the calibration. Metashape's residuals are
in recorded pixels through its own frame model; WebSfM's in its BA frame (the lens taken out,
pixel units of K), which is how each solver sees them.
agree: for a sample of photos, Metashape's tie point projections (pixel centres, −½) against
every WebSfM keypoint of that photo: the share with one within 1 px, and the offset there
(median, p95, mean dx/dy), and that share by Metashape's key point size (bySize).
lens: the image displacement between the two self-calibrated lenses, the same ray through
each (a grid over Metashape's frame, pixel centres): max, corner, RMS, and RMS after the
best scale and shift (what a focal and principal point change can take up).
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np


def ms_load(d):
    d = Path(d)
    model = json.loads((d / "model.json").read_text())
    labels = json.loads((d / "tiepoints-cameras.json").read_text())
    b = (d / "tiepoints.bin").read_bytes()
    nc, npt, npr = struct.unpack_from("<3i", b, 0)
    pts = np.frombuffer(b, dtype=np.dtype([("x", "<f8"), ("y", "<f8"), ("z", "<f8"), ("t", "<i4")]), count=npt, offset=12)
    pr = np.frombuffer(
        b, dtype=np.dtype([("c", "<i4"), ("t", "<i4"), ("x", "<f4"), ("y", "<f4"), ("s", "<f4")]), count=npr, offset=12 + 28 * npt
    )
    return model, labels, pts, pr


def ms_project(cal, T, X):
    """Metashape frame model: internal-frame points → recorded pixels (pixel edges)."""
    R = T[:3, :3]
    C = T[:3, 3]
    p = (X - C) @ R  # camera frame (R columns = camera axes)
    x, y = p[:, 0] / p[:, 2], p[:, 1] / p[:, 2]
    r2 = x * x + y * y
    rad = 1 + cal["k1"] * r2 + cal["k2"] * r2**2 + cal["k3"] * r2**3 + cal.get("k4", 0) * r2**4
    xd = x * rad + cal["p1"] * (r2 + 2 * x * x) + 2 * cal["p2"] * x * y
    yd = y * rad + cal["p2"] * (r2 + 2 * y * y) + 2 * cal["p1"] * x * y
    W, H = cal["width"], cal["height"]
    return W / 2 + cal["cx"] + xd * (cal["f"] + cal["b1"]) + yd * cal["b2"], H / 2 + cal["cy"] + yd * cal["f"]


def stats(npts_views, per_cam_count, res, res_size, cov, W, H):
    tl = np.asarray(npts_views)
    hist = {str(k): int((tl == k).sum()) for k in range(2, 10)}
    hist["10+"] = int((tl >= 10).sum())
    return {
        "points": int(len(tl)),
        "share3plus": round(float((tl >= 3).mean()), 4),
        "meanTrack": round(float(tl.mean()), 3),
        "trackHist": hist,
        "obs": int(len(res)),
        "obsPerPhotoMedian": float(np.median(per_cam_count)),
        "reprojRmsPx": round(float(np.sqrt(np.mean(res**2))), 4),
        "reprojP95Px": round(float(np.percentile(res, 95)), 4),
        "reprojMedianPx": round(float(np.median(res)), 4),
        "reprojRmsSize": round(float(np.sqrt(np.mean(res_size**2))), 4),
        "reprojP95Size": round(float(np.percentile(res_size, 95)), 4),
        "coverage10x10": round(float(np.mean(cov)), 4),
    }


def coverage(cam, x, y, ncam, W, H):
    gx = np.clip((x / W * 10).astype(int), 0, 9)
    gy = np.clip((y / H * 10).astype(int), 0, 9)
    cell = cam.astype(np.int64) * 100 + gy * 10 + gx
    u = np.unique(cell)
    per = np.bincount((u // 100).astype(int), minlength=ncam)
    return per / 100.0


def ms_stats(d):
    model, labels, pts, pr = ms_load(d)
    cal = model["calibration"]
    W, H = cal["width"], cal["height"]
    idx = {int(t): i for i, t in enumerate(pts["t"])}
    pi = np.array([idx[int(t)] for t in pr["t"]])
    X = np.stack([pts["x"], pts["y"], pts["z"]], 1)[pi]
    res = np.empty(len(pr))
    for ci, lab in enumerate(labels):
        m = pr["c"] == ci
        T = np.array(model["cameras"][lab]).reshape(4, 4)
        u, v = ms_project(cal, T, X[m])
        res[m] = np.hypot(u - pr["x"][m], v - pr["y"][m])
    views = np.bincount(pi, minlength=len(pts))
    keep = views >= 2
    obs_keep = keep[pi]
    per_cam = np.bincount(pr["c"][obs_keep], minlength=len(labels))
    cov = coverage(pr["c"][obs_keep], pr["x"][obs_keep], pr["y"][obs_keep], len(labels), W, H)
    out = stats(views[keep], per_cam, res[obs_keep], res[obs_keep] / pr["s"][obs_keep], cov, W, H)
    out["sizeMedian"] = float(np.median(pr["s"]))
    out["calibration"] = cal
    out["sigma"] = model.get("sigma")
    return out


def ws_stats(d):
    d = Path(d)
    model = json.loads((d / "model.json").read_text())
    rd = lambda n, t: np.fromfile(d / n, dtype=t)
    pos = rd("tie.pos.f64", "<f8").reshape(-1, 3)
    vcount = rd("tie.vcount.u32", "<u4")
    vcam = rd("tie.vcam.u32", "<u4")
    vx, vy = rd("tie.vx.f32", "<f4"), rd("tie.vy.f32", "<f4")
    stems = model["camStems"]
    pi = np.repeat(np.arange(len(vcount)), vcount)
    res = np.full(len(vcam), np.nan)
    for ci, s in enumerate(stems):
        m = vcam == ci
        c = model["cameras"].get(s)
        if c is None or not m.any():
            continue
        R, t, K = np.array(c["R"]), np.array(c["t"]), c["K"]
        p = pos[pi[m]] @ R.T + t
        rs = c.get("rs")
        if rs and rs.get("h"):
            # Rolling shutter as bundle adjustment models it (geometry.js rowCamera): the
            # camera moved by τ·s·v at the observation's own row, s = (row − cy)/h.
            k = rs["tau"] * (vy[m].astype(float) - K["cy"]) / rs["h"]
            p = p - k[:, None] * (R @ np.array(rs["v"]))[None, :]
        u = K["fx"] * p[:, 0] / p[:, 2] + K["cx"]
        v = K["fy"] * p[:, 1] / p[:, 2] + K["cy"]
        res[m] = np.hypot(u - vx[m], v - vy[m])
    ok = np.isfinite(res)
    W, H = 6000, 4000
    if (d / "tie.kx.f64").exists():
        kx, ky, ks = rd("tie.kx.f64", "<f8"), rd("tie.ky.f64", "<f8"), rd("tie.ks.f32", "<f4")
    else:
        kx, ky, ks = vx.astype(float), vy.astype(float), np.ones(len(vx), np.float32)
    per_cam = np.bincount(vcam[ok], minlength=len(stems))
    cov = coverage(vcam[ok], kx[ok], ky[ok], len(stems), W, H)
    size = np.where(ks[ok] > 0, ks[ok], np.nan)
    out = stats(vcount, per_cam, res[ok], res[ok] / size, cov, W, H)
    out["reprojRmsSize"] = round(float(np.sqrt(np.nanmean((res[ok] / size) ** 2))), 4)
    out["reprojP95Size"] = round(float(np.nanpercentile(res[ok] / size, 95)), 4)
    out["sizeMedian"] = float(np.nanmedian(size))
    any_cam = next(iter(model["cameras"].values()))
    out["K"] = any_cam["K"]
    out["dist"] = any_cam.get("dist")
    out["selfCal"] = any_cam.get("selfCal")
    out["intrinsics"] = model.get("intrinsics")
    return out


def agree(msd, wsd, nphotos=20):
    from scipy.spatial import cKDTree

    model, labels, pts, pr = ms_load(msd)
    wsd = Path(wsd)
    meta = json.loads((wsd / "allkp.json").read_text())
    xy = np.fromfile(wsd / "allkp.xy.f64", "<f8").reshape(-1, 2)
    sc = np.fromfile(wsd / "allkp.s.f32", "<f4")
    start = np.concatenate([[0], np.cumsum(meta["counts"])])
    where = {n: i for i, n in enumerate(meta["names"])}
    pick = np.linspace(0, len(labels) - 1, nphotos).astype(int)
    rows, allo, alld, allsz, allhit = [], [], [], [], []
    for ci in pick:
        s = labels[ci].rsplit(".", 1)[0].lower()
        j = where[s]
        k = xy[start[j] : start[j + 1]]
        m = pr["c"] == ci
        q = np.stack([pr["x"][m] - 0.5, pr["y"][m] - 0.5], 1)
        dist, nn = cKDTree(k).query(q)
        hit = dist <= 1.0
        allsz.append(pr["s"][m])
        allhit.append(hit)
        d = q[hit] - k[nn[hit]]
        alld.append(d)
        allo.append(dist[hit])
        rows.append({"photo": s, "msTies": int(m.sum()), "wsKeypoints": int(len(k)), "within1px": round(float(hit.mean()), 4)})
    d = np.concatenate(alld)
    o = np.concatenate(allo)
    tot_ms = sum(r["msTies"] for r in rows)
    sz, hits = np.concatenate(allsz), np.concatenate(allhit)
    edges = [0, 2, 3, 4.6, 8, np.inf]
    by_size = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (sz >= lo) & (sz < hi)
        by_size.append({"size": f"{lo}-{hi}", "msTies": int(m.sum()), "share": round(float(m.mean()), 4),
                        "within1px": round(float(hits[m].mean()), 4) if m.any() else None})
    return {
        "photos": len(rows),
        "msTies": tot_ms,
        "wsKeypointsPerPhoto": float(np.mean([r["wsKeypoints"] for r in rows])),
        "within1pxShare": round(float(len(o) / tot_ms), 4),
        "offsetMedianPx": round(float(np.median(o)), 4),
        "offsetP95Px": round(float(np.percentile(o, 95)), 4),
        "meanDxDy": [round(float(d[:, 0].mean()), 4), round(float(d[:, 1].mean()), 4)],
        "wsScaleMedian": float(np.median(sc)),
        "bySize": by_size,
        "rows": rows,
    }


def lens(msd, wsd):
    """Same ray through Metashape's lens and WebSfM's: the displacement in pixels."""
    cal = json.loads((Path(msd) / "model.json").read_text())["calibration"]
    ws = json.loads((Path(wsd) / "model.json").read_text())
    c = next(iter(ws["cameras"].values()))
    K, dist = c["K"], c.get("dist") or {}
    W, H = cal["width"], cal["height"]
    u, v = np.meshgrid(np.linspace(0, W - 1, 121), np.linspace(0, H - 1, 81))
    u, v = u.ravel(), v.ravel()

    def ms_dist(x, y):
        r2 = x * x + y * y
        rad = 1 + cal["k1"] * r2 + cal["k2"] * r2**2 + cal["k3"] * r2**3 + cal.get("k4", 0) * r2**4
        return x * rad + cal["p1"] * (r2 + 2 * x * x) + 2 * cal["p2"] * x * y, y * rad + cal["p2"] * (r2 + 2 * y * y) + 2 * cal["p1"] * x * y

    # Metashape pixel centre → its normalised ray (fixed-point inversion of the distortion).
    xd = (u + 0.5 - W / 2 - cal["cx"]) / cal["f"]
    yd = (v + 0.5 - H / 2 - cal["cy"]) / cal["f"]
    x, y = xd.copy(), yd.copy()
    for _ in range(50):
        dx, dy = ms_dist(x, y)
        x, y = x + (xd - dx), y + (yd - dy)
    # The same ray through WebSfM's lens (OpenCV order: its p1/p2 are Metashape's exchanged).
    r2 = x * x + y * y
    k1, k2, k3, p1, p2 = (dist.get(k, 0) for k in ("k1", "k2", "k3", "p1", "p2"))
    rad = 1 + k1 * r2 + k2 * r2**2 + k3 * r2**3
    wx = x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
    wy = y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    wu, wv = K["fx"] * wx + K["cx"], K["fy"] * wy + K["cy"]
    d = np.hypot(wu - u, wv - v)
    corner = (u == 0) & (v == 0) | (u == W - 1) & (v == H - 1) | (u == 0) & (v == H - 1) | (u == W - 1) & (v == 0)
    # Best scale about the centre and shift (a focal and principal point change).
    A = np.zeros((2 * len(u), 3))
    A[0::2, 0], A[1::2, 0] = u - W / 2, v - H / 2
    A[0::2, 1], A[1::2, 2] = 1, 1
    b = np.empty(2 * len(u))
    b[0::2], b[1::2] = wu - u, wv - v
    sol = np.linalg.lstsq(A, b, rcond=None)[0]
    r = (b - A @ sol).reshape(-1, 2)
    return {
        "maxPx": round(float(d.max()), 3),
        "cornerMeanPx": round(float(d[corner].mean()), 3),
        "rmsPx": round(float(np.sqrt((d**2).mean())), 3),
        "rmsAfterScaleShiftPx": round(float(np.sqrt((r**2).sum(1).mean())), 3),
        "ws": {"f": K["fx"], "cx": K["cx"], "cy": K["cy"], **dist},
        "ms": {k: cal[k] for k in ("f", "cx", "cy", "k1", "k2", "k3", "p1", "p2")},
    }


def main():
    a = sys.argv[1:]
    out_json = None
    if "--json" in a:
        i = a.index("--json")
        out_json = a[i + 1]
        del a[i : i + 2]
    nph = 20
    if "--photos" in a:
        i = a.index("--photos")
        nph = int(a[i + 1])
        del a[i : i + 2]
    if a[0] == "ms":
        r = ms_stats(a[1])
    elif a[0] == "ws":
        r = ws_stats(a[1])
    elif a[0] == "lens":
        r = lens(a[1], a[2])
    else:
        r = agree(a[1], a[2], nph)
    text = json.dumps(r, indent=1)
    if out_json:
        Path(out_json).write_text(text)
    print(text)


if __name__ == "__main__":
    main()

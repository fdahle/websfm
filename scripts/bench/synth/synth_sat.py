"""Synthetic satellite frame-camera blocks with known truth (dev/planning/plan-satellite.md ▸ SAT-0).

Renders a strip of frame-camera scans of a fractal terrain on the WGS84 ellipsoid, the
way a KH-9 mapping camera saw it (304.8 mm, 46 x 23 cm film, ~170 km), and writes the
inputs in the Grenoble benchmark layout, so histSetup.mjs / run-bench.mjs / score_dem.py
run on it unchanged:

    <out>/images/S01.tif ...                  gray uint8 scans, tiled + deflate (BigTIFF if needed)
    <out>/camera_model_intrinsics.csv         focal_length, pixel_pitch, principal_point_*_mm
    <out>/gcp.csv                             gcp_label, image_file_name, x, y (pixel-edge), x_map, y_map, elev, *_acc
    <out>/truth.json                          config, per-image pose (ECEF + projected), GSD, render stats
    <out>/truth_dem.tif                       the rendered surface in the projected CRS (ellipsoidal heights)
    <out>/bench.json                          a bench config for this block (detect … dem)

    python synth_sat.py <out> [--pitch-mm 0.056] [--frames 6] [--seed 1] [--reseau-mm 10] ...

Geometry is exact on the ellipsoid: every pixel's ray is intersected with the terrain
(ellipsoidal height = DEM(lat, lon), bilinear) in ECEF, so Earth curvature (> 1 km
across a frame) is in the images as it is in real ones. The camera: x right, y down,
z forward; film mm x right, y up; pixel-edge coordinates u = W/2 + x_mm / pitch,
v = H/2 - y_mm / pitch. No lens distortion, no occlusion (moderate relief).

Film (SAT-5): `--film-warp-um` deforms each frame's film by a smooth, non-affine field
(sine and quadratic terms, its own phases per frame): a point exposed at film position p
is scanned at q = p + d(p). `--scan-rot-deg` / `--scan-shift-px` place each frame on the
scanner (a rotation and shift, up to the given size, random per frame). The reseau
crosses are exposed at their nominal positions and deform with the film; the GCP
observations go through the same chain. truth.json records each frame's `film`.

Halves (SAT-5): `--halves MM` scans each frame in two overlapping parts, `<name>_a.tif`
(the left part of the film) and `<name>_b.tif` (the right), overlapping by MM in the
middle and each with a margin round the film, as the KH-9 archive scans are. The film's
deformation belongs to the exposure; each half has its own scanner placement. Outside
the film the scan is dark. truth.json lists every scan under `scans`.

The texture is procedural and evaluated at the ground point (hashed value noise down to
2 nadir GSD, Voronoi fields with darker boundaries, hillshade), so images of any size
need no texture raster and different scans of the same ground agree. Deterministic per
seed. Rendering runs in row strips across all cores; a 130 MP frame takes ~1 min.
"""
import argparse
import json
import math
import os
import time
from multiprocessing import get_context

import cv2
import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

A = 6378137.0
E2 = 0.00669437999014
B = A * math.sqrt(1 - E2)
EP2 = (A * A - B * B) / (B * B)

# ── ellipsoid ───────────────────────────────────────────────────────────────


def geodetic_to_ecef(lat, lon, h):
    sl, cl = np.sin(lat), np.cos(lat)
    n = A / np.sqrt(1 - E2 * sl * sl)
    return np.stack([(n + h) * cl * np.cos(lon), (n + h) * cl * np.sin(lon), (n * (1 - E2) + h) * sl], axis=-1)


def ecef_to_geodetic(x, y, z):
    # Bowring (1976): sub-mm for points near the surface.
    p = np.hypot(x, y)
    th = np.arctan2(z * A, p * B)
    st, ct = np.sin(th), np.cos(th)
    lat = np.arctan2(z + EP2 * B * st ** 3, p - E2 * A * ct ** 3)
    sl = np.sin(lat)
    n = A / np.sqrt(1 - E2 * sl * sl)
    h = p / np.cos(lat) - n
    return lat, np.arctan2(y, x), h


def enu_axes(lat, lon):
    sl, cl, so, co = math.sin(lat), math.cos(lat), math.sin(lon), math.cos(lon)
    east = np.array([-so, co, 0.0])
    north = np.array([-sl * co, -sl * so, cl])
    up = np.array([cl * co, cl * so, sl])
    return east, north, up


def rot_xyz(rx, ry, rz):
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx

# ── hashed noise ────────────────────────────────────────────────────────────


M1, M2, M3 = np.uint64(0x9E3779B97F4A7C15), np.uint64(0xC2B2AE3D27D4EB4F), np.uint64(0xFF51AFD7ED558CCD)
S33 = np.uint64(33)


def hash01(ix, iy, seed):
    """Uniform [0, 1) per integer lattice point (splitmix-style, wraps mod 2^64)."""
    with np.errstate(over='ignore'):
        h = ix.astype(np.uint64) * M1 ^ iy.astype(np.uint64) * M2 ^ np.uint64((seed * 0x165667B1) & 0xFFFFFFFF) * M3
        h ^= h >> S33
        h *= M3
        h ^= h >> S33
        h *= M2
        h ^= h >> S33
    return (h >> np.uint64(11)).astype(np.float64) * (1.0 / 2 ** 53)


def value_noise(x, y, seed):
    ix, iy = np.floor(x), np.floor(y)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    ix, iy = ix.astype(np.int64), iy.astype(np.int64)
    a, b = hash01(ix, iy, seed), hash01(ix + 1, iy, seed)
    c, d = hash01(ix, iy + 1, seed), hash01(ix + 1, iy + 1, seed)
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy


def voronoi(x, y, seed):
    """Nearest and second-nearest jittered-grid seed distances (cell units) and the nearest cell's id hash."""
    ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    f1 = np.full(x.shape, 9.0)
    f2 = np.full(x.shape, 9.0)
    idv = np.zeros(x.shape)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cx, cy = ix + dx, iy + dy
            px = cx + hash01(cx, cy, seed)
            py = cy + hash01(cx, cy, seed + 7)
            d = np.hypot(px - x, py - y)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            idv = np.where(closer, hash01(cx, cy, seed + 13), idv)
            f1 = np.where(closer, d, f1)
    return f1, f2, idv

# ── terrain ─────────────────────────────────────────────────────────────────


def fractal_dem(rows, cols, spacing, relief, base, seed, beta=3.4):
    """Spectral-synthesis terrain (power ∝ k^-beta), scaled so its 1–99 % range is `relief`."""
    rng = np.random.default_rng(seed)
    ky = np.fft.fftfreq(rows)[:, None]
    kx = np.fft.rfftfreq(cols)[None, :]
    k = np.hypot(kx, ky)
    k[0, 0] = 1
    amp = k ** (-beta / 2)
    amp[0, 0] = 0
    # Nothing above ~60 km wavelength: relief, not a continent.
    amp *= 1 - np.exp(-(k * 60000.0 / spacing) ** 2)
    spec = amp * (rng.standard_normal(amp.shape) + 1j * rng.standard_normal(amp.shape))
    z = np.fft.irfft2(spec, s=(rows, cols)).astype(np.float32)
    lo, hi = np.percentile(z[::7, ::7], [1, 99])
    return (base + (z - lo) / (hi - lo) * relief).astype(np.float32)


def hillshade(dem, dx, dy, az_deg=135.0, el_deg=40.0):
    gy, gx = np.gradient(dem.astype(np.float64), dy, dx)  # row axis = south (lat descending)
    gy = -gy  # dz/dnorth
    az, el = math.radians(az_deg), math.radians(el_deg)
    sun = np.array([math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)])
    n = np.stack([-gx, -gy, np.ones_like(gx)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return np.clip(n @ sun, 0, 1).astype(np.float32)

# ── rendering ───────────────────────────────────────────────────────────────


G = {}  # the per-process scene (DEM, shade, grid), set before the pool forks


def dem_sample(arr, lat, lon):
    """Bilinear sample of a terrain-grid raster at lat/lon (exact weights; cv2.remap
    quantises them to 1/32 cell and caps arrays at 32k)."""
    g = G['grid']
    col = np.clip((lon - g['lon0']) / g['dlon'], 0, arr.shape[1] - 1.001)
    row = np.clip((g['lat0'] - lat) / g['dlat'], 0, arr.shape[0] - 1.001)
    c0, r0 = col.astype(np.int64), row.astype(np.int64)
    fc, fr = col - c0, row - r0
    flat, w = arr.ravel(), arr.shape[1]
    i = r0 * w + c0
    top = flat[i] * (1 - fc) + flat[i + 1] * fc
    bot = flat[i + w] * (1 - fc) + flat[i + w + 1] * fc
    return top * (1 - fr) + bot * fr


def ray_ellipsoid(C, d, h):
    """Ray length to the ellipsoid inflated by `h` (axes a+h, b+h): the near root of the quadratic."""
    ax, bz = A + h, B + h
    w = np.array([1 / ax, 1 / ax, 1 / bz])
    dd, cc = d * w, np.asarray(C) * w
    qa = (dd * dd).sum(-1)
    qb = 2 * (dd * cc).sum(-1)
    qc = (cc * cc).sum() - 1
    return (-qb - np.sqrt(np.maximum(qb * qb - 4 * qa * qc, 0))) / (2 * qa)


def intersect(C, d, t0, iters=40):
    """Ray C + t·d against the terrain; returns lat, lon, h and the last height miss (m).

    Safeguarded Newton: the root is bracketed between the ray's crossings of the
    terrain's highest and lowest heights, and a Newton step that leaves the bracket
    (a grazing ray on a slope facing away, ~1 % of pixels at 37° off-nadir) is replaced
    by bisection, so every pixel lands on the surface. Where a ray crosses the surface
    more than once (occlusion behind a ridge) it lands on one of the crossings.
    """
    shape = d.shape[:-1]
    d = d.reshape(-1, 3)
    lo = ray_ellipsoid(C, d, G['hmax'] + 5.0)  # above the terrain: miss > 0
    hi = ray_ellipsoid(C, d, G['hmin'] - 5.0)  # below: miss < 0
    t = np.clip(ray_ellipsoid(C, d, t0), lo, hi)
    act = np.arange(t.size)  # rays still iterating (most converge in a few steps)
    for _ in range(iters):
        ta, da = t[act], d[act]
        P = C + ta[:, None] * da
        lat, lon, h = ecef_to_geodetic(P[:, 0], P[:, 1], P[:, 2])
        miss = h - dem_sample(G['dem'], lat, lon)
        la, ha = np.where(miss > 0, ta, lo[act]), np.where(miss <= 0, ta, hi[act])
        lo[act], hi[act] = la, ha
        cl = np.cos(lat)
        upd = da[:, 0] * cl * np.cos(lon) + da[:, 1] * cl * np.sin(lon) + da[:, 2] * np.sin(lat)
        tn = ta + miss / np.maximum(-upd, 0.05)
        t[act] = np.where((tn > la) & (tn < ha), tn, 0.5 * (la + ha))
        act = act[np.abs(miss) > 0.005]
        if not act.size:
            break
    P = C + t[:, None] * d
    lat, lon, h = ecef_to_geodetic(P[:, 0], P[:, 1], P[:, 2])
    miss = np.abs(h - dem_sample(G['dem'], lat, lon))
    return lat.reshape(shape), lon.reshape(shape), h.reshape(shape), miss.reshape(shape)


def texture(lat, lon):
    s = G['scene']
    x = (lon - s['lon_c']) * s['m_per_rad_lon']
    y = (lat - s['lat_c']) * s['m_per_rad_lat']
    seed = s['seed']
    # Natural ground: octaves from 8 km down to 2 nadir GSD.
    nat = np.zeros(x.shape)
    wsum = 0.0
    scale, o = 8000.0, 0
    while scale >= s['finest_m']:
        w = (scale / 8000.0) ** 0.3
        nat += w * value_noise(x / scale, y / scale, seed + 101 + o)
        wsum += w
        scale *= 0.5
        o += 1
    nat /= wsum
    nat = 0.5 + (nat - 0.5) * 2.2
    # Fields with darker boundaries (roads, hedges), only where the zone noise says so.
    f1, f2, cell = voronoi(x / 700.0, y / 700.0, seed + 3)
    edge = np.clip(((f2 - f1) * 700.0 - 6.0) / 6.0, 0, 1)
    fields = (0.25 + 0.55 * cell) * (0.55 + 0.45 * edge) + 0.12 * (nat - 0.5)
    zone = np.clip((value_noise(x / 25000.0, y / 25000.0, seed + 5) - 0.45) * 6, 0, 1)
    albedo = np.clip(zone * fields + (1 - zone) * nat, 0.02, 1)
    shade = dem_sample(G['shade'], lat, lon)
    return albedo * (0.35 + 0.65 * shade)


def render_rows(job):
    """One strip [r0, r1) of one scan, plus `pad` rows each side for the blur."""
    fr, r0, r1, pad = job
    s, scan = G['scene'], G['scans'][fr]
    cam = G['cams'][scan['cam']]
    W, H, pitch, f = scan['W'], scan['H'], s['pitch'], s['focal']
    rr0, rr1 = max(0, r0 - pad), min(H, r1 + pad)
    v = np.arange(rr0, rr1) + 0.5
    u = np.arange(W) + 0.5
    U, V = np.meshgrid(u, v)
    xmm, ymm = scan_to_film(scan['film'], s, U, V)
    off_film = (np.abs(xmm) > s['film_w'] / 2) | (np.abs(ymm) > s['film_h'] / 2)
    X, Y = (xmm - s['ppx']) / f, -(ymm - s['ppy']) / f
    dc = np.stack([X, Y, np.ones_like(X)], axis=-1)
    dc /= np.linalg.norm(dc, axis=-1, keepdims=True)
    R = np.array(cam['R'])
    d = (dc @ R).reshape(-1, 3)  # world direction = Rᵀ·dc
    C = np.array(cam['C'])
    # In cache-sized chunks: with every core busy, whole-strip temporaries (tens of
    # 16 MB float64 arrays per step) made the pool memory-bound, ~7× slower in total.
    img = np.empty(d.shape[0])
    miss = np.empty(d.shape[0])
    for c0 in range(0, d.shape[0], 8192):
        lat, lon, _, m = intersect(C, d[c0:c0 + 8192], cam['t0'])
        img[c0:c0 + 8192] = texture(lat, lon)
        miss[c0:c0 + 8192] = m
    img = img.reshape(X.shape) * dc[..., 2] ** 2  # cos² fall-off
    img[off_film] = 0.02  # the dark border round the film
    miss = miss.reshape(X.shape)
    if s['blur'] > 0:
        img = cv2.GaussianBlur(img.astype(np.float32), (0, 0), s['blur'])
    img = img[r0 - rr0: r0 - rr0 + (r1 - r0)]
    rng = np.random.default_rng((s['seed'] * 1000 + fr) * 100000 + r0)
    dn = 255.0 * np.clip(img, 0, 1) ** (1 / 2.2) + rng.normal(0, s['grain'], img.shape)
    core = miss[r0 - rr0: r0 - rr0 + (r1 - r0)]
    return fr, r0, np.clip(dn, 0, 255).astype(np.uint8), (float(core.max()), int((core > 0.5).sum()))


def project(cam, s, P, film):
    """ECEF points (N×3) → film mm, the scan pixel-edge u, v of the scan `film` describes
    (film deformation and scanner placement included), and the depth."""
    Xc = (P - np.array(cam['C'])) @ np.array(cam['R']).T
    xmm = s['ppx'] + s['focal'] * Xc[:, 0] / Xc[:, 2]
    ymm = s['ppy'] - s['focal'] * Xc[:, 1] / Xc[:, 2]
    u, v = film_to_scan(film, s, xmm, ymm)
    return xmm, ymm, u, v, Xc[:, 2]


def film_warp(film, s, x, y):
    """The film's deformation d(p) (mm) at exposed film position p = (x, y) mm."""
    if not film or film['amp_mm'] == 0:
        return np.zeros_like(x), np.zeros_like(y)
    A, (p0, p1) = film['amp_mm'], film['phase']
    u, v = x / (s['film_w'] / 2), y / (s['film_h'] / 2)
    dx = A * (0.6 * np.sin(np.pi * u + p0) * np.cos(0.5 * np.pi * v) + 0.4 * u * v)
    dy = A * (0.6 * np.cos(0.5 * np.pi * u) * np.sin(np.pi * v + p1) + 0.3 * (u * u - 1 / 3))
    return dx, dy


def scan_origin(film, s):
    """The scan pixel (pixel-edge) of the film's centre before the placement shift."""
    return (film.get('cu', s['W'] / 2), film.get('cv', s['H'] / 2)) if film else (s['W'] / 2, s['H'] / 2)


def film_to_scan(film, s, x, y):
    """Exposed film mm → scan pixel-edge u, v: deform, then place on the scanner."""
    dx, dy = film_warp(film, s, x, y)
    qx, qy = x + dx, y + dy
    th = math.radians(film['rot_deg']) if film else 0.0
    sx, sy = film['shift_px'] if film else (0.0, 0.0)
    cu, cv = scan_origin(film, s)
    xr, yr = math.cos(th) * qx - math.sin(th) * qy, math.sin(th) * qx + math.cos(th) * qy
    return cu + sx + xr / s['pitch'], cv + sy - yr / s['pitch']


def scan_to_film(film, s, u, v):
    """Scan pixel-edge u, v → the film position exposed there (inverts film_to_scan)."""
    th = math.radians(film['rot_deg']) if film else 0.0
    sx, sy = film['shift_px'] if film else (0.0, 0.0)
    cu, cv = scan_origin(film, s)
    xr, yr = (u - cu - sx) * s['pitch'], -(v - cv - sy) * s['pitch']
    qx, qy = math.cos(th) * xr + math.sin(th) * yr, -math.sin(th) * xr + math.cos(th) * yr
    x, y = qx, qy
    for _ in range(4):  # p = q − d(p); |∂d/∂p| ≪ 1, so this converges at once
        dx, dy = film_warp(film, s, x, y)
        x, y = qx - dx, qy - dy
    return x, y


def draw_reseau(img, s, spacing_mm, film=None, arm_mm=0.5, width_mm=0.03):
    """Black crosses on a regular film grid centred on the frame (KH-9 MC: 1 cm), exposed at
    their nominal positions and moved with the film."""
    p = s['pitch']
    arm = max(2, round(arm_mm / p))
    th = max(1, round(width_mm / p))
    n = 0
    for gx in np.arange(-math.floor(s['film_w'] / 2 / spacing_mm), math.floor(s['film_w'] / 2 / spacing_mm) + 1) * spacing_mm:
        for gy in np.arange(-math.floor(s['film_h'] / 2 / spacing_mm), math.floor(s['film_h'] / 2 / spacing_mm) + 1) * spacing_mm:
            fu, fv = film_to_scan(film, s, np.float64(gx), np.float64(gy))
            # Sub-pixel centres: draw at 16× and let the line rasteriser place them. cv2
            # takes pixel-index coordinates (integer = pixel centre): pixel-edge − ½.
            u, v = int(round((float(fu) - 0.5) * 16)), int(round((float(fv) - 0.5) * 16))
            cv2.line(img, (u - arm * 16, v), (u + arm * 16, v), 10, th, lineType=cv2.LINE_AA, shift=4)
            cv2.line(img, (u, v - arm * 16), (u, v + arm * 16), 10, th, lineType=cv2.LINE_AA, shift=4)
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--pitch-mm', type=float, default=0.056, help='scan pitch (KH-9 MC native 0.007)')
    ap.add_argument('--focal-mm', type=float, default=304.8)
    ap.add_argument('--film-w-mm', type=float, default=460.0, help='across track')
    ap.add_argument('--film-h-mm', type=float, default=230.0, help='along track')
    ap.add_argument('--pp-mm', type=float, nargs=2, default=[0.02, -0.03], help='principal point offset, y up')
    ap.add_argument('--altitude-m', type=float, default=170000.0)
    ap.add_argument('--frames', type=int, default=6)
    ap.add_argument('--overlap', type=float, default=0.7, help='along-track forward overlap')
    ap.add_argument('--attitude-deg', type=float, default=0.4, help='attitude noise (1 sigma) per axis')
    ap.add_argument('--lat', type=float, default=33.0)
    ap.add_argument('--lon', type=float, default=-111.6)
    ap.add_argument('--crs', default='EPSG:32612')
    ap.add_argument('--relief-m', type=float, default=1500.0)
    ap.add_argument('--base-m', type=float, default=400.0)
    ap.add_argument('--dem-spacing-m', type=float, default=30.0)
    ap.add_argument('--reseau-mm', type=float, default=0.0, help='reseau cross spacing (KH-9 MC 10); 0 = none')
    ap.add_argument('--film-warp-um', type=float, default=0.0, help='film deformation amplitude (µm); 0 = none')
    ap.add_argument('--scan-rot-deg', type=float, default=0.0, help='scanner placement rotation, up to ± this per frame')
    ap.add_argument('--scan-shift-px', type=float, default=0.0, help='scanner placement shift, up to ± this per axis')
    ap.add_argument('--halves', type=float, default=0.0, help='scan each frame in two halves overlapping by this (mm); 0 = whole')
    ap.add_argument('--margin-mm', type=float, default=4.0, help='scan margin round the film, for --halves')
    ap.add_argument('--gcps', type=int, default=48)
    ap.add_argument('--gcp-noise-px', type=float, default=0.0)
    ap.add_argument('--gcp-acc-m', type=float, default=2.0)
    ap.add_argument('--blur-px', type=float, default=0.6)
    ap.add_argument('--grain-dn', type=float, default=2.0)
    ap.add_argument('--strip-px', type=int, default=2_000_000, help='pixels per render job')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 2))
    a = ap.parse_args()
    t_start = time.time()
    os.makedirs(os.path.join(a.out, 'images'), exist_ok=True)

    W = int(round(a.film_w_mm / a.pitch_mm))
    H = int(round(a.film_h_mm / a.pitch_mm))
    lat0, lon0 = math.radians(a.lat), math.radians(a.lon)
    m_lat = A * (1 - E2) / (1 - E2 * math.sin(lat0) ** 2) ** 1.5  # meridian radius
    m_lon = A / math.sqrt(1 - E2 * math.sin(lat0) ** 2) * math.cos(lat0)
    rng = np.random.default_rng(a.seed)

    # Cameras: nadir points along the meridian, the image top facing north.
    along = a.film_h_mm / a.focal_mm * (a.altitude_m - a.base_m)
    base = (1 - a.overlap) * along
    cams = []
    for i in range(a.frames):
        lat = lat0 + (i - (a.frames - 1) / 2) * base / m_lat
        east, north, up = enu_axes(lat, lon0)
        R0 = np.stack([east, -north, -up])  # rows: camera x, y, z in ECEF
        Rn = rot_xyz(*np.radians(rng.normal(0, a.attitude_deg, 3)))
        R = Rn @ R0
        C = geodetic_to_ecef(np.float64(lat), np.float64(lon0), np.float64(a.altitude_m))
        cams.append({'name': f'S{i + 1:02d}.tif', 'C': C.tolist(), 'R': R.tolist(), 'lat': math.degrees(lat),
                     'lon': a.lon, 'h': a.altitude_m, 't0': a.base_m + a.relief_m / 2})
    # Film deformation + scanner placement per frame, from their own stream (the GCPs
    # and attitudes of a block without them stay what they were).
    frng = np.random.default_rng(a.seed + 7)
    for cam in cams:
        cam['film'] = {'amp_mm': a.film_warp_um / 1000 * frng.uniform(0.6, 1.0),
                       'phase': frng.uniform(-math.pi, math.pi, 2).tolist(),
                       'rot_deg': a.scan_rot_deg * frng.uniform(-1, 1),
                       'shift_px': (a.scan_shift_px * frng.uniform(-1, 1, 2)).tolist()}
    # The scans: one per frame, or two halves (each its own placement on the scanner).
    scans = []
    for ci, cam in enumerate(cams):
        if a.halves <= 0:
            scans.append({'name': cam['name'], 'cam': ci, 'W': W, 'H': H, 'film': dict(cam['film'], cu=W / 2, cv=H / 2)})
            continue
        m, ov = a.margin_mm, a.halves
        hw = int(round((a.film_w_mm / 2 + ov / 2 + m) / a.pitch_mm))
        hh = int(round((a.film_h_mm + 2 * m) / a.pitch_mm))
        stem = cam['name'].rsplit('.', 1)[0]
        for side, cu in (('a', (a.film_w_mm / 2 + m) / a.pitch_mm), ('b', (ov / 2) / a.pitch_mm)):
            film = {'amp_mm': cam['film']['amp_mm'], 'phase': cam['film']['phase'],
                    'rot_deg': a.scan_rot_deg * frng.uniform(-1, 1),
                    'shift_px': (a.scan_shift_px * frng.uniform(-1, 1, 2)).tolist(),
                    'cu': cu, 'cv': hh / 2}
            scans.append({'name': f'{stem}_{side}.tif', 'cam': ci, 'W': hw, 'H': hh, 'film': film})

    scene = {'W': W, 'H': H, 'pitch': a.pitch_mm, 'focal': a.focal_mm, 'ppx': a.pp_mm[0], 'ppy': a.pp_mm[1],
             'film_w': a.film_w_mm, 'film_h': a.film_h_mm, 'seed': a.seed, 'blur': a.blur_px, 'grain': a.grain_dn,
             'lat_c': lat0, 'lon_c': lon0, 'm_per_rad_lat': m_lat, 'm_per_rad_lon': m_lon}
    gsd = a.pitch_mm / a.focal_mm * (a.altitude_m - a.base_m - a.relief_m / 2)
    scene['finest_m'] = 2 * gsd

    # Terrain grid: the footprints at the base height, plus a margin.
    corners = []
    for cam in cams:
        for (u, v) in [(0, 0), (W, 0), (0, H), (W, H)]:
            xmm, ymm = (u - W / 2) * a.pitch_mm, (H / 2 - v) * a.pitch_mm
            dc = np.array([(xmm - a.pp_mm[0]) / a.focal_mm, -(ymm - a.pp_mm[1]) / a.focal_mm, 1.0])
            d = np.array(cam['R']).T @ (dc / np.linalg.norm(dc))
            t = (a.altitude_m - a.base_m) / max(0.2, -(d @ enu_axes(math.radians(cam['lat']), lon0)[2]))
            la, lo, _ = ecef_to_geodetic(*(np.array(cam['C']) + t * d))
            corners.append((float(la), float(lo)))
    la = np.array([c[0] for c in corners])
    lo = np.array([c[1] for c in corners])
    marg_lat, marg_lon = 0.08 * (la.max() - la.min()), 0.08 * (lo.max() - lo.min())
    dlat, dlon = a.dem_spacing_m / m_lat, a.dem_spacing_m / m_lon
    grid = {'lat0': la.max() + marg_lat, 'lon0': lo.min() - marg_lon, 'dlat': dlat, 'dlon': dlon}
    rows = int(math.ceil((la.max() - la.min() + 2 * marg_lat) / dlat)) + 1
    cols = int(math.ceil((lo.max() - lo.min() + 2 * marg_lon) / dlon)) + 1
    print(f'frames {a.frames} of {W}×{H} px ({W * H / 1e6:.0f} MP), nadir GSD {gsd:.1f} m, base {base / 1000:.1f} km '
          f'(B/H {base / a.altitude_m:.2f}); terrain {rows}×{cols} cells at {a.dem_spacing_m} m', flush=True)
    t0 = time.time()
    dem = fractal_dem(rows, cols, a.dem_spacing_m, a.relief_m, a.base_m, a.seed)
    shade = hillshade(dem, a.dem_spacing_m, a.dem_spacing_m)
    print(f'terrain {time.time() - t0:.0f} s, heights {dem.min():.0f}…{dem.max():.0f} m', flush=True)
    G.update(dem=dem, shade=shade, grid=grid, scene=scene, cams=cams, scans=scans, hmin=float(dem.min()), hmax=float(dem.max()))

    # Render: every scan in row strips, across the pool (fork shares the scene).
    jobs = [(k, r0, min(sc['H'], r0 + max(16, a.strip_px // sc['W'])), 4)
            for k, sc in enumerate(scans) for r0 in range(0, sc['H'], max(16, a.strip_px // sc['W']))]
    imgs = [np.zeros((sc['H'], sc['W']), np.uint8) for sc in scans]
    worst = [0.0] * len(scans)
    bad = 0
    t0 = time.time()
    with get_context('fork').Pool(a.workers) as pool:
        for fr, r0, block, miss in pool.imap_unordered(render_rows, jobs, chunksize=1):
            imgs[fr][r0:r0 + block.shape[0]] = block
            worst[fr] = max(worst[fr], miss[0])
            bad += miss[1]
    print(f'rendered {len(scans)} scans in {time.time() - t0:.0f} s; worst terrain miss {max(worst):.2f} m, '
          f'{bad} px ({bad / sum(sc["W"] * sc["H"] for sc in scans):.2e}) off by > 0.5 m', flush=True)

    reseau = 0
    if a.reseau_mm > 0:
        for sc, img in zip(scans, imgs):
            reseau = draw_reseau(img, scene, a.reseau_mm, sc['film'])
    big = max(sc['W'] * sc['H'] for sc in scans) > 3.5e9
    for sc, img in zip(scans, imgs):
        with rasterio.open(os.path.join(a.out, 'images', sc['name']), 'w', driver='GTiff', width=sc['W'], height=sc['H'], count=1,
                           dtype='uint8', tiled=True, blockxsize=512, blockysize=512, compress='deflate',
                           BIGTIFF='YES' if big else 'IF_SAFER') as dst:
            dst.write(img, 1)

    # GCPs: ground points under random interior pixels, observed wherever they project.
    to_map = Transformer.from_crs('EPSG:4326', a.crs, always_xy=True)
    gcp_rows, gcps = [], []
    for k in range(a.gcps):
        cam = cams[k % a.frames]
        # A film point in the frame's interior (independent of how it was scanned).
        xmm = rng.uniform(-0.42, 0.42) * a.film_w_mm
        ymm = rng.uniform(-0.42, 0.42) * a.film_h_mm
        dc = np.array([(xmm - a.pp_mm[0]) / a.focal_mm, -(ymm - a.pp_mm[1]) / a.focal_mm, 1.0])
        d = (np.array(cam['R']).T @ (dc / np.linalg.norm(dc)))[None, :]
        lat, lon, _, _ = intersect(np.array(cam['C']), d, cam['t0'], iters=20)
        h = dem_sample(dem, lat, lon)
        P = geodetic_to_ecef(lat, lon, h)
        E, N = to_map.transform(math.degrees(lon[0]), math.degrees(lat[0]))
        label = f'G{k + 1:03d}'
        gcps.append({'label': label, 'E': E, 'N': N, 'h': float(h[0]), 'lat': math.degrees(lat[0]), 'lon': math.degrees(lon[0])})
        for sc in scans:
            fx, fy, pu, pv, z = project(cams[sc['cam']], scene, P, sc['film'])
            on_film = abs(fx[0]) <= 0.49 * a.film_w_mm and abs(fy[0]) <= 0.49 * a.film_h_mm
            if z[0] > 0 and on_film and 0.01 * sc['W'] <= pu[0] <= 0.99 * sc['W'] and 0.01 * sc['H'] <= pv[0] <= 0.99 * sc['H']:
                nu, nv = rng.normal(0, a.gcp_noise_px, 2) if a.gcp_noise_px > 0 else (0.0, 0.0)
                gcp_rows.append([label, sc['name'], f'{pu[0] + nu:.3f}', f'{pv[0] + nv:.3f}', f'{E:.3f}', f'{N:.3f}',
                                 f'{h[0]:.3f}', a.gcp_acc_m, a.gcp_acc_m, a.gcp_acc_m])
    with open(os.path.join(a.out, 'gcp.csv'), 'w') as f:
        f.write('gcp_label,image_file_name,x,y,x_map,y_map,elev,x_map_acc,y_map_acc,elev_acc\n')
        for r in gcp_rows:
            f.write(','.join(str(x) for x in r) + '\n')
    with open(os.path.join(a.out, 'camera_model_intrinsics.csv'), 'w') as f:
        f.write('focal_length,pixel_pitch,principal_point_x_mm,principal_point_y_mm\n')
        f.write(f'{a.focal_mm},{a.pitch_mm},{a.pp_mm[0]},{a.pp_mm[1]}\n')

    # Truth DEM in the projected CRS, at the terrain spacing.
    src_tf = from_origin(math.degrees(grid['lon0'] - dlon / 2), math.degrees(grid['lat0'] + dlat / 2), math.degrees(dlon), math.degrees(dlat))
    ex, ey = to_map.transform(*np.degrees(np.array([[grid['lon0'], grid['lon0'] + cols * dlon, grid['lon0'], grid['lon0'] + cols * dlon],
                                                    [grid['lat0'], grid['lat0'], grid['lat0'] - rows * dlat, grid['lat0'] - rows * dlat]])))
    x0, x1, y0, y1 = min(ex), max(ex), min(ey), max(ey)
    sp = a.dem_spacing_m
    dst_w, dst_h = int((x1 - x0) / sp), int((y1 - y0) / sp)
    dst = np.full((dst_h, dst_w), np.nan, np.float32)
    dst_tf = from_origin(x0, y1, sp, sp)
    reproject(dem, dst, src_transform=src_tf, src_crs='EPSG:4326', dst_transform=dst_tf, dst_crs=a.crs,
              resampling=Resampling.bilinear, dst_nodata=np.nan)
    with rasterio.open(os.path.join(a.out, 'truth_dem.tif'), 'w', driver='GTiff', width=dst_w, height=dst_h, count=1,
                       dtype='float32', crs=a.crs, transform=dst_tf, nodata=np.nan, tiled=True, compress='deflate',
                       BIGTIFF='IF_SAFER') as f:
        f.write(dst, 1)

    for cam in cams:
        E, N = to_map.transform(cam['lon'], cam['lat'])
        cam.update(E=E, N=N)
        cam.pop('t0')
    truth = {'config': vars(a), 'W': W, 'H': H, 'gsd_nadir_m': gsd, 'baseline_m': base, 'reseau_crosses': reseau,
             'scans': [{'name': sc['name'], 'camera': cams[sc['cam']]['name'], 'W': sc['W'], 'H': sc['H'], 'film': sc['film']} for sc in scans],
             'worst_terrain_miss_m': max(worst), 'pixels_miss_over_half_m': bad, 'cameras': cams, 'gcps': gcps, 'gcp_observations': len(gcp_rows),
             'seconds': time.time() - t_start}
    with open(os.path.join(a.out, 'truth.json'), 'w') as f:
        json.dump(truth, f, indent=1)
    out = os.path.abspath(a.out)
    bench = {'name': os.path.basename(out), 'images': f'{out}/images', 'sceneType': 'aerial', 'crs': a.crs, 'headed': True,
             'chromeArgs': ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
             'hist': {'intrinsics': f'{out}/camera_model_intrinsics.csv', 'gcps': f'{out}/gcp.csv', 'checkEvery': 4,
                      'refDem': f'{out}/truth_dem.tif'},
             'stages': 'detect,match,recon,depth,dense,dem', 'depth': {'quality': 'high'}, 'dense': {'step': 2},
             'dem': {'crs': 'project', 'gsd': round(4 * gsd, 1)}}
    with open(os.path.join(a.out, 'bench.json'), 'w') as f:
        json.dump(bench, f, indent=2)
    print(f'{len(gcps)} GCPs, {len(gcp_rows)} observations; reseau crosses/frame {reseau}; total {time.time() - t_start:.0f} s')


if __name__ == '__main__':
    main()

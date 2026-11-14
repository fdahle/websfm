# Glossary figures (src/glossary/assets/*.svg), drawn from computed geometry in the style
# of epipolar-geometry.svg (dark ground, its palette): distortion from the Brown radial
# model, uncertainty ellipses from the rays' information matrices, RANSAC by scoring every
# point pair, smoothing by running the passes. Rewrites every figure it knows:
#   python3 scripts/figures/glossary.py src/glossary/assets
# A new figure: a function here, then replace its TODO(image) comment in the entry.
import math, random, sys, os
OUT = sys.argv[1]
BG, FG, GREY, DIM = '#1b1f27', '#c9d1d9', '#9ca3af', '#6b7280'
BLUE, GOLD, RED, GREEN = '#5aa9e6', '#e6b84f', '#ef6f6c', '#7ee787'

def svg(name, w, h, body):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" font-family="sans-serif" font-size="13">\n'
    s += f'  <rect width="{w}" height="{h}" fill="{BG}"/>\n' + body + '</svg>\n'
    open(os.path.join(OUT, name), 'w').write(s)

f2 = lambda v: f'{v:.1f}'.rstrip('0').rstrip('.')
def line(x1, y1, x2, y2, c=FG, w=1.5, dash=None, op=None):
    return f'  <line x1="{f2(x1)}" y1="{f2(y1)}" x2="{f2(x2)}" y2="{f2(y2)}" stroke="{c}" stroke-width="{w}"' + (f' stroke-dasharray="{dash}"' if dash else '') + (f' opacity="{op}"' if op else '') + '/>\n'
def circ(x, y, r, c, fill=True, w=1.5):
    return f'  <circle cx="{f2(x)}" cy="{f2(y)}" r="{f2(r)}" ' + (f'fill="{c}"' if fill else f'fill="none" stroke="{c}" stroke-width="{w}"') + '/>\n'
def text(x, y, t, c=FG, size=None, anchor=None):
    return f'  <text x="{f2(x)}" y="{f2(y)}" fill="{c}"' + (f' font-size="{size}"' if size else '') + (f' text-anchor="{anchor}"' if anchor else '') + f'>{t}</text>\n'
def poly(pts, c, fill='none', w=1.5, op=None, closed=False, dash=None):
    d = ' '.join(f'{f2(x)},{f2(y)}' for x, y in pts)
    tag = 'polygon' if closed else 'polyline'
    return f'  <{tag} points="{d}" fill="{fill}" stroke="{c}" stroke-width="{w}"' + (f' opacity="{op}"' if op else '') + (f' stroke-dasharray="{dash}"' if dash else '') + '/>\n'
def ellipse_pts(cx, cy, cov, k, n=64):
    a, b, c = cov[0][0], cov[0][1], cov[1][1]
    tr, det = a + c, a * c - b * b
    l1 = tr / 2 + math.sqrt(max(tr * tr / 4 - det, 0)); l2 = tr / 2 - math.sqrt(max(tr * tr / 4 - det, 0))
    ang = 0.5 * math.atan2(2 * b, a - c)
    r1, r2 = k * math.sqrt(l1), k * math.sqrt(max(l2, 0))
    return [(cx + r1 * math.cos(t) * math.cos(ang) - r2 * math.sin(t) * math.sin(ang),
             cy + r1 * math.cos(t) * math.sin(ang) + r2 * math.sin(t) * math.cos(ang)) for t in [2 * math.pi * i / n for i in range(n)]]
def cov_from_rays(X, cams, sig):
    # Each ray from camera C to X constrains X across the ray with σ = distance·σθ.
    J = [[0, 0], [0, 0]]
    for C in cams:
        dx, dy = X[0] - C[0], X[1] - C[1]; d = math.hypot(dx, dy)
        nx, ny = -dy / d, dx / d; s2 = (d * sig) ** 2
        J[0][0] += nx * nx / s2; J[0][1] += nx * ny / s2; J[1][1] += ny * ny / s2
    det = J[0][0] * J[1][1] - J[0][1] ** 2
    return [[J[1][1] / det, -J[0][1] / det], [-J[0][1] / det, J[0][0] / det]]
def camera(x, y, c=BLUE, label=None, ldx=-8, ldy=20):
    b = circ(x, y, 6, c)
    return b + (text(x + ldx, y + ldy, label, c) if label else '')

# ── gsd.svg ──────────────────────────────────────────────────────────────────
def gsd():
    W, H, G = 620, 360, 320
    b = line(30, G, 590, G, GREY, 2) + text(560, G + 20, 'ground', GREY, 11)
    for (x, Z, lab, mult) in [(180, 120, 'Z', '1'), (440, 240, '2Z', '2')]:
        ly = G - Z
        th = math.atan(0.42)  # half field of view
        half = Z * math.tan(th)
        b += poly([(x - half, G), (x, ly), (x + half, G)], DIM, w=1, dash='5 4')
        # sensor above the lens (image plane), inverted
        fs = 22; sw = fs * math.tan(th)
        b += line(x - sw, ly - fs, x + sw, ly - fs, FG, 3)
        pu = 0.45  # the traced pixel: a fraction across the half width
        a0, a1 = math.atan(pu * math.tan(th)), math.atan((pu + 0.12) * math.tan(th))
        # rays from the pixel's two edges through the lens to the ground
        for a in (a0, a1):
            b += line(x - fs * math.tan(a), ly - fs, x + Z * math.tan(a), G, GOLD, 1)
        g0, g1 = x + Z * math.tan(a0), x + Z * math.tan(a1)
        b += f'  <rect x="{f2(g0)}" y="{G - 4}" width="{f2(g1 - g0)}" height="8" fill="{GOLD}" opacity="0.85"/>\n'
        b += camera(x, ly)
        b += line(x - half - 18, G, x - half - 18, ly, GREY, 1) + line(x - half - 24, ly, x - half - 12, ly, GREY, 1)
        b += text(x - half - 46, (G + ly) / 2 + 4, lab, GREY)
        b += text((g0 + g1) / 2, G + 22, 'GSD' if mult == '1' else '2 × GSD', GOLD, 12, 'middle')
        b += text(x + sw + 6, ly - fs + 4, 'sensor', GREY, 11)
    b += text(30, 32, 'GSD = Z / f_px', FG, 15)
    b += text(30, 52, 'one pixel covers more ground', GREY, 11)
    b += text(30, 67, 'the higher the camera flies', GREY, 11)
    svg('gsd.svg', W, H, b)

# ── lens-distortion.svg ──────────────────────────────────────────────────────
def lens():
    W, H = 640, 260
    b = ''
    panels = [('undistorted', 0.0), ('barrel (k1 < 0)', -0.18), ('pincushion (k1 > 0)', 0.10)]
    for pi, (lab, k1) in enumerate(panels):
        cx, cy, R = 110 + pi * 210, 120, 80
        maxr = math.sqrt(2) * (1 + k1 * 2) if k1 > 0 else 1.0
        sc = R / max(maxr, 1.0)
        def dist(x, y):
            r2 = x * x + y * y; f = 1 + k1 * r2
            return cx + sc * x * f, cy + sc * y * f
        n = 6
        for i in range(n + 1):
            u = -1 + 2 * i / n
            b += poly([dist(u, -1 + 2 * j / 60) for j in range(61)], BLUE, w=1.2)
            b += poly([dist(-1 + 2 * j / 60, u) for j in range(61)], BLUE, w=1.2)
        if k1 < 0:  # the displacement field: ideal node → distorted node
            for i in range(n + 1):
                for j in range(n + 1):
                    x, y = -1 + 2 * i / n, -1 + 2 * j / n
                    x0, y0 = cx + sc * x, cy + sc * y
                    x1, y1 = dist(x, y)
                    if math.hypot(x1 - x0, y1 - y0) > 2:
                        b += line(x0, y0, x1, y1, GOLD, 1.2)
                        b += circ(x1, y1, 1.8, GOLD)
        b += circ(cx, cy, 3, RED)
        b += text(cx, 238, lab, FG, 13, 'middle')
    b += text(320, 22, 'x_d = x · (1 + k1·r²): the shift grows with distance r from the principal point (red)', GREY, 11, 'middle')
    svg('lens-distortion.svg', W, H, b)

# ── baseline-parallax.svg ─────────────────────────────────────────────────────
def baseline():
    W, H = 640, 300
    b = ''
    for pi, (lab, half, sub) in enumerate([('wide baseline', 120, 'rays cross sharply: depth well fixed'),
                                           ('narrow baseline', 22, 'near-parallel rays: depth smeared along the view')]):
        ox = 160 + pi * 320
        X = (ox, 70); cams = [(ox - half, 250), (ox + half, 250)]
        for C in cams:
            b += line(C[0], C[1], X[0] + (X[0] - C[0]) * 0.1, X[1] + (X[1] - C[1]) * 0.1, BLUE, 1.2)
            b += camera(*C)
        b += line(cams[0][0], 250, cams[1][0], 250, DIM, 1.2, '5 4')
        cov = cov_from_rays(X, cams, 0.03)
        b += poly(ellipse_pts(X[0], X[1], cov, 1.0), GOLD, fill=GOLD, w=1.2, op=0.45, closed=True)
        b += circ(X[0], X[1], 3, GOLD)
        b += text(ox, 282, lab, FG, 13, 'middle') + text(ox, 22, sub, GREY, 11, 'middle')
    svg('baseline-parallax.svg', W, H, b)

# ── ransac.svg ───────────────────────────────────────────────────────────────
def ransac():
    W, H = 620, 330
    rnd = random.Random(4)
    inl = [(x, 0.55 * x + 40 + rnd.gauss(0, 6)) for x in [rnd.uniform(20, 520) for _ in range(32)]]
    out = [(rnd.uniform(300, 540), rnd.uniform(230, 290)) for _ in range(9)] + [(rnd.uniform(40, 200), rnd.uniform(200, 280)) for _ in range(3)]
    pts = inl + out
    def fit(ps):
        n = len(ps); mx = sum(p[0] for p in ps) / n; my = sum(p[1] for p in ps) / n
        sxx = sum((p[0] - mx) ** 2 for p in ps); sxy = sum((p[0] - mx) * (p[1] - my) for p in ps)
        m = sxy / sxx; return m, my - m * mx
    ls = fit(pts)
    tau = 14
    best = None
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            (x1, y1), (x2, y2) = pts[i], pts[j]
            if abs(x2 - x1) < 40: continue
            m = (y2 - y1) / (x2 - x1); c = y1 - m * x1
            s = [p for p in pts if abs(p[1] - (m * p[0] + c)) / math.hypot(1, m) < tau]
            if best is None or len(s) > len(best[0]): best = (s, (i, j))
    inliers, (bi, bj) = best
    rf = fit(inliers)
    ys = [p[1] for p in pts]; y0, y1 = min(ys), max(ys)
    X = lambda x: 40 + x; Y = lambda y: 300 - (y - y0) / (y1 - y0) * 240  # data → page
    m, c = rf
    band = tau * math.hypot(1, m)
    def edge(x, off): return (X(x), Y(m * x + c + off))
    xs = (0, 560)
    b = f'  <clipPath id="frame"><rect x="40" y="50" width="560" height="260"/></clipPath>\n  <g clip-path="url(#frame)">\n'
    b += poly([edge(xs[0], band), edge(xs[1], band), edge(xs[1], -band), edge(xs[0], -band)], GREEN, fill=GREEN, w=0, op=0.12, closed=True)
    b += line(X(0), Y(c), X(560), Y(m * 560 + c), GREEN, 2)
    lm, lc = ls
    b += line(X(0), Y(lc), X(560), Y(lm * 560 + lc), RED, 2, '7 5')
    b += '  </g>\n'
    S = set(inliers)
    for p in pts:
        b += circ(X(p[0]), Y(p[1]), 3.2, GREEN if p in S else GREY)
    for k in (bi, bj):
        b += circ(X(pts[k][0]), Y(pts[k][1]), 9, GOLD, fill=False, w=2)
    b += text(X(90), Y(lm * 90 + lc) - 40, 'least squares', RED, 12)
    b += text(X(330), Y(m * 330 + c) + 34, 'RANSAC fit', GREEN, 12)
    b += text(30, 22, 'red: least squares, dragged off by the outliers (grey); green: RANSAC, fitted to', GREY, 11)
    b += text(30, 37, 'the inliers within its threshold (band); gold: the 2-point sample with the most inliers', GREY, 11)
    svg('ransac.svg', W, H, b)

# ── focal-length-fov.svg ─────────────────────────────────────────────────────
def fov():
    W, H = 680, 300
    b = ''
    for pi, (lab, f) in enumerate([('short focal length: wide view', 26), ('long focal length: narrow view', 70)]):
        ox, ly = 170 + pi * 340, 230
        sw = 36  # same sensor width
                # sensor behind the pinhole (drawn below it), scene above
        sy = ly + f * 0.6
        b += line(ox - sw / 2, sy, ox + sw / 2, sy, FG, 3)
        th = math.atan((sw / 2) / (f * 0.6))
        L = min(165, 145 / math.tan(th))
        for s in (-1, 1):
            b += line(ox + s * sw / 2, sy, ox - s * L * math.tan(th), ly - L, BLUE, 1.2)
        b += camera(ox, ly)
        b += line(ox + sw / 2 + 10, sy, ox + sw / 2 + 10, ly, GREY, 1) + text(ox + sw / 2 + 14, (sy + ly) / 2 + 4, 'f', GREY)
        b += text(ox, ly - 60, f'{2 * math.degrees(th):.0f}°', BLUE, 13, 'middle')
        b += text(ox, 292, lab, FG, 12, 'middle')
    b += text(340, 22, 'same sensor width; f_px = f_mm × width_px / width_mm', GREY, 11, 'middle')
    b += text(340, 38, '(24 mm on a 36 mm, 6,000 px wide sensor: f_px = 4,000)', GREY, 11, 'middle')
    svg('focal-length-fov.svg', W, H, b)

# ── triangulation.svg ────────────────────────────────────────────────────────
def tri():
    W, H = 640, 320
    X = (320, 100)
    C1, C2, C3 = (250, 285), (390, 285), (40, 120)
    b = ''
    cov2 = cov_from_rays(X, [C1, C2], 0.025)
    cov3 = cov_from_rays(X, [C1, C2, C3], 0.025)
    b += poly(ellipse_pts(X[0], X[1], cov2, 1.5), GOLD, fill=GOLD, w=1.2, op=0.3, closed=True)
    b += poly(ellipse_pts(X[0], X[1], cov3, 1.5), GOLD, fill=GOLD, w=1.6, op=0.65, closed=True)
    # Rays 1 and 2 miss each other (a skew pair in 3-D): each drawn up to its closest point.
    P1, P2 = (X[0] - 9, X[1]), (X[0] + 9, X[1])
    for C, P in ((C1, P1), (C2, P2)):
        b += line(C[0], C[1], P[0], P[1], BLUE, 1.4)
        b += camera(*C)
        b += circ(C[0] + (P[0] - C[0]) * 0.3, C[1] + (P[1] - C[1]) * 0.3, 3.5, GREEN)
    b += line(P1[0], P1[1], P2[0], P2[1], RED, 2)
    b += circ(X[0], X[1], 3, RED)
    b += text(X[0] + 14, X[1] - 30, 'midpoint of the gap', RED, 12)
    b += line(C3[0], C3[1], X[0] - 40, X[1] - (X[1] - C3[1]) * 40 / (X[0] - C3[0]), BLUE, 1.2, '6 4')
    b += camera(*C3, label='third view', ldx=-24, ldy=22)
    b += text(320, 306, 'two rays: the point and its uncertainty (pale); a third ray tightens it (dark)', GREY, 11, 'middle')
    b += text(320, 24, 'rays through matched keypoints (green) miss each other slightly', GREY, 11, 'middle')
    svg('triangulation.svg', W, H, b)

# ── pinhole-projection.svg ───────────────────────────────────────────────────
def pinhole():
    W, H = 640, 320
    C, f, ax = (110, 190), 160, 190          # camera centre, focal length (px), axis height
    px = C[0] + f                             # image plane (drawn in front of the centre)
    X = (580, 70)
    b = line(C[0], ax, 620, ax, DIM, 1.2, '6 4') + text(600, ax - 8, 'optical axis', GREY, 11, 'end')
    b += line(px, 60, px, 300, FG, 2.5)
    b += text(px - 8, 300, 'image plane', GREY, 11, 'end')
    # projection of X: the ray from C through X meets the plane at v
    v = C[1] + (X[1] - C[1]) * (px - C[0]) / (X[0] - C[0])
    b += line(C[0], C[1], X[0], X[1], BLUE, 1.5)
    b += circ(X[0], X[1], 5, GOLD) + text(X[0] - 10, X[1] - 12, 'X = (X, Y, Z)', GOLD, 12, 'end')
    b += circ(px, v, 4, GREEN) + text(px + 10, v - 6, 'pixel', GREEN, 12)
    b += circ(px, ax, 4, RED) + text(px + 10, ax + 18, 'principal point', RED, 12)
    # pixel-array origin at the top of the plane, and cy measured from it
    b += circ(px, 60, 3, FG, fill=False) + text(px - 8, 54, '(0, 0)', GREY, 11, 'end')
    b += line(px - 14, 60, px - 14, ax, RED, 1) + text(px - 18, (60 + ax) / 2 + 4, 'cy', RED, 12, 'end')
    b += line(C[0], ax + 34, px, ax + 34, GREY, 1) + text((C[0] + px) / 2, ax + 50, 'f (pixels)', GREY, 12, 'middle')
    b += camera(*C, label='camera centre', ldx=-40, ldy=24)
    b += text(330, 252, 'u = f · X / Z + cx', FG, 13)
    b += text(330, 272, 'v = f · Y / Z + cy', FG, 13)
    b += text(330, 294, 'K = [[f, 0, cx], [0, f, cy], [0, 0, 1]]', GREY, 12)
    svg('pinhole-projection.svg', W, H, b)

# ── principal-point.svg ──────────────────────────────────────────────────────
def principal():
    W, H = 560, 340
    x0, y0, w, h = 70, 50, 420, 260
    b = f'  <rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="none" stroke="{FG}" stroke-width="2"/>\n'
    cx0, cy0 = x0 + w / 2, y0 + h / 2
    pp = (cx0 + 34, cy0 - 22)
    b += line(cx0 - 10, cy0, cx0 + 10, cy0, FG, 1.5) + line(cx0, cy0 - 10, cx0, cy0 + 10, FG, 1.5)
    b += text(cx0 - 14, cy0 + 26, 'image centre (W/2, H/2)', GREY, 11, 'end')
    # the optical axis arriving at the principal point (seen obliquely)
    b += line(pp[0] + 120, pp[1] - 120, pp[0] + 6, pp[1] - 6, BLUE, 1.5)
    b += poly([(pp[0] + 6, pp[1] - 16), (pp[0] + 4, pp[1] - 4), (pp[0] + 16, pp[1] - 6)], BLUE, fill=BLUE, w=1, closed=True)
    b += text(pp[0] + 126, pp[1] - 124, 'optical axis', BLUE, 12)
    b += circ(pp[0], pp[1], 5, RED) + text(pp[0] + 10, pp[1] + 20, 'principal point (cx, cy)', RED, 12)
    # the offset, dimensioned
    b += line(cx0, cy0 + 40, pp[0], cy0 + 40, GOLD, 1.2) + text((cx0 + pp[0]) / 2, cy0 + 56, 'Δx', GOLD, 12, 'middle')
    b += line(cx0 - 40, cy0, cx0 - 40, pp[1], GOLD, 1.2) + text(cx0 - 46, (cy0 + pp[1]) / 2 + 4, 'Δy', GOLD, 12, 'end')
    b += line(cx0, cy0 + 34, cx0, cy0 + 46, GOLD, 1) + line(pp[0], cy0 + 34, pp[0], pp[1] + 6, GOLD, 1, '3 3')
    b += line(cx0 - 46, cy0, cx0 - 34, cy0, GOLD, 1) + line(cx0 - 46, pp[1], pp[0] - 6, pp[1], GOLD, 1, '3 3')
    b += text(x0 - 4, y0 - 8, '(0, 0)', GREY, 11)
    b += text(W / 2, 334, 'a few pixels of offset are normal; self-calibration estimates it', GREY, 11, 'middle')
    svg('principal-point.svg', W, H, b)

# ── statistical-outlier-removal.svg ──────────────────────────────────────────
def sor():
    W, H = 660, 320
    rnd = random.Random(7)
    surf = [(x, 210 - 40 * math.sin(x / 60) + rnd.gauss(0, 2.5)) for x in [30 + i * 6.5 for i in range(56)]]
    fly = [(120, 120), (230, 95), (300, 135), (340, 70)]
    pts = surf + fly
    k = 6
    def knn_mean(p):
        d = sorted(math.hypot(p[0] - q[0], p[1] - q[1]) for q in pts if q is not p)
        return sum(d[:k]) / k, d[k - 1]
    means = [knn_mean(p) for p in pts]
    mu = sum(m for m, _ in means) / len(means)
    sg = math.sqrt(sum((m - mu) ** 2 for m, _ in means) / len(means))
    cut = mu + 1.5 * sg
    b = ''
    for (p, (m, r)) in list(zip(pts, means)):
        bad = m > cut
        b += circ(p[0], p[1], 3, RED if bad else BLUE)
    b += '  <clipPath id="profile"><rect x="20" y="45" width="380" height="270"/></clipPath>\n  <g clip-path="url(#profile)">\n'
    for idx in (20, len(surf)):  # one surface point, one flyer: their k-neighbour circles
        p, (m, r) = pts[idx], means[idx]
        b += circ(p[0], p[1], r, GOLD, fill=False, w=1.2)
    b += '  </g>\n'
    b += text(30, 30, f'each point: mean distance to its {k} nearest neighbours (gold: two examples)', GREY, 11)
    # histogram of the means
    hx, hy, hw, hh = 420, 70, 210, 180
    lo, hi = 0, max(m for m, _ in means) * 1.05
    nb = 14
    counts = [0] * nb; redc = [0] * nb
    for m, _ in means:
        i = min(int((m - lo) / (hi - lo) * nb), nb - 1)
        counts[i] += 1
        if m > cut: redc[i] += 1
    top = max(counts)
    bw = hw / nb
    for i in range(nb):
        if not counts[i]: continue
        bh = hh * counts[i] / top
        col = RED if redc[i] else BLUE
        b += f'  <rect x="{f2(hx + i * bw + 1)}" y="{f2(hy + hh - bh)}" width="{f2(bw - 2)}" height="{f2(bh)}" fill="{col}" opacity="0.85"/>\n'
    b += line(hx, hy + hh, hx + hw, hy + hh, GREY, 1)
    xc = hx + (cut - lo) / (hi - lo) * hw
    b += line(xc, hy - 10, xc, hy + hh, GOLD, 2, '5 3')
    b += text(xc + 4, hy - 14, 'μ + 1.5 σ', GOLD, 12)
    b += text(hx + hw / 2, hy + hh + 22, 'mean neighbour distance', GREY, 11, 'middle')
    b += text(hx + hw / 2, hy + hh + 38, 'the flyers fall right of the cut (red)', GREY, 11, 'middle')
    svg('statistical-outlier-removal.svg', W, H, b)

# ── dem-of-difference.svg ────────────────────────────────────────────────────
def dod():
    W, H = 620, 300
    xs = [30 + i * 4 for i in range(141)]
    z1 = [70 + 0.32 * (x - 30) + 6 * math.sin(x / 35) for x in xs]
    def dz(x):  # material removed on the lower slope, added on the upper one
        return -26 * math.exp(-((x - 190) / 45) ** 2) + 22 * math.exp(-((x - 470) / 55) ** 2)
    z2 = [z + dz(x) for x, z in zip(xs, z1)]
    Y = lambda z: 280 - z
    b = ''
    seg = []
    for i in range(len(xs) - 1):
        d0, d1 = z2[i] - z1[i], z2[i + 1] - z1[i + 1]
        if abs(d0) < 0.3 and abs(d1) < 0.3: continue
        col = BLUE if d0 + d1 > 0 else RED
        b += poly([(xs[i], Y(z1[i])), (xs[i + 1], Y(z1[i + 1])), (xs[i + 1], Y(z2[i + 1])), (xs[i], Y(z2[i]))], col, fill=col, w=0, op=0.55, closed=True)
    b += poly([(x, Y(z)) for x, z in zip(xs, z1)], FG, w=2)
    b += poly([(x, Y(z)) for x, z in zip(xs, z2)], GOLD, w=2, dash='6 4')
    b += text(40, 30, 'earlier date', FG, 12) + line(130, 26, 170, 26, FG, 2)
    b += text(190, 30, 'later date', GOLD, 12) + line(270, 26, 310, 26, GOLD, 2, '6 4')
    b += text(190, Y(z1[40]) + 40, 'removed (later − earlier < 0)', RED, 12, 'middle')
    b += text(470, Y(z1[110]) + 40, 'added (> 0)', BLUE, 12, 'middle')
    svg('dem-of-difference.svg', W, H, b)

# ── mesh-smoothing.svg ───────────────────────────────────────────────────────
def smoothing():
    W, H = 660, 260
    rnd = random.Random(3)
    n, R = 90, 80
    base = [(R * math.cos(2 * math.pi * i / n) * (1 + 0.12 * math.cos(3 * 2 * math.pi * i / n)),
             R * math.sin(2 * math.pi * i / n) * (1 + 0.12 * math.cos(3 * 2 * math.pi * i / n))) for i in range(n)]
    noisy = [(x + rnd.gauss(0, 4), y + rnd.gauss(0, 4)) for x, y in base]
    def passes(pts, steps):
        for lam in steps:
            pts = [(p[0] + lam * ((pts[i - 1][0] + pts[(i + 1) % n][0]) / 2 - p[0]),
                    p[1] + lam * ((pts[i - 1][1] + pts[(i + 1) % n][1]) / 2 - p[1])) for i, p in enumerate(pts)]
        return pts
    lap = passes(noisy, [0.5] * 60)
    tau = passes(noisy, [0.5, -0.53] * 30)
    b = ''
    for pi, (lab, P) in enumerate([('noisy', noisy), ('60 Laplacian passes: shrinks', lap), ('60 Taubin passes: keeps its size', tau)]):
        cx, cy = 110 + pi * 220, 125
        b += poly([(cx + x, cy + y) for x, y in base], DIM, w=1, closed=True, dash='4 3')
        b += poly([(cx + x, cy + y) for x, y in P], BLUE, w=1.6, closed=True)
        b += text(cx, 240, lab, FG, 12, 'middle')
    b += text(330, 22, 'dashed: the true shape; Taubin alternates λ = 0.5 with μ = −0.53', GREY, 11, 'middle')
    svg('mesh-smoothing.svg', W, H, b)

# ── surface-normal.svg ───────────────────────────────────────────────────────
def normal():
    W, H = 620, 330
    rnd = random.Random(5)
    pts = [(x, 220 - 55 * math.sin((x - 40) / 85) + rnd.gauss(0, 1.5)) for x in [40 + i * 13 for i in range(41)]]
    q = pts[20]
    k = 7
    nb = sorted(pts, key=lambda p: math.hypot(p[0] - q[0], p[1] - q[1]))[:k]
    mx = sum(p[0] for p in nb) / k; my = sum(p[1] for p in nb) / k
    a = sum((p[0] - mx) ** 2 for p in nb) / k; c = sum((p[1] - my) ** 2 for p in nb) / k
    bxy = sum((p[0] - mx) * (p[1] - my) for p in nb) / k
    ang = 0.5 * math.atan2(2 * bxy, a - c)            # the largest eigenvector: the tangent
    t = (math.cos(ang), math.sin(ang)); n = (-t[1], t[0])
    cam = (470, 50)
    if (cam[0] - q[0]) * n[0] + (cam[1] - q[1]) * n[1] < 0: n = (-n[0], -n[1])  # toward the camera
    b = ''
    for p in pts: b += circ(p[0], p[1], 3, BLUE)
    for p in nb: b += circ(p[0], p[1], 7, GOLD, fill=False, w=1.2)
    b += line(q[0] - 90 * t[0], q[1] - 90 * t[1], q[0] + 90 * t[0], q[1] + 90 * t[1], GREEN, 2)
    b += text(q[0] - 95 * t[0] - 6, q[1] - 95 * t[1] - 8, 'fitted tangent plane', GREEN, 12, 'end')
    L = 70
    b += line(q[0], q[1], q[0] + L * n[0], q[1] + L * n[1], FG, 2)
    b += poly([(q[0] + L * n[0] + 7 * t[0] - 2 * n[0], q[1] + L * n[1] + 7 * t[1] - 2 * n[1]), (q[0] + (L + 10) * n[0], q[1] + (L + 10) * n[1]), (q[0] + L * n[0] - 7 * t[0] - 2 * n[0], q[1] + L * n[1] - 7 * t[1] - 2 * n[1])], FG, fill=FG, w=1, closed=True)
    b += line(q[0], q[1], q[0] - L * n[0], q[1] - L * n[1], DIM, 1.5, '5 4')
    b += text(q[0] - (L + 14) * n[0] + 6, q[1] - (L + 14) * n[1] + 14, 'the other sign: away from the camera', GREY, 11)
    b += circ(q[0], q[1], 4, RED)
    b += line(cam[0], cam[1], q[0], q[1], BLUE, 1, '2 4')
    b += camera(*cam) + text(cam[0] - 12, cam[1] + 4, 'camera that saw the point', BLUE, 12, 'end')
    b += text(30, 26, f'the point (red), its {k} nearest neighbours (gold); the normal is their smallest-spread direction', GREY, 11)
    svg('surface-normal.svg', W, H, b)

# ── contour-lines.svg ────────────────────────────────────────────────────────
def contours():
    W, H = 620, 340
    Z = [[8, 9, 11, 12, 11, 9],
         [9, 12, 13, 10, 9, 8],
         [10, 13, 9, 12, 13, 10],
         [9, 11, 10, 13, 12, 9],
         [8, 9, 9, 10, 10, 8]]
    L = 10.5
    ox, oy, d = 60, 60, 60
    P = lambda r, c: (ox + c * d, oy + r * d)
    b = ''
    rows, cols = len(Z), len(Z[0])
    for r in range(rows):
        for c in range(cols - 1): b += line(*P(r, c), *P(r, c + 1), DIM, 1)
    for c in range(cols):
        for r in range(rows - 1): b += line(*P(r, c), *P(r + 1, c), DIM, 1)
    def cross(r0, c0, r1, c1):
        z0, z1 = Z[r0][c0], Z[r1][c1]; t = (L - z0) / (z1 - z0)
        (x0, y0), (x1, y1) = P(r0, c0), P(r1, c1)
        return (x0 + t * (x1 - x0), y0 + t * (y1 - y0))
    saddle = None
    for r in range(rows - 1):
        for c in range(cols - 1):
            corners = [(r, c), (r, c + 1), (r + 1, c + 1), (r + 1, c)]  # tl, tr, br, bl
            up = [Z[a][e] >= L for a, e in corners]  # a level equal to a sample counts as above
            edges = []
            for k in range(4):
                (a0, e0), (a1, e1) = corners[k], corners[(k + 1) % 4]
                edges.append(cross(a0, e0, a1, e1) if up[k] != up[(k + 1) % 4] else None)
            hits = [e for e in edges if e]
            if len(hits) == 2:
                b += line(*hits[0], *hits[1], GOLD, 2.5)
            elif len(hits) == 4:
                centre = sum(Z[a][e] for a, e in corners) / 4
                top, right, bottom, left = edges
                # centre above: cut off each corner below; below: cut off each corner above
                below_tr = (top, right), (bottom, left)
                below_tl = (left, top), (right, bottom)
                chosen, other = (below_tr, below_tl) if (centre >= L) == up[0] else (below_tl, below_tr)
                for s0, s1 in other: b += line(*s0, *s1, GOLD, 1.2, '4 4', op=0.6)
                for s0, s1 in chosen: b += line(*s0, *s1, GOLD, 2.5)
                saddle = (corners, centre)
    for r in range(rows):
        for c in range(cols):
            x, y = P(r, c); hi = Z[r][c] >= L
            b += circ(x, y, 4, FG if hi else DIM)
            b += text(x + 6, y - 6, str(Z[r][c]), FG if hi else GREY, 11)
    if saddle:
        (r, c), centre = saddle[0][0], saddle[1]
        (x0, y0), (x1, y1) = P(r, c), P(r + 1, c + 1)
        b += f'  <rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="none" stroke="{RED}" stroke-width="1.5"/>\n'
        b += text(ox + (cols - 1) * d + 24, oy + 2 * d - 4, 'saddle square:', RED, 12)
        b += text(ox + (cols - 1) * d + 24, oy + 2 * d + 14, f'centre = mean = {centre:g}', RED, 12)
        b += text(ox + (cols - 1) * d + 24, oy + 2 * d + 32, f'above {L:g}: solid reading,', RED, 12)
        b += text(ox + (cols - 1) * d + 24, oy + 2 * d + 50, 'the other dashed', RED, 12)
    b += text(30, 30, f'level {L:g} through heights at the cell centres; each crossing interpolated along its edge', GREY, 11)
    svg('contour-lines.svg', W, H, b)

# ── dem-binning.svg ──────────────────────────────────────────────────────────
def binning():
    W, H = 660, 320
    rnd = random.Random(11)
    zf = lambda x, y: 0.5 + 0.35 * math.sin(x / 2.2) * math.cos(y / 1.8) + 0.08 * x / 8
    nx, ny, cs = 8, 6, 30
    hole = (5, 1)
    pts = []
    while len(pts) < 260:
        x, y = rnd.uniform(0, nx), rnd.uniform(0, ny)
        if (int(x), int(y)) == hole: continue
        pts.append((x, y, zf(x, y) + rnd.gauss(0, 0.03)))
    col = lambda z: '#%02x%02x%02x' % tuple(int(a + (b2 - a) * max(0, min(1, z))) for a, b2 in zip((40, 90, 160), (230, 184, 79)))
    b = ''
    ox, oy = 30, 60
    for x, y, z in pts: b += circ(ox + x * cs, oy + y * cs, 2, col(z))
    for i in range(nx + 1): b += line(ox + i * cs, oy, ox + i * cs, oy + ny * cs, DIM, 0.8)
    for j in range(ny + 1): b += line(ox, oy + j * cs, ox + nx * cs, oy + j * cs, DIM, 0.8)
    pick = (2, 3)
    b += f'  <rect x="{ox + pick[0] * cs}" y="{oy + pick[1] * cs}" width="{cs}" height="{cs}" fill="none" stroke="{GOLD}" stroke-width="2"/>\n'
    b += text(ox, oy - 14, 'dense cloud, plan view', GREY, 11)
    # the picked cell's points in side view, and their median
    cell = sorted(p[2] for p in pts if (int(p[0]), int(p[1])) == pick)
    med = cell[len(cell) // 2]
    ix, iy, iw, ih = 290, 150, 90, 100
    b += f'  <rect x="{ix}" y="{iy}" width="{iw}" height="{ih}" fill="none" stroke="{GOLD}" stroke-width="1"/>\n'
    zs = lambda z: iy + ih - (z - 0.0) / 1.2 * ih
    for k2, z in enumerate(cell):
        x = ix + 10 + k2 * (iw - 20) / max(len(cell) - 1, 1)
        b += line(x, iy + ih, x, zs(z), BLUE, 1) + circ(x, zs(z), 2.5, BLUE)
    b += line(ix, zs(med), ix + iw, zs(med), GOLD, 2) + text(ix + iw / 2, iy - 8, 'one cell, side view:', GOLD, 11, 'middle')
    b += text(ix + iw / 2, iy + ih + 16, f'{len(cell)} points → one height', GOLD, 11, 'middle')
    # the grid
    gx = 420
    for i in range(nx):
        for j in range(ny):
            ps = [p[2] for p in pts if (int(p[0]), int(p[1])) == (i, j)]
            if ps:
                zz = sorted(ps)[len(ps) // 2]
                b += f'  <rect x="{gx + i * 27}" y="{oy + j * 27 + 10}" width="26" height="26" fill="{col(zz)}"/>\n'
    hx, hy = gx + hole[0] * 27, oy + hole[1] * 27 + 10
    b += f'  <rect x="{hx + 1}" y="{hy + 1}" width="24" height="24" fill="{col(zf(hole[0] + 0.5, hole[1] + 0.5))}" stroke="{RED}" stroke-width="2.5" stroke-dasharray="4 2"/>\n'
    b += text(gx, oy - 14, 'DEM: one height per cell', GREY, 11)
    gy1 = oy + ny * 27 + 10
    b += line(hx + 13, hy + 26, hx + 13, gy1 + 14, RED, 1.2)
    b += text(hx + 13, gy1 + 28, 'no points: interpolated', RED, 11, 'middle')
    b += text(hx + 13, gy1 + 42, 'from its neighbours', RED, 11, 'middle')
    svg('dem-binning.svg', W, H, b)

# ── volume-cut-fill.svg ──────────────────────────────────────────────────────
def volume():
    W, H = 640, 300
    x0, x1 = 60, 580
    base = lambda x: 240 - 0.09 * (x - x0)          # the plane through the polygon's vertices
    def surf(x):
        return base(x) - 120 * math.exp(-((x - 260) / 85) ** 2) + 26 * math.exp(-((x - 480) / 38) ** 2)
    b = ''
    step = 16
    for x in range(x0, x1, step):
        xm = x + step / 2; dz = base(xm) - surf(xm)  # > 0: material above the base (cut)
        if abs(dz) < 1: continue
        y = min(base(xm), surf(xm))
        b += f'  <rect x="{x + 1}" y="{f2(y)}" width="{step - 2}" height="{f2(abs(dz))}" fill="{GOLD if dz > 0 else BLUE}" opacity="0.6"/>\n'
    b += poly([(x, surf(x)) for x in range(x0, x1 + 1, 4)], FG, w=2)
    b += line(x0, base(x0), x1, base(x1), RED, 1.8, '7 4')
    for x in (x0, x1): b += circ(x, base(x), 5, RED)
    b += text(x0 - 4, base(x0) + 22, 'polygon vertex', RED, 11)
    b += text(330, base(330) + 24, 'base plane through the vertices', RED, 11, 'middle')
    b += text(260, 92, 'cut: above the base', GOLD, 12, 'middle')
    b += text(480, base(480) + 52, 'fill: below it', BLUE, 12, 'middle')
    b += text(30, 26, 'V = Σ (z − base) · cell area over the cells whose centre lies inside the polygon', GREY, 11)
    svg('volume-cut-fill.svg', W, H, b)

# ── gauge-freedom.svg ────────────────────────────────────────────────────────
def gauge():
    W, H = 680, 330
    cams = [(-55, 50, -math.pi / 2 + 0.25), (55, 50, -math.pi / 2 - 0.25)]   # x, y, viewing angle
    pts = [(-30, -55), (8, -85), (42, -45)]
    fpx = 40
    def project(cam, p):  # 1-D image coordinate in the camera's own frame
        cx, cy, a = cam
        dx, dy = p[0] - cx, p[1] - cy
        depth = dx * math.cos(a) + dy * math.sin(a); lat = -dx * math.sin(a) + dy * math.cos(a)
        return fpx * lat / depth
    imgs = [[project(cm, p) for p in pts] for cm in cams]   # identical for every panel
    sims = [('translated', 0, 1.0, (-20, 15)), ('rotated', 0.5, 1.0, (0, 0)), ('scaled with the cameras', 0, 1.45, (0, 15))]
    b = ''
    for pi, (lab, rot, sc, sh) in enumerate(sims):
        ox, oy = 115 + pi * 225, 150
        T = lambda p: (ox + sh[0] + sc * (p[0] * math.cos(rot) - p[1] * math.sin(rot)), oy + sh[1] + sc * (p[0] * math.sin(rot) + p[1] * math.cos(rot)))
        P2 = [T(p) for p in pts]
        for cm in cams:
            C = T((cm[0], cm[1]))
            for q in P2: b += line(C[0], C[1], q[0], q[1], BLUE, 0.8, op=0.6)
            b += camera(*C)
        for q in P2: b += circ(q[0], q[1], 4, GOLD)
        b += text(ox, 30, lab, FG, 12, 'middle')
        # the two images, the same in every panel
        for ci, im in enumerate(imgs):
            sx, sy = ox - 45 + ci * 90, 270
            b += line(sx - 30, sy, sx + 30, sy, FG, 2)
            for u in im: b += circ(sx + u, sy, 3, GREEN)
        b += text(ox, 296, 'images of both cameras', GREY, 10, 'middle')
    b += text(340, 318, 'the same images, so the same reprojection error: the solve cannot tell these apart', GREY, 11, 'middle')
    svg('gauge-freedom.svg', W, H, b)

# ── lowe-ratio.svg ───────────────────────────────────────────────────────────
def lowe():
    W, H = 680, 320
    rnd = random.Random(2)
    b = ''
    for pi, (lab, n1, n2, patch) in enumerate([('distinctive: accepted', (24, 6), (95, -40), 'corner'),
                                               ('repetitive façade: rejected', (40, 12), (-38, 22), 'windows')]):
        ox, oy = 110 + pi * 340, 160
        for _ in range(26):
            a = rnd.uniform(0, 2 * math.pi); r = rnd.uniform(70, 125)
            b += circ(ox + r * math.cos(a), oy + r * math.sin(a), 3, DIM)
        q = (ox, oy); p1 = (ox + n1[0], oy + n1[1]); p2 = (ox + n2[0], oy + n2[1])
        d1, d2 = math.hypot(*n1), math.hypot(*n2)
        b += line(*q, *p1, GREEN, 2) + line(*q, *p2, RED, 1.5, '5 3')
        b += circ(*p1, 4.5, GREEN) + circ(*p2, 4.5, RED) + circ(*q, 5.5, GOLD)
        b += text(p1[0] + 8, p1[1] + 4, 'd1', GREEN, 12) + text(p2[0] + (8 if n2[0] > 0 else -10), p2[1] + (-4 if n2[0] > 0 else 18), 'd2', RED, 12, None if n2[0] > 0 else 'end')
        ratio = d1 / d2
        ok = ratio < 0.8
        b += text(ox, 290, f'd1 / d2 = {ratio:.2f} {"<" if ok else ">"} 0.8: {"accept" if ok else "reject"}', GREEN if ok else RED, 13, 'middle')
        b += text(ox, 30, lab, FG, 13, 'middle')
        # the image patches: the query's and its two candidates'
        px = ox + 135
        for k, (yy, c) in enumerate([(70, GOLD), (130, GREEN), (190, RED)]):
            b += f'  <rect x="{px}" y="{yy}" width="44" height="44" fill="#2a303b" stroke="{c}" stroke-width="2"/>\n'
            if patch == 'corner':
                if k < 2:  # the query and its true match: the same corner
                    b += f'  <rect x="{px + 4}" y="{yy + 22}" width="22" height="18" fill="{GREY}"/>\n  <rect x="{px + 4}" y="{yy + 4}" width="8" height="18" fill="{GREY}"/>\n'
                else:      # a different structure
                    b += f'  <circle cx="{px + 22}" cy="{yy + 22}" r="12" fill="{GREY}"/>\n'
            else:          # windows: all three look alike
                for wx in (6, 25):
                    for wy in (6, 25):
                        b += f'  <rect x="{px + wx}" y="{yy + wy}" width="13" height="13" fill="{GREY}"/>\n'
    b += text(340, 312, 'descriptor space; gold: the query, green / red: its nearest and second-nearest neighbour', GREY, 11, 'middle')
    svg('lowe-ratio.svg', W, H, b)

# ── track.svg ────────────────────────────────────────────────────────────────
def track():
    W, H = 640, 360
    X = (320, 60)
    cams = [(90, 250), (230, 285), (410, 285), (550, 250)]
    kps = []
    b = ''
    for k, C in enumerate(cams):
        dx, dy = X[0] - C[0], X[1] - C[1]; d = math.hypot(dx, dy); ux, uy = dx / d, dy / d
        pc = (C[0] + 42 * ux, C[1] + 42 * uy)               # the keypoint on the image plane
        b += line(pc[0] - 22 * uy, pc[1] + 22 * ux, pc[0] + 22 * uy, pc[1] - 22 * ux, FG, 2.5)
        b += line(C[0], C[1], X[0], X[1], BLUE, 1, op=0.7)
        b += camera(*C, label=f'image {k + 1}', ldx=-22, ldy=24)
        kps.append(pc)
    for (a, c) in zip(kps, kps[1:]):
        mx, my = (a[0] + c[0]) / 2, (a[1] + c[1]) / 2 - 38
        b += f'  <path d="M {f2(a[0])} {f2(a[1])} Q {f2(mx)} {f2(my)} {f2(c[0])} {f2(c[1])}" fill="none" stroke="{GREEN}" stroke-width="1.6" stroke-dasharray="5 3"/>\n'
    for pc in kps: b += circ(*pc, 4.5, GREEN)
    b += circ(*X, 6, GOLD) + text(X[0] + 12, X[1] + 4, 'one world point', GOLD, 12)
    b += poly([(70, 322), (70, 332), (570, 332), (570, 322)], GREY, w=1.2)
    b += text(320, 350, 'one track of length 4: the keypoints (green) linked by pairwise matches', GREY, 11, 'middle')
    svg('track.svg', W, H, b)

# ── cog-pyramid.svg ──────────────────────────────────────────────────────────
def cog():
    W, H = 680, 330
    b = ''
    levels = [(8, 'full resolution'), (4, 'overview 1 (½)'), (2, 'overview 2 (¼)')]
    sizes = [240, 120, 60]
    x = 30
    boxes = []
    for (n, lab), sz in zip(levels, sizes):
        y0 = 60 + (240 - sz)
        t = sz / n
        for i in range(n):
            for j in range(n):
                b += f'  <rect x="{f2(x + i * t)}" y="{f2(y0 + j * t)}" width="{f2(t)}" height="{f2(t)}" fill="#2a303b" stroke="{DIM}" stroke-width="1"/>\n'
        b += text(x + sz / 2, 324 - 4, lab, GREY, 11, 'middle')
        boxes.append((x, y0, t, n))
        x += sz + 50
    # zoomed in: a small window on the full level touches 4 tiles
    x0, y0, t, n = boxes[0]
    wx, wy, ww = x0 + 2.5 * t, y0 + 3.4 * t, 1.3 * t
    for i in (2, 3):
        for j in (3, 4):
            b += f'  <rect x="{f2(x0 + i * t)}" y="{f2(y0 + j * t)}" width="{f2(t)}" height="{f2(t)}" fill="{GOLD}" opacity="0.45"/>\n'
    b += f'  <rect x="{f2(wx)}" y="{f2(wy)}" width="{f2(ww)}" height="{f2(ww)}" fill="none" stroke="{GOLD}" stroke-width="2.5"/>\n'
    b += text(x0, 46, 'zoomed in: the 4 tiles under the view', GOLD, 12)
    # zoomed out: the whole raster on screen reads the coarsest level, one or two tiles
    x2, y2, t2, n2 = boxes[2]
    b += f'  <rect x="{f2(x2)}" y="{f2(y2)}" width="{f2(2 * t2)}" height="{f2(2 * t2)}" fill="{BLUE}" opacity="0.4"/>\n'
    b += f'  <rect x="{f2(x2 - 3)}" y="{f2(y2 - 3)}" width="{f2(2 * t2 + 6)}" height="{f2(2 * t2 + 6)}" fill="none" stroke="{BLUE}" stroke-width="2.5"/>\n'
    b += text(x2 + t2, y2 - 14, 'zoomed out: 4 small tiles', BLUE, 12, 'middle')
    b += text(340, 22, 'each level half the size of the one below, all cut into tiles of the same pixel size', GREY, 11, 'middle')
    svg('cog-pyramid.svg', W, H, b)

# ── match-graph.svg ──────────────────────────────────────────────────────────
def mgraph():
    W, H = 660, 330
    rnd = random.Random(8)
    A = [(80 + 110 * math.cos(a) * 0.9, 170 + 95 * math.sin(a)) for a in [2 * math.pi * k / 8 for k in range(8)]]
    A = [(x + 60, y) for x, y in A]
    B = [(400 + 55 * math.cos(a), 170 + 55 * math.sin(a)) for a in [2 * math.pi * k / 5 + 0.3 for k in range(5)]]
    Cc = [(580, 110), (620, 170), (565, 220)]
    b = ''
    def edge(p, q, n, c=BLUE):
        return line(p[0], p[1], q[0], q[1], c, max(0.6, n / 60), op=0.85)
    for i in range(len(A)):
        for j in range(i + 1, len(A)):
            if rnd.random() < 0.7: b += edge(A[i], A[j], rnd.uniform(60, 320))
    for i in range(len(B)):
        for j in range(i + 1, len(B)):
            if rnd.random() < 0.8: b += edge(B[i], B[j], rnd.uniform(60, 260))
    for i in range(3):
        for j in range(i + 1, 3): b += edge(Cc[i], Cc[j], rnd.uniform(80, 200))
    bridge = (A[0], B[3])
    b += line(*bridge[0], *bridge[1], RED, 1.2, '4 3')
    for p in A + B + Cc: b += circ(*p, 7, GOLD)
    b += text(140, 54, 'dense cluster', FG, 12, 'middle')
    b += text(300, 96, 'fragile bridge:', RED, 12, 'middle') + text(300, 112, 'one weak pair', RED, 12, 'middle')
    b += text(590, 66, 'detached', FG, 12, 'middle') + text(590, 82, 'component', FG, 12, 'middle')
    b += text(330, 314, 'nodes: images; edges: verified pairs, thicker for more inliers', GREY, 11, 'middle')
    svg('match-graph.svg', W, H, b)

# ── camera-pose.svg ──────────────────────────────────────────────────────────
def pose():
    W, H = 640, 330
    O = (90, 270)
    C = (430, 120); th = math.radians(-35)
    def arrow(p, d, L, c, lab, lo=(6, -6)):
        e = (p[0] + L * d[0], p[1] + L * d[1])
        n = (-d[1], d[0])
        h = [(e[0] - 10 * d[0] + 5 * n[0], e[1] - 10 * d[1] + 5 * n[1]), e, (e[0] - 10 * d[0] - 5 * n[0], e[1] - 10 * d[1] - 5 * n[1])]
        return line(p[0], p[1], e[0] - 6 * d[0], e[1] - 6 * d[1], c, 2) + poly(h, c, fill=c, w=1, closed=True) + text(e[0] + lo[0], e[1] + lo[1], lab, c, 12)
    b = arrow(O, (1, 0), 80, FG, 'x') + arrow(O, (0, -1), 80, FG, 'y', (6, 4))
    b += circ(*O, 4, FG) + text(O[0] - 10, O[1] + 20, 'world origin', GREY, 11)
    cx_ = (math.cos(th), math.sin(th)); cy_ = (math.sin(th), -math.cos(th))
    b += arrow(C, cx_, 70, BLUE, 'x_cam') + arrow(C, cy_, 70, BLUE, 'y_cam', (6, 2))
    b += camera(*C)
    # t: the world origin as the camera sees it, an arrow from the camera to the origin
    d = (O[0] - C[0], O[1] - C[1]); L = math.hypot(*d); u = (d[0] / L, d[1] / L)
    b += arrow(C, u, L - 8, GOLD, '', (0, 0))
    b += text((C[0] + O[0]) / 2 + 18, (C[1] + O[1]) / 2 + 22, 't: the world origin in camera axes', GOLD, 12)
    b += text(C[0] - 30, C[1] - 10, 'C = −Rᵀ·t: the camera centre in world axes', BLUE, 12, 'end')
    # R: the turn from the world axes to the camera's
    r = 40
    a0, a1 = 0, th
    pts = [(C[0] + r * math.cos(a0 + (a1 - a0) * k / 20), C[1] + r * math.sin(a0 + (a1 - a0) * k / 20)) for k in range(21)]
    b += line(C[0], C[1], C[0] + 60, C[1], DIM, 1, '3 3')
    b += poly(pts, RED, w=1.6) + text(C[0] + r + 8, C[1] - 4, 'R', RED, 13)
    b += text(320, 24, 'x_cam = R · x_world + t: R turns the world axes into the camera\'s, t then shifts', GREY, 11, 'middle')
    svg('camera-pose.svg', W, H, b)

for f in (gsd, lens, baseline, ransac, fov, tri, pinhole, principal, sor, dod, smoothing, normal, contours, binning, volume, gauge, lowe, track, cog, mgraph, pose): f()
print('ok')

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
    t = str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
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
RAISED = '#2a303b'
def rect(x, y, w, h, c=None, fill='none', sw=1.5, op=None, rx=None, dash=None):
    return f'  <rect x="{f2(x)}" y="{f2(y)}" width="{f2(w)}" height="{f2(h)}" fill="{fill}"' + (f' stroke="{c}" stroke-width="{sw}"' if c else '') + (f' opacity="{op}"' if op is not None else '') + (f' rx="{rx}"' if rx else '') + (f' stroke-dasharray="{dash}"' if dash else '') + '/>\n'
def path(d, c=FG, fill='none', w=1.5, op=None, dash=None):
    return f'  <path d="{d}" fill="{fill}"' + (f' stroke="{c}" stroke-width="{w}"' if c else '') + (f' opacity="{op}"' if op is not None else '') + (f' stroke-dasharray="{dash}"' if dash else '') + '/>\n'
def arrow(x1, y1, x2, y2, c=FG, w=1.6, head=8, dash=None, op=None):
    # A line with a filled head at (x2, y2).
    d = math.hypot(x2 - x1, y2 - y1) or 1; ux, uy = (x2 - x1) / d, (y2 - y1) / d
    bx, by = x2 - head * ux, y2 - head * uy
    h = [(bx + head * 0.45 * uy, by - head * 0.45 * ux), (x2, y2), (bx - head * 0.45 * uy, by + head * 0.45 * ux)]
    return line(x1, y1, bx, by, c, w, dash, op) + poly(h, c, fill=c, w=1, closed=True, op=op)
def curve(p, q, bend, c=FG, w=1.6, dash=None, head=8):
    # A quadratic arc from p to q, bulging by `bend` px to the left of p→q, with a head at q.
    mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
    d = math.hypot(q[0] - p[0], q[1] - p[1]) or 1; nx, ny = (p[1] - q[1]) / d, (q[0] - p[0]) / d
    cx, cy = mx + bend * nx, my + bend * ny
    b = path(f'M {f2(p[0])} {f2(p[1])} Q {f2(cx)} {f2(cy)} {f2(q[0])} {f2(q[1])}', c, w=w, dash=dash)
    if head:
        ux, uy = q[0] - cx, q[1] - cy; L = math.hypot(ux, uy) or 1; ux, uy = ux / L, uy / L
        bx, by = q[0] - head * ux, q[1] - head * uy
        b += poly([(bx + head * 0.45 * uy, by - head * 0.45 * ux), q, (bx - head * 0.45 * uy, by + head * 0.45 * ux)], c, fill=c, w=1, closed=True)
    return b
def hexc(r, g, b_):
    return '#%02x%02x%02x' % tuple(max(0, min(255, round(v))) for v in (r, g, b_))
def ramp(t, stops=((0, (49, 92, 140)), (0.5, (150, 145, 112)), (1, (214, 176, 90)))):
    # A colour ramp (low blue-grey → high ochre by default), outside the palette on purpose:
    # it reads the same on a light or dark ground.
    t = max(0.0, min(1.0, t))
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0) if t1 > t0 else 0
            return hexc(*(a + (b_ - a) * u for a, b_ in zip(c0, c1)))
    return hexc(*stops[-1][1])
GRAYS = ((0, (24, 24, 24)), (1, (236, 236, 236)))
DIVERGE = ((0, (52, 110, 190)), (0.5, (236, 236, 236)), (1, (200, 64, 58)))
def raster(x, y, cell, vals, colour, nodata=None):
    # A grid of cells, one rect per cell, merged along a row where neighbours share a colour.
    b = ''
    for j, row in enumerate(vals):
        i = 0
        while i < len(row):
            v = row[i]
            if v is None:
                i += 1; continue
            c = colour(v); k = i + 1
            while k < len(row) and row[k] is not None and colour(row[k]) == c: k += 1
            b += f'  <rect x="{f2(x + i * cell)}" y="{f2(y + j * cell)}" width="{f2((k - i) * cell + 0.3)}" height="{f2(cell + 0.3)}" fill="{c}"/>\n'
            i = k
    return b

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

# ── 3D helpers for the scene drawings ────────────────────────────────────────
def v_sub(a, b): return tuple(x - y for x, y in zip(a, b))
def v_add(a, b): return tuple(x + y for x, y in zip(a, b))
def v_mul(a, k): return tuple(x * k for x in a)
def v_dot(a, b): return sum(x * y for x, y in zip(a, b))
def v_cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def v_norm(a): L = math.sqrt(v_dot(a, a)) or 1; return tuple(x / L for x in a)
def look_at(C, target, up=(0, 0, 1)):
    # Rows of R: the camera's x (right), y (down) and z (forward) axes in world terms.
    z = v_norm(v_sub(target, C)); x = v_norm(v_cross(z, up)); y = v_cross(z, x)
    return (x, y, z)
def project(R, C, f, cx, cy, X):
    d = v_sub(X, C); xc, yc, zc = (v_dot(r, d) for r in R)
    return (cx + f * xc / zc, cy + f * yc / zc), zc
def rot2(p, a, o=(0, 0)):
    c, s = math.cos(a), math.sin(a); x, y = p[0] - o[0], p[1] - o[1]
    return (o[0] + c * x - s * y, o[1] + s * x + c * y)
def cam2d(x, y, ang, c=BLUE, size=16, label=None, lo=(0, 0)):
    # A camera seen from the side: its centre and a short wedge opening the way it looks
    # (ang: the viewing direction on screen, radians, 0 = right, π/2 = down).
    a1, a2 = ang - 0.42, ang + 0.42
    w = [(x + size * math.cos(a1), y + size * math.sin(a1)), (x, y), (x + size * math.cos(a2), y + size * math.sin(a2))]
    b = poly(w, c, fill=c, w=1, op=0.35, closed=True) + poly(w, c, w=1.4) + circ(x, y, 4.5, c)
    return b + (text(x + lo[0], y + lo[1], label, c, 12, 'middle') if label else '')
def isect(p, d, q, e):
    # Lines p + s·d and q + u·e: returns (s, u).
    den = d[0] * e[1] - d[1] * e[0]
    s = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
    u = ((q[0] - p[0]) * d[1] - (q[1] - p[1]) * d[0]) / den
    return s, u

# ── keypoint-matches.svg ─────────────────────────────────────────────────────
def kpmatch():
    W, H = 680, 330
    rnd = random.Random(11)
    # One scene in scene units: hills, a house, a tree, rocks. Each photo sees it through
    # its own similarity (scale, turn, shift), as two overlapping aerial frames would.
    house = [(0.42, 0.52), (0.58, 0.52), (0.58, 0.38), (0.50, 0.30), (0.42, 0.38)]
    hill = [(0.0, 0.62), (0.15, 0.48), (0.3, 0.55), (0.62, 0.42), (0.8, 0.5), (1.0, 0.44), (1.0, 1.0), (0.0, 1.0)]
    rocks = [(0.2, 0.8, 0.035), (0.7, 0.76, 0.05), (0.86, 0.86, 0.03), (0.33, 0.9, 0.04)]
    tree = (0.76, 0.38)
    kps = [(0.42, 0.52, 0.03, 0.6), (0.58, 0.52, 0.03, 2.5), (0.50, 0.30, 0.035, -1.6), (0.42, 0.38, 0.025, 3.6),
           (0.15, 0.48, 0.05, -0.8), (0.62, 0.42, 0.06, 1.1), (0.76, 0.38, 0.045, -2.2), (0.2, 0.8, 0.04, 0.3),
           (0.7, 0.76, 0.06, 2.0), (0.33, 0.9, 0.045, -0.4), (0.86, 0.86, 0.035, 1.6), (0.8, 0.5, 0.04, -1.2)]
    frames = [(30, 50, 290, 230, 0.0, (0.0, 0.0), 1.0), (360, 50, 290, 230, 0.12, (0.18, 0.04), 1.15)]
    b = ''
    maps = []
    for (fx, fy, fw, fh, ang, sh, sc) in frames:
        def m(p, fx=fx, fy=fy, fw=fw, fh=fh, ang=ang, sh=sh, sc=sc):
            q = rot2(((p[0] - sh[0]) * sc, (p[1] - sh[1]) * sc), ang, (0.5, 0.5))
            return (fx + q[0] * fw, fy + q[1] * fh)
        maps.append(m)
        cid = f'kp{len(maps)}'
        b += f'  <clipPath id="{cid}"><rect x="{fx}" y="{fy}" width="{fw}" height="{fh}"/></clipPath>\n  <g clip-path="url(#{cid})">\n'
        b += rect(fx, fy, fw, fh, fill=RAISED)
        big = [(-1, -1), (2, -1), (2, 2), (-1, 2)]
        b += poly([m(p) for p in hill[:6]] + [m((1.6, 0.44)), m((1.6, 2)), m((-0.6, 2)), m((-0.6, 0.62))], DIM, fill=DIM, w=1, op=0.55, closed=True)
        b += poly([m(p) for p in house], GREY, fill=GREY, w=1, closed=True)
        for (rx, ry, rr) in rocks: b += circ(*m((rx, ry)), rr * fw * sc, GREY)
        tx, ty = m(tree); b += circ(tx, ty, 0.05 * fw * sc, GREY)
        b += '  </g>\n'
        b += rect(fx, fy, fw, fh, DIM, sw=1)
    shown = []
    for k, (x, y, s, o) in enumerate(kps):
        pts = []
        for fi, m in enumerate(maps):
            px, py = m((x, y))
            fx, fy, fw, fh, ang, sh, sc = frames[fi]
            if not (fx + 4 < px < fx + fw - 4 and fy + 4 < py < fy + fh - 4): pts.append(None); continue
            r = s * fw * sc * 0.55; a = o + ang
            b += circ(px, py, r, GOLD, fill=False, w=1.3) + line(px, py, px + r * math.cos(a), py + r * math.sin(a), GOLD, 1.3)
            pts.append((px, py))
        shown.append(pts)
    good = [p for p in shown if p[0] and p[1]]
    for p, q in good[:7]:
        b += line(*p, *q, GREEN, 1.2, op=0.85)
    # one wrong match: the house's corner paired with a rock in the other photo
    p = shown[1][0]; q = shown[8][1]
    b += line(*p, *q, RED, 1.8, '6 3')
    b += text(170, 36, 'photo 1', FG, 12, 'middle') + text(505, 36, 'photo 2', FG, 12, 'middle')
    b += text(340, 304, 'keypoints (gold): circle size = scale, tick = orientation', GREY, 11, 'middle')
    b += text(340, 320, 'green: correct matches · red: a wrong match that RANSAC removes', GREY, 11, 'middle')
    svg('keypoint-matches.svg', W, H, b)

# ── fundamental-matrix.svg ───────────────────────────────────────────────────
def fmatrix():
    W, H = 680, 470
    # Two cameras 1 m apart, turned slightly toward each other, both looking along +y.
    C1, C2 = (-0.5, 0.0, 0.0), (0.5, 0.0, 0.25)
    R1 = look_at(C1, (0.25, 4, -0.4)); R2 = look_at(C2, (-0.25, 4, -0.2))
    f, cx, cy = 260, 130, 85
    x = (175, 70)                                          # the point in image 1
    d1 = v_norm(tuple(R1[0][i] * (x[0] - cx) / f + R1[1][i] * (x[1] - cy) / f + R1[2][i] for i in range(3)))
    depths = [1.8, 3.0, 5.0]
    Xs = [v_add(C1, v_mul(d1, t)) for t in depths]
    # top view (x across, y up the page)
    T = lambda P: (340 + 110 * P[0], 190 - 34 * P[1])
    b = ''
    far = v_add(C1, v_mul(d1, 5.6))
    b += line(*T(C1), *T(far), BLUE, 1.5)
    b += text(T(far)[0] - 10, T(far)[1] + 4, 'ray of x', BLUE, 11, 'end')
    for k, X in enumerate(Xs):
        b += line(*T(C2), *T(X), DIM, 1, '4 3')
        b += circ(*T(X), 4, GOLD) + text(T(X)[0] - 8, T(X)[1] + 4, f'X{k + 1}', GOLD, 11, 'end')
    b += circ(*T(C1), 5, BLUE) + text(T(C1)[0] - 10, T(C1)[1] + 16, 'camera 1', BLUE, 11, 'end')
    b += circ(*T(C2), 5, BLUE) + text(T(C2)[0] + 10, T(C2)[1] + 16, 'camera 2', BLUE, 11)
    b += text(30, 60, 'the depth along the ray is unknown:', GREY, 11) + text(30, 75, 'X1, X2, X3 all project to x in image 1', GREY, 11)
    # the two images
    I1, I2 = (40, 240), (380, 240)
    b += rect(I1[0], I1[1], 2 * cx, 2 * cy, DIM, fill=RAISED, sw=1) + rect(I2[0], I2[1], 2 * cx, 2 * cy, DIM, fill=RAISED, sw=1)
    b += text(I1[0] + cx, I1[1] + 2 * cy + 18, 'image 1', FG, 12, 'middle') + text(I2[0] + cx, I2[1] + 2 * cy + 18, 'image 2', FG, 12, 'middle')
    b += circ(I1[0] + x[0], I1[1] + x[1], 5, GOLD) + text(I1[0] + x[0] + 9, I1[1] + x[1] + 4, 'x', GOLD, 13)
    ps = [project(R2, C2, f, cx, cy, X)[0] for X in Xs]
    (ax, ay), (bx, by) = ps[0], ps[-1]
    dx, dy = bx - ax, by - ay; L = math.hypot(dx, dy); ux, uy = dx / L, dy / L
    # the epipolar line, clipped to the frame
    ts = []
    for t in [i / 4 for i in range(-4000, 4001)]:
        px, py = ax + ux * t, ay + uy * t
        if 0 <= px <= 2 * cx and 0 <= py <= 2 * cy: ts.append(t)
    e0 = (I2[0] + ax + ux * ts[0], I2[1] + ay + uy * ts[0]); e1 = (I2[0] + ax + ux * ts[-1], I2[1] + ay + uy * ts[-1])
    b += line(*e0, *e1, BLUE, 2)
    b += text(e0[0] + 6, e0[1] + 18, "epipolar line l' = F x", BLUE, 12)
    for k, (px, py) in enumerate(ps):
        b += circ(I2[0] + px, I2[1] + py, 3, GOLD, fill=False, w=1.2)
    # a correct match on the line, an outlier off it with its distance drawn
    g = (I2[0] + ps[1][0], I2[1] + ps[1][1])
    b += circ(*g, 5.5, GREEN) + text(g[0] + 10, g[1] + 16, "x': on the line, kept", GREEN, 11)
    o = (I2[0] + ps[0][0] + 12 * uy * 3.4, I2[1] + ps[0][1] - 12 * ux * 3.4)
    t0 = (o[0] - I2[0] - ax) * ux + (o[1] - I2[1] - ay) * uy
    foot = (I2[0] + ax + ux * t0, I2[1] + ay + uy * t0)
    b += line(*o, *foot, RED, 1.2, '3 2') + circ(*o, 5.5, RED)
    b += text(o[0] - 9, o[1] - 6, 'outlier: off the line, dropped', RED, 11, 'end')
    svg('fundamental-matrix.svg', W, H, b)

# ── homography-vs-fundamental.svg ────────────────────────────────────────────
def homog():
    W, H = 680, 460
    b = ''
    def panel(ox, title, ground, sub):
        # side view: camera 1 and 2 above the scene, the ray from camera 1 through one pixel,
        # and where the scene points along it land on camera 2's image plane
        nonlocal b
        C1, C2 = (ox + 70, 70), (ox + 230, 70)
        b += text(ox + 150, 30, title, FG, 13, 'middle')
        b += poly(ground, GREY, w=2)
        d = v_norm((0.55, 1.0))
        hits = []
        for (gx0, gy0), (gx1, gy1) in zip(ground, ground[1:]):
            s, u = isect(C1, d, (gx0, gy0), (gx1 - gx0, gy1 - gy0))
            if s > 0 and 0 <= u <= 1: hits.append((C1[0] + s * d[0], C1[1] + s * d[1]))
        hits = hits[:1]
        if len(ground) > 2:  # unknown depth: the point may be anywhere along the ray
            s0 = (hits[0][0] - C1[0]) / d[0]
            hits = [(C1[0] + t * d[0], C1[1] + t * d[1]) for t in (s0 * 0.45, s0 * 0.72, s0)]
        far = hits[-1]
        b += line(*C1, far[0] + 10 * d[0], far[1] + 10 * d[1], BLUE, 1.4)
        # camera 2's image plane: a segment 30 px in front of it, facing down-left
        n2 = v_norm((-0.35, 1.0)); t2 = (n2[1], -n2[0])
        P0 = (C2[0] + 30 * n2[0], C2[1] + 30 * n2[1])
        b += line(P0[0] - 34 * t2[0], P0[1] - 34 * t2[1], P0[0] + 34 * t2[0], P0[1] + 34 * t2[1], FG, 2.5)
        imgs = []
        for X in hits:
            e = (X[0] - C2[0], X[1] - C2[1])
            s, u = isect(C2, e, (P0[0] - 34 * t2[0], P0[1] - 34 * t2[1]), (68 * t2[0], 68 * t2[1]))
            imgs.append((C2[0] + s * e[0], C2[1] + s * e[1]))
            b += line(*C2, *X, DIM, 1, '4 3')
            b += circ(*X, 4, GOLD)
        b += cam2d(*C1, math.atan2(d[1], d[0]), label='1', lo=(-14, -8)) + cam2d(*C2, math.atan2(n2[1], n2[0]), label='2', lo=(14, -8))
        if len(imgs) == 1:
            b += circ(*imgs[0], 5, GREEN)
        else:
            b += line(*imgs[0], *imgs[-1], GREEN, 5, op=0.5)
            for p in imgs: b += circ(*p, 3.5, GREEN)
        b += text(ox + 150, 228, sub[0], GREEN, 12, 'middle') + text(ox + 150, 244, sub[1], GREY, 11, 'middle')
    panel(20, 'planar scene', [(ox, 190) for ox in (30, 310)], ('one exact match: x\' = H x', 'no depth, nothing to triangulate'))
    panel(360, 'scene with depth', [(370, 205), (470, 205), (470, 125), (530, 125), (530, 205), (560, 205), (600, 180), (650, 180)],
          ('a line of possible matches', 'its position along the line gives the depth'))
    b += line(20, 268, 660, 268, DIM, 1, '2 4')
    # pure rotation: one centre, two image planes turned about it
    C = (340, 400)
    b += text(340, 296, 'pure rotation: zero baseline', FG, 13, 'middle')
    for k, a in enumerate((-math.pi / 2 - 0.45, -math.pi / 2 + 0.45)):
        n = (math.cos(a), math.sin(a)); t = (-n[1], n[0])
        P0 = (C[0] + 50 * n[0], C[1] + 50 * n[1])
        b += line(P0[0] - 19 * t[0], P0[1] - 19 * t[1], P0[0] + 19 * t[0], P0[1] + 19 * t[1], FG, 2.5)
        b += text(P0[0] + (-1 if k == 0 else 1) * 26, P0[1] + 4, f'image {k + 1}', GREY, 11, 'end' if k == 0 else None)
    for a in (-2.25, -1.85, -1.3, -0.9):
        b += line(*C, C[0] + 120 * math.cos(a), C[1] + 120 * math.sin(a), BLUE, 1, op=0.8)
    b += circ(*C, 5, BLUE)
    b += text(470, 380, 'both images see the same rays:', GREY, 11) + text(470, 395, 'H maps one onto the other,', GREY, 11)
    b += text(470, 410, 'whatever the depth', GREY, 11)
    b += text(210, 380, 'one camera centre', BLUE, 11, 'end') + text(210, 395, 'turned in place', BLUE, 11, 'end')
    svg('homography-vs-fundamental.svg', W, H, b)

# ── cheirality.svg ───────────────────────────────────────────────────────────
def cheir():
    W, H = 680, 340
    b = ''
    # The four (R, t) from E, drawn in the plane of the baseline and the point. Both
    # cameras keep their observations (bearings rA, rB in their own frames). −t puts B on
    # the other side of A; R' (a half turn of B about the baseline) turns B upside down,
    # mirroring its viewing direction and its bearing across the baseline.
    L, a, c = 60, 0.2, 0.9
    cases = [(1, 1, 'in front of both: kept'), (-1, 1, 'behind both'), (1, -1, 'behind A'), (-1, -1, 'behind B')]
    for k, (st, sr, lab) in enumerate(cases):
        ox = 20 + k * 162; cy = 170
        A = (ox + 75 - st * L / 2, cy); B = (A[0] + st * L, cy)
        fA, fB = (0, -1), (0, -sr)
        rA, rB = (a, -1), (-c, -sr)
        s_, u = isect(A, rA, B, rB)
        X = (A[0] + s_ * rA[0], A[1] + s_ * rA[1])
        dA, dB = v_dot(v_sub(X, A), fA), v_dot(v_sub(X, B), fB)
        b += rect(ox, 50, 150, 240, DIM, sw=1, rx=6)
        for P, r_ in ((A, rA), (B, rB)):
            n = v_norm(r_)
            b += line(P[0] - 120 * n[0], P[1] - 120 * n[1], P[0] + 120 * n[0], P[1] + 120 * n[1], DIM, 0.8, '1 4')
        for P, dep in ((A, dA), (B, dB)):
            b += line(*P, *X, BLUE if dep > 0 else RED, 1.6, None if dep > 0 else '5 3')
        b += line(*A, *B, DIM, 1, '3 3')
        for P, f_, nm in ((A, fA, 'A'), (B, fB, 'B')):
            b += cam2d(*P, math.atan2(f_[1], f_[0]), size=15)
            b += text(P[0], P[1] - 18 * f_[1] + 5 * (1 if f_[1] < 0 else -0.2), nm, BLUE, 12, 'middle')
        b += circ(*X, 5.5, GOLD)
        b += text(ox + 75, 312, lab, GREEN if dA > 0 and dB > 0 else RED, 13, 'middle')
    b += text(340, 26, 'the four (R, t) an essential matrix gives: the point lies in front of both cameras in one only', GREY, 11, 'middle')
    b += text(340, 334, 'wedge: where a camera looks · blue: in front of it · red dashed: behind it (negative depth)', GREY, 11, 'middle')
    svg('cheirality.svg', W, H, b)

# ── pnp-resection.svg ────────────────────────────────────────────────────────
def pnp():
    W, H = 680, 360
    b = ''
    C = (250, 300)                                        # the camera centre to find
    look = v_norm((0.08, -1.0)); t = (-look[1], look[0])
    pts = [(80, 110), (170, 70), (260, 95), (340, 60), (420, 120)]
    P0 = (C[0] + 46 * look[0], C[1] + 46 * look[1])
    b += line(P0[0] - 60 * t[0], P0[1] - 60 * t[1], P0[0] + 60 * t[0], P0[1] + 60 * t[1], FG, 3)
    b += text(P0[0] + 66 * t[0] + 6, P0[1] + 66 * t[1] + 4, 'new image', FG, 12)
    for X in pts:
        e = (C[0] - X[0], C[1] - X[1])
        s, u = isect(X, e, (P0[0] - 60 * t[0], P0[1] - 60 * t[1]), (120 * t[0], 120 * t[1]))
        px = (X[0] + s * e[0], X[1] + s * e[1])
        b += line(*X, *C, BLUE, 1.2, op=0.9)
        b += circ(*px, 4, GREEN)
        b += circ(*X, 6, GOLD)
    b += cam2d(*C, math.atan2(look[1], look[0]), size=22)
    b += text(C[0] + 16, C[1] + 22, 'its centre and orientation: the one pose where all rays meet', BLUE, 11)
    b += text(250, 36, 'known 3D tie points', GOLD, 12, 'middle')
    b += text(P0[0] - 66 * t[0] - 6, P0[1] - 66 * t[1] + 4, 'their pixels', GREEN, 11, 'end')
    # inset: triangulation, the dual
    ix, iy = 500, 60
    b += rect(ix, iy, 160, 215, DIM, sw=1, rx=6)
    b += text(ix + 80, iy + 20, 'triangulation (the dual)', FG, 11, 'middle')
    X = (ix + 80, iy + 60)
    for cxp in (ix + 30, ix + 130):
        b += line(cxp, iy + 160, *X, BLUE, 1.2)
        b += cam2d(cxp, iy + 160, math.atan2(X[1] - (iy + 160), X[0] - cxp), size=14)
    b += circ(*X, 6, GOLD)
    b += text(ix + 80, iy + 185, 'known cameras,', GREY, 11, 'middle') + text(ix + 80, iy + 200, 'one unknown point', GREY, 11, 'middle')
    b += text(340, 346, 'resection: known points, one unknown camera; three points fix it, the rest vote in RANSAC', GREY, 11, 'middle')
    svg('pnp-resection.svg', W, H, b)

# ── incremental-sfm.svg ──────────────────────────────────────────────────────
def incsfm():
    W, H = 700, 300
    rnd = random.Random(5)
    # the strip sits lower to leave room for stage 3's loop
    b = ''
    titles = ['1. match graph', '2. initial pair', '3. resect a new camera', '4. after bundle adjustment']
    ground = lambda x: 210 + 10 * math.sin(x / 23)
    for k in range(4):
        ox = 10 + k * 172
        b += rect(ox, 40, 162, 210, DIM, sw=1, rx=6)
        b += text(ox + 81, 270, titles[k], FG, 12, 'middle')
    # 1: nodes and verified pairs, the seed pair picked
    ox = 10
    nodes = [(ox + 40, 90), (ox + 85, 70), (ox + 130, 95), (ox + 45, 150), (ox + 95, 135), (ox + 130, 175), (ox + 70, 205)]
    edges = [(0, 1), (1, 2), (0, 3), (1, 4), (3, 4), (2, 4), (4, 5), (3, 6), (4, 6), (5, 6), (0, 4)]
    for i, j in edges: b += line(*nodes[i], *nodes[j], BLUE, 1.2, op=0.8)
    b += line(*nodes[1], *nodes[4], GOLD, 3.5)
    for p in nodes: b += circ(*p, 6, GOLD if p in (nodes[1], nodes[4]) else GREY)
    # scene points shared by panels 2–4
    def scene(ox, n, xr):
        return [(ox + x, ground(x) - 30 - rnd.uniform(0, 40)) for x in [rnd.uniform(*xr) for _ in range(n)]]
    rnd2 = random.Random(9)
    base = sorted([(x, ground(x) - 22 - rnd2.uniform(0, 45)) for x in [rnd2.uniform(28, 134) for _ in range(9)]])
    more = sorted([(x, ground(x) - 22 - rnd2.uniform(0, 45)) for x in [rnd2.uniform(10, 152) for _ in range(16)]])
    cams2 = [(55, 70), (105, 70)]
    # 2
    ox = 182
    for X in base:
        for cx_, cy_ in cams2: b += line(ox + cx_, cy_, ox + X[0], X[1], BLUE, 0.7, op=0.55)
    for X in base: b += circ(ox + X[0], X[1], 3.2, GOLD)
    for cx_, cy_ in cams2: b += cam2d(ox + cx_, cy_, math.pi / 2, size=13)
    # 3
    ox = 354
    for X in base: b += circ(ox + X[0], X[1], 3.2, GOLD)
    for cx_, cy_ in cams2: b += cam2d(ox + cx_, cy_, math.pi / 2, size=13)
    N = (ox + 140, 82)
    for X in base[4:]: b += line(*N, ox + X[0], X[1], GREEN, 1, op=0.9)
    b += cam2d(*N, math.pi / 2 + 0.5, c=GREEN, size=13)
    b += text(N[0] - 4, N[1] - 14, 'new', GREEN, 11, 'middle')
    b += curve((ox + 40, 36), (ox + 122, 36), 22, GREY, 1.4)
    b += text(ox + 81, 22, 'repeat for each image', GREY, 11, 'middle')
    # 4: the grown block
    ox = 526
    cams4 = [(18 + 26 * i, 70 + 6 * math.sin(i)) for i in range(6)]
    for X in more:
        for cx_, cy_ in cams4:
            if abs(cx_ - X[0]) < 40: b += line(ox + cx_, cy_, ox + X[0], X[1], BLUE, 0.5, op=0.4)
    for X in base + more: b += circ(ox + X[0], X[1], 2.8, GOLD)
    for cx_, cy_ in cams4: b += cam2d(ox + cx_, cy_, math.pi / 2, size=11)
    for k in range(3):
        b += arrow(10 + k * 172 + 164, 145, 10 + (k + 1) * 172 - 2, 145, GREY, 1.4, 6)
    svg('incremental-sfm.svg', W, H, b)

def thumb(x, y, w, h, seed, c=DIM):
    # A small photo: a hill line and a few blobs on a raised ground.
    r = random.Random(seed)
    b = rect(x, y, w, h, c, fill=RAISED, sw=1)
    pts = [(x, y + h * r.uniform(0.45, 0.65))] + [(x + w * t, y + h * r.uniform(0.35, 0.7)) for t in (0.3, 0.6)] + [(x + w, y + h * r.uniform(0.45, 0.65)), (x + w, y + h), (x, y + h)]
    b += poly(pts, DIM, fill=DIM, w=0.5, op=0.6, closed=True)
    for _ in range(2): b += circ(x + w * r.uniform(0.2, 0.8), y + h * r.uniform(0.7, 0.9), min(w, h) * 0.08, GREY)
    return b

# ── bundle-adjustment.svg ────────────────────────────────────────────────────
def bundle():
    W, H = 760, 340
    rnd = random.Random(3)
    cams = [(70, 70), (150, 60), (230, 72)]
    pts = [(40, 210), (85, 235), (130, 205), (175, 240), (215, 215), (255, 232)]
    obs = [(i, j) for i in range(3) for j in range(6) if abs(cams[i][0] - pts[j][0]) < 120]
    def proj(C, ang, X):
        # where X lands on the camera's image line, as an offset along it (px)
        n = (math.cos(ang), math.sin(ang)); t = (-n[1], n[0])
        d = (X[0] - C[0], X[1] - C[1]); z = d[0] * n[0] + d[1] * n[1]; u = d[0] * t[0] + d[1] * t[1]
        return 26 * u / z
    angs = [math.pi / 2] * 3
    b = ''
    MAG = 4  # residuals drawn this many times longer, to be seen
    for pi, (lab, ce, pe, mag) in enumerate([('before', 7, 9, 1), ('after', 0.4, 0.5, 1)]):
        ox = pi * 275
        rc = random.Random(30)
        ecams = [(x + rc.gauss(0, ce), y + rc.gauss(0, ce)) for x, y in cams]
        eangs = [a + rc.gauss(0, 0.05 * ce / 7) for a in angs]
        epts = [(x + rc.gauss(0, pe), y + rc.gauss(0, pe)) for x, y in pts]
        for (i, j) in obs:
            b += line(ox + ecams[i][0], ecams[i][1], ox + epts[j][0], epts[j][1], BLUE, 0.6, op=0.35)
        for i, C in enumerate(ecams):
            a = eangs[i]; n = (math.cos(a), math.sin(a)); t = (-n[1], n[0])
            P0 = (ox + C[0] + 26 * n[0], C[1] + 26 * n[1])
            b += line(P0[0] - 32 * t[0], P0[1] - 32 * t[1], P0[0] + 32 * t[0], P0[1] + 32 * t[1], FG, 2)
            for (ii, j) in obs:
                if ii != i: continue
                um = proj(cams[i], angs[i], pts[j])          # measured: the true point, true camera
                ue = proj(C, a, epts[j])                     # projected: the current estimate
                ue = um + MAG * (ue - um)
                pm = (P0[0] + um * t[0], P0[1] + um * t[1]); pe_ = (P0[0] + ue * t[0], P0[1] + ue * t[1])
                if abs(ue - um) > 3:
                    b += arrow(pe_[0] - 9 * n[0], pe_[1] - 9 * n[1], pm[0] - 9 * n[0], pm[1] - 9 * n[1], RED, 1.3, 5)
                b += circ(*pm, 2.6, GREEN)
                b += circ(*pe_, 2.6, GOLD, fill=False, w=1.2)
            b += cam2d(ox + C[0], C[1], a, size=12)
        for X in epts: b += circ(ox + X[0], X[1], 4, GOLD)
        b += text(ox + 150, 30, lab, FG, 13, 'middle')
    b += text(150, 282, 'red: reprojection error, from where a point', GREY, 11, 'middle') + text(150, 296, 'projects (ring) to its keypoint (green)', GREY, 11, 'middle')
    b += text(150, 310, f'(drawn {MAG}× longer)', GREY, 11, 'middle')
    b += text(425, 282, 'cameras and points moved together:', GREY, 11, 'middle') + text(425, 296, 'the errors shrink everywhere', GREY, 11, 'middle')
    b += line(285, 50, 285, 300, DIM, 1, '2 4') + line(565, 50, 565, 300, DIM, 1, '2 4')
    # the Jacobian's sparsity: one row per observation, a camera block and a point block
    jx, jy, cw, rh = 640, 70, 9, 9.5
    b += text(jx + (3 * 1.6 + 6) * cw / 2, 30, 'Jacobian', FG, 13, 'middle')
    camw, ptw = 1.6 * cw, cw
    for r_, (i, j) in enumerate(obs):
        y = jy + r_ * rh
        b += rect(jx, y, 3 * camw + 6 * ptw, rh, fill=RAISED)
        b += rect(jx + i * camw, y, camw, rh, fill=BLUE)
        b += rect(jx + 3 * camw + j * ptw, y, ptw, rh, fill=GOLD)
    hgt = len(obs) * rh
    b += rect(jx, jy, 3 * camw + 6 * ptw, hgt, DIM, sw=1)
    b += line(jx + 3 * camw, jy - 4, jx + 3 * camw, jy + hgt + 4, FG, 1)
    b += text(jx + 1.5 * camw, jy - 8, 'cameras', BLUE, 10, 'middle') + text(jx + 3 * camw + 3 * ptw, jy - 8, 'points', GOLD, 10, 'middle')
    b += text(jx - 6, jy + hgt / 2, 'observations', GREY, 10, 'end')
    b += text(jx + 50, jy + hgt + 20, 'each row touches one camera', GREY, 10, 'middle') + text(jx + 50, jy + hgt + 33, 'and one point: the points are', GREY, 10, 'middle') + text(jx + 50, jy + hgt + 46, 'eliminated first (Schur)', GREY, 10, 'middle')
    svg('bundle-adjustment.svg', W, H, b)

# ── self-calibration.svg ─────────────────────────────────────────────────────
def selfcal():
    W, H = 680, 330
    b = ''
    rnd = random.Random(6)
    xs = [30 + i * 9 for i in range(29)]
    for pi, (lab, bow, col) in enumerate([('focal too short: the flat ground bends into a bowl', 38, RED), ('after self-calibration: flat', 0, GREEN)]):
        ox = 10 + pi * 340
        cams = [(ox + 50 + 50 * i, 70) for i in range(5)]
        g = lambda x: 200 - bow * ((x - 156) / 126) ** 2
        b += line(ox + 20, 200, ox + 280, 200, DIM, 1, '5 4')
        pts = [(ox + x, g(x) + rnd.gauss(0, 1.5)) for x in xs]
        for C in cams:
            for X in pts[::4]:
                if abs(X[0] - C[0]) < 70: b += line(*C, *X, BLUE, 0.5, op=0.35)
        for X in pts: b += circ(*X, 2.8, GOLD)
        for C in cams: b += cam2d(*C, math.pi / 2, size=11)
        b += text(ox + 150, 30, lab, col if pi else FG, 12, 'middle')
        # the residual pattern left in each image
        fx, fy, fw, fh = ox + 95, 225, 110, 74
        b += rect(fx, fy, fw, fh, DIM, fill=RAISED, sw=1)
        cx, cy = fx + fw / 2, fy + fh / 2
        for i in range(5):
            for j in range(4):
                x = fx + 11 + i * 22; y = fy + 10 + j * 18
                dx, dy = (x - cx) / 55, (y - cy) / 55
                r = math.hypot(dx, dy)
                L = 16 * r ** 3 if pi == 0 else 0
                if L > 2.5:
                    b += arrow(x, y, x + L * dx / r, y + L * dy / r, RED, 1.1, 4)
                else:
                    b += circ(x, y, 1.4, GREY)
        b += text(fx + fw / 2, fy + fh + 16, 'residuals in one image' if pi == 0 else 'residuals: noise only', GREY, 11, 'middle')
    b += text(20, 196, 'true', GREY, 10)
    svg('self-calibration.svg', W, H, b)

# ── cycle-consistency.svg ────────────────────────────────────────────────────
def cycle():
    W, H = 680, 330
    b = ''
    def camtop(x, y, heading, c=BLUE):
        # a camera from above: a small box and the way it faces
        hx, hy = math.cos(heading), math.sin(heading)
        return rect(x - 9, y - 9, 18, 18, c, fill=RAISED, sw=1.6, rx=3) + arrow(x, y, x + 24 * hx, y + 24 * hy, c, 1.8, 6)
    for pi, ok in enumerate((True, False)):
        ox = pi * 340
        P = {'i': (ox + 80, 230), 'j': (ox + 170, 80), 'k': (ox + 260, 230)}
        hd = {'i': -0.3, 'j': 0.9, 'k': 2.4}
        for (a, c_, lab, bad) in (('i', 'j', 'R_ij', False), ('j', 'k', 'R_jk', not ok), ('i', 'k', 'R_ik', False)):
            p, q = P[a], P[c_]
            d = math.hypot(q[0] - p[0], q[1] - p[1]); u = ((q[0] - p[0]) / d, (q[1] - p[1]) / d)
            p2 = (p[0] + 22 * u[0], p[1] + 22 * u[1]); q2 = (q[0] - 22 * u[0], q[1] - 22 * u[1])
            bend = -16 if lab != 'R_ik' else 16
            b += curve(p2, q2, bend, RED if bad else GREY, 3 if bad else 1.6)
            mx, my = (p[0] + q[0]) / 2 + (u[1] * 30 if lab != 'R_ik' else -u[1] * 34), (p[1] + q[1]) / 2 - (u[0] * 30 if lab != 'R_ik' else -u[0] * 34)
            b += text(mx, my + 4, lab, RED if bad else FG, 13, 'middle')
        for nm, (x, y) in P.items():
            b += camtop(x, y, hd[nm]) + text(x + (-22 if nm == 'i' else 22 if nm == 'k' else 0), y + (26 if nm != 'j' else -18), nm, BLUE, 14, 'middle')
        x, y = P['i']
        if ok:
            b += path(f'M {x - 46} {y - 22} l 6 7 l 13 -15', GREEN, w=3)
            b += text(ox + 170, 290, 'around the loop and back: the identity', GREEN, 12, 'middle')
        else:
            # the composed rotation returns turned away from i's own heading
            r = 34; a0, a1 = hd['i'], hd['i'] + 0.6
            b += arrow(x, y, x + 30 * math.cos(a1), y + 30 * math.sin(a1), RED, 1.6, 6, '4 3')
            arc = [(x + r * math.cos(a0 + (a1 - a0) * t / 12), y + r * math.sin(a0 + (a1 - a0) * t / 12)) for t in range(13)]
            b += poly(arc, RED, w=1.6)
            b += text(x - 6, y + 46, 'residual turn', RED, 11, 'end')
            b += text(ox + 170, 290, 'one pair is wrong: the loop does not close', RED, 12, 'middle')
        b += text(ox + 170, 310, 'R_ik⁻¹ · R_jk · R_ij', GREY, 11, 'middle')
    b += line(340, 40, 340, 310, DIM, 1, '2 4')
    b += text(340, 24, 'compose the relative rotations around a loop of three images', GREY, 11, 'middle')
    svg('cycle-consistency.svg', W, H, b)

# ── preselection.svg ─────────────────────────────────────────────────────────
def presel():
    W, H = 680, 380
    N, cell = 16, 17
    ox, oy = 90, 80
    b = ''
    loops = {(0, 13), (1, 14), (2, 15), (0, 15), (5, 10)}
    seq = 3
    matched = 0
    for i in range(N):
        for j in range(i + 1, N):
            x, y = ox + j * cell, oy + i * cell
            if j - i <= seq: c = BLUE; matched += 1
            elif (i, j) in loops: c = GOLD; matched += 1
            else: c = None
            b += rect(x + 1, y + 1, cell - 2, cell - 2, fill=c or RAISED, op=None if c else 0.8)
    for i in range(N):
        b += thumb(ox + i * cell + 1.5, oy - 22, cell - 3, 13, 100 + i)
        b += thumb(ox - 22, oy + i * cell + 2, 15, cell - 4, 100 + i)
    b += text(ox + N * cell / 2, oy - 32, 'image', GREY, 11, 'middle')
    b += text(ox - 30, oy + N * cell / 2, 'image', GREY, 11, 'end')
    total = N * (N - 1) // 2
    lx = ox + N * cell + 40
    b += rect(lx, 110, 14, 14, fill=RAISED) + text(lx + 22, 122, f'every pair: {total} for {N} images', GREY, 12)
    b += rect(lx, 140, 14, 14, fill=BLUE) + text(lx + 22, 152, f'capture order: the next {seq} images', BLUE, 12)
    b += rect(lx, 170, 14, 14, fill=GOLD) + text(lx + 22, 182, 'loop closures', GOLD, 12)
    b += text(lx, 220, f'matched: {matched} of {total} pairs', FG, 13)
    b += text(lx, 244, 'the count grows with N,', GREY, 11) + text(lx, 259, 'not with N²', GREY, 11)
    b += text(340, 20, 'which pairs to match: the strip of neighbours, and a few where the flight comes back', GREY, 11, 'middle')
    svg('preselection.svg', W, H, b)

# ── matching-density.svg ─────────────────────────────────────────────────────
def mdensity():
    W, H = 680, 380
    rnd = random.Random(21)
    b = ''
    # scene features: a few strong corners and many weaker ones over the overlap
    strong = [(rnd.uniform(0.1, 0.9), rnd.uniform(0.1, 0.9)) for _ in range(7)]
    weak = [(rnd.uniform(0.02, 0.98), rnd.uniform(0.02, 0.98)) for _ in range(170)]
    for pi, (lab, sub) in enumerate([('Fast', 'one pass on the strongest keypoints'), ('Full (tiled)', 'coarse pass, then each tile in turn')]):
        ox = 20 + pi * 330
        fw, fh = 300, 110
        I1, I2 = (ox, 60), (ox, 230)
        sh = 0.28  # image 2 sees the scene shifted by this fraction of the width
        for (fx, fy) in (I1, I2): b += rect(fx, fy, fw, fh, DIM, fill=RAISED, sw=1)
        # the overlap: scene x in [sh, 1] of image 1 is [0, 1 - sh] of image 2
        b += rect(I1[0] + sh * fw, I1[1], (1 - sh) * fw, fh, BLUE, sw=1, op=0.5, dash='4 3')
        b += rect(I2[0], I2[1], (1 - sh) * fw, fh, BLUE, sw=1, op=0.5, dash='4 3')
        if pi == 1:
            for k in range(1, 4):
                b += line(I1[0] + sh * fw + k * (1 - sh) * fw / 4, I1[1], I1[0] + sh * fw + k * (1 - sh) * fw / 4, I1[1] + fh, GREY, 0.8, '2 3')
                b += line(I2[0] + k * (1 - sh) * fw / 4, I2[1], I2[0] + k * (1 - sh) * fw / 4, I2[1] + fh, GREY, 0.8, '2 3')
            b += line(I1[0] + sh * fw, I1[1] + fh / 2, I1[0] + fw, I1[1] + fh / 2, GREY, 0.8, '2 3')
            b += line(I2[0], I2[1] + fh / 2, I2[0] + (1 - sh) * fw, I2[1] + fh / 2, GREY, 0.8, '2 3')
        if pi == 0:
            feats = [(x, y) for (x, y) in strong for _ in range(1)] + [(x + rnd.gauss(0, 0.03), y + rnd.gauss(0, 0.05)) for (x, y) in strong for _ in range(3)]
        else:
            feats = strong + weak
        n = 0
        for (sx, sy) in feats:
            # scene coordinates span image 1 x ∈ [0,1]; in image 2 the same point is at x − sh
            x1 = sx; x2 = sx - sh
            if not (sh + 0.01 < x1 < 0.99 and 0.01 < x2 < 1 - sh - 0.01 and 0.03 < sy < 0.97): continue
            p = (I1[0] + x1 * fw, I1[1] + sy * fh); q = (I2[0] + x2 * fw, I2[1] + sy * fh)
            b += line(*p, *q, GREEN, 0.7, op=0.6)
            b += circ(*p, 1.8, GOLD) + circ(*q, 1.8, GOLD)
            n += 1
        b += text(ox + fw / 2, 34, lab, FG, 13, 'middle')
        b += text(ox + fw / 2, 50, sub, GREY, 11, 'middle')
        b += text(ox + fw / 2, 362, f'{n} matches', GREEN, 12, 'middle')
        b += text(ox - 4, I1[1] + fh / 2, '1', GREY, 11, 'end') + text(ox - 4, I2[1] + fh / 2, '2', GREY, 11, 'end')
    svg('matching-density.svg', W, H, b)

# ── sensor-grouping.svg ──────────────────────────────────────────────────────
def sensors():
    W, H = 680, 360
    b = ''
    groups = [('sensor 1: drone camera', 5, 20, 'f = 3,650 px', 'k1 k2 k3 p1 p2'), ('sensor 2: film camera', 3, 400, 'f = 153.2 mm', 'k1 k2 · fiducials')]
    for gi, (lab, n, ox, fl, dist) in enumerate(groups):
        gw = n * 70 + 10
        b += rect(ox, 40, gw, 290, DIM, sw=1, rx=8)
        b += text(ox + gw / 2, 62, lab, FG, 13, 'middle')
        bx, by, bw = ox + gw / 2 - 85, 90, 170
        b += rect(bx, by, bw, 62, GOLD, fill=RAISED, sw=1.6, rx=5)
        b += text(bx + bw / 2, by + 20, 'shared: K, ' + fl, GOLD, 12, 'middle')
        b += text(bx + bw / 2, by + 38, 'principal point cx, cy', GOLD, 11, 'middle')
        b += text(bx + bw / 2, by + 54, 'distortion ' + dist, GOLD, 11, 'middle')
        for k in range(n):
            tx = ox + 12 + k * 70
            b += thumb(tx, 230, 56, 40, 7 + gi * 10 + k)
            b += arrow(tx + 28, 226, bx + bw / 2 + (tx + 28 - (bx + bw / 2)) * 0.25, by + 66, GOLD, 1.1, 6, op=0.8)
            b += text(tx + 28, 290, f'R{k + 1}, t{k + 1}', BLUE, 12, 'middle')
    b += text(340, 24, 'one set of intrinsics per sensor, solved from all its photos', GREY, 11, 'middle')
    b += text(340, 350, 'within a group only the pose (blue) differs from photo to photo', GREY, 11, 'middle')
    svg('sensor-grouping.svg', W, H, b)

# ── raster images: computed small, embedded as PNG ───────────────────────────
# Image content (a photo, a depth map, a filter response) is computed at a few dozen
# pixels and embedded as a PNG data URI, far smaller than one rect per pixel. Its
# colours are data, the same in both themes.
import zlib, struct, base64
def png_uri(px):
    # px: rows of (r, g, b) or None (transparent)
    h, w = len(px), len(px[0])
    raw = b''.join(b'\x00' + b''.join(bytes((0, 0, 0, 0)) if p is None else bytes((*(max(0, min(255, round(v))) for v in p), 255)) for p in row) for row in px)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    return 'data:image/png;base64,' + base64.b64encode(data).decode()
def image(x, y, w, h, px, smooth=True, op=None):
    st = '' if smooth else ' style="image-rendering:pixelated"'
    o = f' opacity="{op}"' if op is not None else ''
    return f'  <image x="{f2(x)}" y="{f2(y)}" width="{f2(w)}" height="{f2(h)}" preserveAspectRatio="none"{st}{o} href="{png_uri(px)}"/>\n'
def gray_px(img, lo=None, hi=None):
    vals = [v for row in img for v in row if v is not None]
    lo = min(vals) if lo is None else lo; hi = max(vals) if hi is None else hi
    return [[None if v is None else (lambda g: (g, g, g))(255 * (v - lo) / ((hi - lo) or 1)) for v in row] for row in img]
def map_px(img, colour):
    return [[None if v is None else tuple(int(colour(v)[k:k + 2], 16) for k in (1, 3, 5)) for v in row] for row in img]
def conv1(img, k, axis):
    h, w = len(img), len(img[0]); r = len(k) // 2
    out = [[0.0] * w for _ in range(h)]
    for j in range(h):
        for i in range(w):
            s = 0.0
            for t, kv in enumerate(k):
                if axis == 0: ii = min(w - 1, max(0, i + t - r)); s += kv * img[j][ii]
                else: jj = min(h - 1, max(0, j + t - r)); s += kv * img[jj][i]
            out[j][i] = s
    return out
def gauss(img, sigma):
    if sigma <= 0: return [row[:] for row in img]
    r = max(1, int(3 * sigma)); k = [math.exp(-(t * t) / (2 * sigma * sigma)) for t in range(-r, r + 1)]; S = sum(k); k = [v / S for v in k]
    return conv1(conv1(img, k, 0), k, 1)
def laplacian(img):
    h, w = len(img), len(img[0]); g = lambda j, i: img[min(h - 1, max(0, j))][min(w - 1, max(0, i))]
    return [[g(j - 1, i) + g(j + 1, i) + g(j, i - 1) + g(j, i + 1) - 4 * g(j, i) for i in range(w)] for j in range(h)]
def scene_img(w, h, seed=1):
    # A textured aerial-ish scene: smooth terrain shading, fields with edges, a few blobs.
    r = random.Random(seed)
    waves = [(r.uniform(0.05, 0.3), r.uniform(0.05, 0.3), r.uniform(0, 6), r.uniform(0.05, 0.15)) for _ in range(5)]
    blobs = [(r.uniform(0, w), r.uniform(0, h), r.uniform(1.2, 3.5), r.choice((-0.35, 0.35))) for _ in range(14)]
    rects = [(r.uniform(0, w * 0.8), r.uniform(0, h * 0.8), r.uniform(6, 16), r.uniform(5, 12), r.uniform(-0.2, 0.2)) for _ in range(4)]
    img = []
    for j in range(h):
        row = []
        for i in range(w):
            v = 0.5 + sum(a * math.sin(fx * i + fy * j + ph) for fx, fy, ph, a in waves)
            for (x0, y0, rw, rh, dv) in rects:
                if x0 <= i < x0 + rw and y0 <= j < y0 + rh: v += dv
            for (bx, by, br, dv) in blobs:
                if (i - bx) ** 2 + (j - by) ** 2 < br * br: v += dv
            v += r.gauss(0, 0.025)
            row.append(v)
        img.append(row)
    return img

# ── sift-scale-space.svg ─────────────────────────────────────────────────────
def siftscale():
    W, H = 700, 360
    base = scene_img(40, 40, 3)
    b = ''
    sig = [1.0, 1.6, 2.6, 4.1]
    rows = []
    for o, size in enumerate((96, 48)):
        src = base if o == 0 else [row[::2] for row in base[::2]]
        levels = [gauss(src, s / (1 if o == 0 else 1)) for s in sig]
        rows.append((size, levels))
    b += text(110, 26, 'Gaussian scale space', FG, 13, 'middle') + text(360, 26, 'difference of Gaussians', FG, 13, 'middle') + text(590, 26, 'extremum test', FG, 13, 'middle')
    y0 = 50
    for o, (size, levels) in enumerate(rows):
        oy = y0 + (0 if o == 0 else 170)
        for k, lev in enumerate(levels):
            x = 20 + k * 14; y = oy + 30 - k * 10
            b += image(x, y, size, size, gray_px(lev, 0.1, 0.95)) + rect(x, y, size, size, DIM, sw=0.8)
        b += text(20, oy + size + 52 if o == 0 else oy + size + 50, f'octave {o + 1}' + (': half the size' if o else ''), GREY, 11)
        dogs = [[[a - c for a, c in zip(ra, rc)] for ra, rc in zip(levels[k + 1], levels[k])] for k in range(3)]
        m = max(abs(v) for d in dogs for row in d for v in row)
        for k, d in enumerate(dogs):
            x = 290 + k * 14; y = oy + 30 - k * 10
            b += image(x, y, size, size, map_px(d, lambda v: ramp((v / m + 1) / 2, DIVERGE))) + rect(x, y, size, size, DIM, sw=0.8)
        b += arrow(150 if o == 0 else 100, oy + 30 + size / 2, 280, oy + 30 + size / 2, GREY, 1.4, 7)
        b += text(215, oy + 22 + size / 2, 'subtract', GREY, 11, 'middle') if o == 0 else ''
    # the 3×3×3 neighbourhood: three layers in a skewed view
    cx, cy, c = 560, 110, 24
    for li, (lab, dy) in enumerate((('scale above', -68), ('this scale', 0), ('scale below', 68))):
        for j in range(3):
            for i in range(3):
                x = cx + i * c + j * 14; y = cy + dy + 44 + j * 14
                pts = [(x, y), (x + c, y), (x + c + 14, y + 14), (x + 14, y + 14)]
                centre = li == 1 and i == 1 and j == 1
                b += poly(pts, BLUE, fill=GOLD if centre else BLUE, w=1, op=1 if centre else 0.35, closed=True) + poly(pts, BLUE, w=1, closed=True)
        b += text(cx - 8, cy + dy + 66, lab, GREY, 11, 'end')
    b += text(590, 330, 'a keypoint: larger (or smaller)', GOLD, 12, 'middle') + text(590, 346, 'than all 26 neighbours', GOLD, 12, 'middle')
    b += text(360, 330, 'blob-like structure lights up', GREY, 11, 'middle') + text(360, 346, 'at its own scale', GREY, 11, 'middle')
    svg('sift-scale-space.svg', W, H, b)

# ── sift-descriptor.svg ──────────────────────────────────────────────────────
def siftdesc():
    W, H = 700, 330
    n = 32
    ang0 = math.radians(28)  # the patch's dominant orientation
    # a patch: a bright corner turned by ang0, with some texture
    r = random.Random(4)
    img = []
    for j in range(n):
        row = []
        for i in range(n):
            u, v = rot2((i - n / 2 + 0.5, j - n / 2 + 0.5), -ang0)
            val = 0.25 + (0.55 if (u > -3 and v > -6) else 0) + 0.12 * math.sin(0.9 * u) * (v < -6) + r.gauss(0, 0.03)
            row.append(val)
        img.append(row)
    img = gauss(img, 0.8)
    b = ''
    S = 200; px0, py0 = 30, 70
    b += image(px0, py0, S, S, gray_px(img, 0.1, 0.95))
    c0 = (px0 + S / 2, py0 + S / 2)
    # the 4×4 grid, turned to the dominant orientation
    half = S * 0.34
    for k in range(5):
        t = -half + k * half / 2
        p1, p2 = rot2((c0[0] + t, c0[1] - half), ang0, c0), rot2((c0[0] + t, c0[1] + half), ang0, c0)
        q1, q2 = rot2((c0[0] - half, c0[1] + t), ang0, c0), rot2((c0[0] + half, c0[1] + t), ang0, c0)
        b += line(*p1, *p2, BLUE, 1.2) + line(*q1, *q2, BLUE, 1.2)
    e = rot2((c0[0] + half + 18, c0[1]), ang0, c0)
    b += arrow(*c0, *e, GOLD, 2.2, 9) + circ(*c0, 4, GOLD)
    b += text(px0 + S / 2, 52, 'the patch at the keypoint’s scale,', GREY, 11, 'middle') + text(px0 + S / 2, 290, 'grid turned to its dominant orientation (gold)', GREY, 11, 'middle')
    # gradients per cell (in the patch's own frame), one cell picked
    gx = [[(img[j][min(n - 1, i + 1)] - img[j][max(0, i - 1)]) / 2 for i in range(n)] for j in range(n)]
    gy = [[(img[min(n - 1, j + 1)][i] - img[max(0, j - 1)][i]) / 2 for i in range(n)] for j in range(n)]
    def hist(ci, cj):
        h = [0.0] * 8
        for j in range(n):
            for i in range(n):
                u, v = rot2((i - n / 2 + 0.5, j - n / 2 + 0.5), -ang0)
                cu, cv = int((u + half * n / S) // (half * n / S / 2)), int((v + half * n / S) // (half * n / S / 2))
                if (cu, cv) != (ci, cj): continue
                a = (math.atan2(gy[j][i], gx[j][i]) - ang0) % (2 * math.pi)
                h[int(a / (math.pi / 4)) % 8] += math.hypot(gx[j][i], gy[j][i])
        return h
    pick = (1, 1)
    # highlight the picked cell
    corners = [(-half + pick[0] * half / 2, -half + pick[1] * half / 2), (-half + (pick[0] + 1) * half / 2, -half + pick[1] * half / 2),
               (-half + (pick[0] + 1) * half / 2, -half + (pick[1] + 1) * half / 2), (-half + pick[0] * half / 2, -half + (pick[1] + 1) * half / 2)]
    cc = [rot2((c0[0] + u, c0[1] + v), ang0, c0) for u, v in corners]
    b += poly(cc, GOLD, fill=GOLD, w=2, op=0.35, closed=True) + poly(cc, GOLD, w=2, closed=True)
    hh = hist(*pick); m = max(hh) or 1
    # the cell's histogram as a rose of 8 arrows, and as bars
    rx, ry = 340, 170
    b += line(cc[1][0], cc[1][1], rx - 70, ry - 40, GOLD, 1, '3 3') + line(cc[2][0], cc[2][1], rx - 70, ry + 40, GOLD, 1, '3 3')
    for k in range(8):
        a = k * math.pi / 4; L = 12 + 52 * hh[k] / m
        b += arrow(rx, ry, rx + L * math.cos(a), ry + L * math.sin(a), GOLD, 2, 7)
    b += circ(rx, ry, 3, GOLD)
    b += text(rx, 82, 'one cell: gradient directions', GREY, 11, 'middle') + text(rx, 96, 'summed into 8 bins', GREY, 11, 'middle')
    bx, by = 440, 120
    for k in range(8):
        hgt = 90 * hh[k] / m
        b += rect(bx + k * 16, by + 100 - hgt, 12, hgt, fill=GOLD)
    b += line(bx - 4, by + 100, bx + 130, by + 100, GREY, 1)
    b += text(bx + 62, by + 118, '8 bins', GREY, 11, 'middle')
    b += text(550, 286, '4 × 4 cells × 8 bins = 128 numbers', FG, 14, 'middle')
    b += text(550, 306, 'normalised: brightness and contrast drop out', GREY, 11, 'middle')
    svg('sift-descriptor.svg', W, H, b)

# ── image-sharpness.svg ──────────────────────────────────────────────────────
def sharp():
    W, H = 700, 340
    img = scene_img(44, 44, 8)
    k = [1 / 7] * 7
    blur = conv1(img, k, 0)                                 # motion blur: along x
    L1, L2 = laplacian(img), laplacian(blur)
    var = lambda L: (lambda v: sum((x - sum(v) / len(v)) ** 2 for x in v) / len(v))([x for row in L for x in row])
    v1, v2 = var(L1), var(L2)
    m = max(abs(x) for row in L1 for x in row) * 0.7
    b = ''
    S = 110
    for ri, (lab, im, L, c) in enumerate((('sharp', img, L1, BLUE), ('motion-blurred', blur, L2, GOLD))):
        y = 50 + ri * 140
        b += image(30, y, S, S, gray_px(im, 0.0, 1.0)) + rect(30, y, S, S, c, sw=2)
        b += image(170, y, S, S, map_px(L, lambda v: ramp((max(-1, min(1, v / m)) + 1) / 2, GRAYS))) + rect(170, y, S, S, c, sw=2)
        b += text(30, y - 8, lab, c, 12)
        b += arrow(144, y + S / 2, 166, y + S / 2, GREY, 1.2, 5)
    b += text(225, 40, 'Laplacian', GREY, 11, 'middle')
    # histograms of the Laplacian values
    hx, hy, hw, hh_ = 340, 60, 330, 200
    nb = 31
    def histo(L):
        h = [0] * nb
        for row in L:
            for x in row:
                k_ = int((max(-1, min(0.999, x / m)) + 1) / 2 * nb); h[k_] += 1
        return h
    h1, h2 = histo(L1), histo(L2)
    top = max(h1 + h2)
    bw = hw / nb
    for h, c in ((h2, GOLD), (h1, BLUE)):
        pts = [(hx, hy + hh_)] + [(hx + (k_ + 0.5) * bw, hy + hh_ - hh_ * h[k_] / top) for k_ in range(nb)] + [(hx + hw, hy + hh_)]
        b += poly(pts, c, fill=c, w=1.6, op=0.35, closed=True) + poly(pts, c, w=1.8)
    b += line(hx, hy + hh_, hx + hw, hy + hh_, GREY, 1) + line(hx + hw / 2, hy + hh_, hx + hw / 2, hy + hh_ + 5, GREY, 1)
    b += text(hx + hw / 2, hy + hh_ + 18, '0', GREY, 11, 'middle') + text(hx + hw / 2, hy + hh_ + 34, 'Laplacian value', GREY, 11, 'middle')
    b += text(hx + hw, hy + 20, f'sharp: wide, variance {v1 / v1:.2f}', BLUE, 12, 'end')
    b += text(hx + hw, hy + 38, f'blurred: narrow, variance {v2 / v1:.2f}', GOLD, 12, 'end')
    b += text(350, 330, 'blur removes fine detail, so the Laplacian’s spread drops: that spread is the sharpness score', GREY, 11, 'middle')
    svg('image-sharpness.svg', W, H, b)

# ── image-mask.svg ───────────────────────────────────────────────────────────
def imask():
    W, H = 700, 320
    w, h = 96, 64
    hz = 22                                                  # horizon row
    tex = scene_img(w, h, 12)
    leg = lambda i, j: 0 <= (i - 70) - (j - 40) * 0.6 <= 9 and j >= 36
    sky = lambda i, j: j < hz + 2 * math.sin(i / 9)
    photo, mask, depth = [], [], []
    for j in range(h):
        pr, mr, dr = [], [], []
        for i in range(w):
            if leg(i, j): v = (40, 40, 44); m = True; d = None
            elif sky(i, j): g = 205 - j * 1.5; v = (g * 0.8, g * 0.88, g); m = True; d = None
            else:
                t = tex[j][i]; v = (90 + 80 * t, 95 + 70 * t, 70 + 50 * t); m = False
                d = ((h - j) / (h - hz)) ** 1.4
            pr.append(v); mr.append(m); dr.append(d)
        photo.append(pr); mask.append(mr); depth.append(dr)
    S = 3  # px per image pixel on screen
    b = ''
    x1, y1 = 30, 50
    b += image(x1, y1, w * S, h * S, photo)
    b += image(x1, y1, w * S, h * S, [[(239, 111, 108) if m else None for m in row] for row in mask], op=0.7)
    # keypoints where the texture has contrast, kept only off the mask
    L = laplacian(gauss(tex, 0.7))
    cand = sorted(((abs(L[j][i]), i, j) for j in range(2, h - 2) for i in range(2, w - 2)), reverse=True)
    kept, dropped = [], []
    for s, i, j in cand:
        if any(abs(i - a) < 6 and abs(j - c) < 6 for _, a, c in kept + dropped): continue
        (dropped if mask[j][i] else kept).append((s, i, j))
        if len(kept) >= 34: break
    for _, i, j in kept: b += circ(x1 + (i + 0.5) * S, y1 + (j + 0.5) * S, 4, GOLD, fill=False, w=1.4)
    b += rect(x1, y1, w * S, h * S, DIM, sw=1)
    b += text(x1 + w * S / 2, 36, 'photo: sky and landing leg masked (red)', FG, 12, 'middle')
    b += text(x1 + w * S / 2, y1 + h * S + 20, 'keypoints (gold) only on the unmasked ground', GOLD, 11, 'middle')
    x2 = 380
    dmax = max(d for row in depth for d in row if d is not None)
    b += rect(x2, y1, w * S, h * S, DIM, fill=RAISED, sw=1)
    b += image(x2, y1, w * S, h * S, map_px([[None if d is None else d / dmax for d in row] for row in depth],
                                         lambda t: ramp(t, ((0, (238, 214, 120)), (0.5, (96, 162, 146)), (1, (66, 76, 150))))))
    b += rect(x2, y1, w * S, h * S, DIM, sw=1)
    b += text(x2 + w * S / 2, 36, 'its depth map', FG, 12, 'middle')
    b += text(x2 + w * S / 2, y1 + h * S + 20, 'near (yellow) to far (blue); masked pixels get no depth', GREY, 11, 'middle')
    svg('image-mask.svg', W, H, b)

# ── fiducial-marks.svg ───────────────────────────────────────────────────────
def fiducial():
    W, H = 700, 360
    b = ''
    FW = 230                                               # frame size on screen (230 mm → 1 px/mm)
    marks = [(-1, -1), (1, -1), (1, 1), (-1, 1), (0, -1), (1, 0), (0, 1), (-1, 0)]
    def fmark(x, y, c, corner):
        if corner: return line(x - 6, y, x + 6, y, c, 1.6) + line(x, y - 6, x, y + 6, c, 1.6) + circ(x, y, 9, c, fill=False, w=1)
        return poly([(x - 5, y - 5), (x + 5, y - 5), (x, y + 3)], c, fill=c, w=1, closed=True) if y < 0 else circ(x, y, 4, c)
    # left: the scan, frame turned 3° and shifted on the scanner bed
    ox, oy = 30, 50
    b += rect(ox, oy, 300, 280, DIM, fill='none', sw=1, dash='4 3')
    b += text(ox + 4, oy + 274, 'scanner bed (scan pixels)', GREY, 10)
    c = (ox + 160, oy + 135); ang = math.radians(-3.5); sc = 0.98
    corners = [rot2((c[0] + sx * FW / 2 * sc, c[1] + sy * FW / 2 * sc), ang, c) for sx, sy in [(-1, -1), (1, -1), (1, 1), (-1, 1)]]
    b += poly(corners, DIM, fill=RAISED, w=1.2, closed=True)
    hill = [rot2((c[0] + x * sc, c[1] + y * sc), ang, c) for x, y in [(-110, 40), (-60, 0), (-10, 25), (40, -15), (110, 20), (110, 110), (-110, 110)]]
    b += poly(hill, DIM, fill=DIM, w=0.5, op=0.6, closed=True)
    for (sx, sy) in marks:
        p = rot2((c[0] + sx * (FW / 2 - 8) * sc, c[1] + sy * (FW / 2 - 8) * sc), ang, c)
        b += circ(*p, 4, GOLD) + circ(*p, 9, GOLD, fill=False, w=1.2)
    b += text(ox + 150, 34, 'scan: frame turned and offset', FG, 12, 'middle')
    b += curve((345, 170), (395, 170), -22, GREY, 1.8)
    b += text(370, 140, 'affine fit', GREY, 11, 'middle')
    # right: the frame in the camera's mm system, fiducials on their certified places
    ox2, oy2 = 410, 55
    c2 = (ox2 + FW / 2 + 15, oy2 + FW / 2 + 20)
    b += rect(c2[0] - FW / 2, c2[1] - FW / 2, FW, FW, DIM, fill=RAISED, sw=1.2)
    for k in range(-5, 6):
        g = k * 20
        if abs(g) <= FW / 2:
            b += line(c2[0] + g, c2[1] - FW / 2, c2[0] + g, c2[1] + FW / 2, DIM, 0.6) + line(c2[0] - FW / 2, c2[1] + g, c2[0] + FW / 2, c2[1] + g, DIM, 0.6)
    b += poly([(c2[0] + x, c2[1] + y) for x, y in [(-110, 40), (-60, 0), (-10, 25), (40, -15), (110, 20), (110, 110), (-110, 110)]], DIM, fill=DIM, w=0.5, op=0.45, closed=True)
    for (sx, sy) in marks:
        p = (c2[0] + sx * (FW / 2 - 8), c2[1] + sy * (FW / 2 - 8))
        b += circ(*p, 9, GOLD, fill=False, w=1.2) + circ(p[0] + 0.6, p[1] - 0.5, 2.5, GREEN)
    pp = (c2[0] + 2.5, c2[1] - 1.5)
    b += line(pp[0] - 9, pp[1], pp[0] + 9, pp[1], RED, 2) + line(pp[0], pp[1] - 9, pp[0], pp[1] + 9, RED, 2)
    b += text(pp[0] + 12, pp[1] - 8, 'principal point', RED, 11)
    b += text(c2[0] - FW / 2, c2[1] + FW / 2 + 16, '−115', GREY, 10, 'middle') + text(c2[0] + FW / 2, c2[1] + FW / 2 + 16, '+115 mm', GREY, 10, 'middle')
    b += text(c2[0], 34, 'camera frame (mm): axes aligned', FG, 12, 'middle')
    b += text(c2[0], c2[1] + FW / 2 + 34, 'green: measured marks, landing on their certified places', GREY, 11, 'middle')
    svg('fiducial-marks.svg', W, H, b)

# ── depth-map.svg ────────────────────────────────────────────────────────────
def depthmap():
    W, H = 700, 400
    # A scene ray-cast through one camera: textured ground (z = 0) and a box.
    C = (0.0, -6.0, 3.2); R = look_at(C, (0.0, 2.0, 0.0)); w, h = 96, 64; f = 70
    box = ((-1.0, 0.0, 0.0), (1.4, 2.2, 1.6))
    tex = scene_img(64, 64, 15)
    sun = v_norm((-0.4, -0.6, 0.7))
    def cast(i, j):
        d = v_norm(v_add(v_add(v_mul(R[0], (i + 0.5 - w / 2) / f), v_mul(R[1], (j + 0.5 - h / 2) / f)), R[2]))
        best = (1e9, None, None)
        # slab test for the box
        t0, t1, n0 = -1e9, 1e9, None
        for a in range(3):
            if abs(d[a]) < 1e-9:
                if not (box[0][a] <= C[a] <= box[1][a]): t0, t1 = 1, 0
                continue
            ta, tb = (box[0][a] - C[a]) / d[a], (box[1][a] - C[a]) / d[a]
            na = tuple((-1 if k == a else 0) * (1 if d[a] > 0 else -1) for k in range(3))
            if ta > tb: ta, tb = tb, ta
            if ta > t0: t0, n0 = ta, na
            t1 = min(t1, tb)
        if t0 <= t1 and t0 > 0: best = (t0, n0, 'box')
        if d[2] < 0:
            tg = -C[2] / d[2]
            if tg < best[0]: best = (tg, (0, 0, 1), 'ground')
        return best, d
    photo, depth = [], []
    for j in range(h):
        pr, dr = [], []
        for i in range(w):
            (t, n, what), d = cast(i, j)
            if what is None: pr.append((150, 170, 196)); dr.append(None); continue
            X = v_add(C, v_mul(d, t))
            lit = 0.45 + 0.55 * max(0, v_dot(n, sun))
            if what == 'ground':
                tv = tex[int(X[1] * 4) % 64][int(X[0] * 4 + 32) % 64]
                base = (90 + 70 * tv, 100 + 60 * tv, 72 + 40 * tv)
            else: base = (190, 178, 160)
            pr.append(tuple(v * lit for v in base)); dr.append(t)
        photo.append(pr); depth.append(dr)
    ds = sorted(t for row in depth for t in row if t is not None)
    lo, hi = ds[0], ds[int(0.95 * len(ds))]   # the far ground would flatten the ramp: clamp at the 90th percentile
    S = 3; y0 = 50
    xA, xB = 20, 330
    b = image(xA, y0, w * S, h * S, photo) + rect(xA, y0, w * S, h * S, DIM, sw=1)
    b += rect(xB, y0, w * S, h * S, DIM, fill=RAISED, sw=1)
    DEPTH = ((0, (238, 214, 120)), (0.5, (96, 162, 146)), (1, (66, 76, 150)))
    # a log scale, as a depth viewer would use: the near half of the ramp for the near ground and the box
    dl = lambda t: min(1, math.log(t / lo) / math.log(hi / lo))
    b += image(xB, y0, w * S, h * S, map_px([[None if t is None else dl(t) for t in row] for row in depth], lambda u: ramp(u, DEPTH)))
    b += rect(xB, y0, w * S, h * S, DIM, sw=1)
    # the colour key
    for k in range(40):
        b += rect(xB + w * S + 14, y0 + k * h * S / 40, 12, h * S / 40 + 0.5, fill=ramp(k / 39, DEPTH))
    b += text(xB + w * S + 30, y0 + 10, f'{lo:.0f} m', GREY, 10) + text(xB + w * S + 30, y0 + h * S, f'{hi:.0f} m +', GREY, 10) + text(xB + w * S + 20, y0 + h * S + 16, 'log scale', GREY, 10, 'middle')
    b += text(xA + w * S / 2, 36, 'photo', FG, 12, 'middle') + text(xB + w * S / 2, 36, 'its depth map: distance per pixel', FG, 12, 'middle')
    # one pixel traced: on the box's front face
    pi_, pj = 56, 30
    (t, n, what), d = cast(pi_, pj)
    for xx in (xA, xB):
        b += circ(xx + (pi_ + 0.5) * S, y0 + (pj + 0.5) * S, 5, RED, fill=False, w=2)
    # side view of the same ray (y forward, z up)
    sx, sy, sk = 90, 360, 28
    P = lambda Y, Z: (sx + sk * (Y - C[1]), sy - sk * Z)
    b += line(*P(-6.2, 0), *P(5, 0), GREY, 2)
    b += poly([P(box[0][1], 0), P(box[0][1], box[1][2]), P(box[1][1], box[1][2]), P(box[1][1], 0)], GREY, fill=RAISED, w=1.6)
    X = v_add(C, v_mul(d, t))
    b += line(*P(C[1], C[2]), *P(X[1], X[2]), RED, 1.8)
    b += cam2d(*P(C[1], C[2]), math.atan2(-(R[2][2]), R[2][1]), size=14)
    hx, hy = P(X[1], X[2])
    b += circ(hx, hy, 4, RED)
    nn = (n[1], -n[2])
    b += arrow(hx, hy, hx + 30 * nn[0], hy + 30 * nn[1], GREEN, 1.8, 7)
    b += text(hx + 30 * nn[0] - 4, hy + 30 * nn[1] - 8, 'normal', GREEN, 11, 'end')
    mx, my = (P(C[1], C[2])[0] + hx) / 2, (P(C[1], C[2])[1] + hy) / 2
    b += text(mx + 8, my - 10, f'depth {t:.1f} m', RED, 12)
    b += text(540, 316, 'side view of the traced pixel (red):', GREY, 11, 'middle') + text(540, 332, 'the depth map stores the length of its ray,', GREY, 11, 'middle') + text(540, 348, 'a normal plane the surface direction', GREY, 11, 'middle')
    svg('depth-map.svg', W, H, b)

DEPTH = ((0, (238, 214, 120)), (0.5, (96, 162, 146)), (1, (66, 76, 150)))
def zncc(a, b_):
    n = len(a); ma, mb = sum(a) / n, sum(b_) / n
    da = [x - ma for x in a]; db = [x - mb for x in b_]
    sa = math.sqrt(sum(x * x for x in da)); sb = math.sqrt(sum(x * x for x in db))
    return sum(x * y for x, y in zip(da, db)) / (sa * sb) if sa > 1e-9 and sb > 1e-9 else 0.0
def strip_px(vals, lo=0.0, hi=1.0):
    return [[(lambda g: (g, g, g))(255 * max(0, min(1, (v - lo) / (hi - lo)))) for v in vals]]

# ── photometric-cost.svg ─────────────────────────────────────────────────────
def photocost():
    W, H = 700, 360
    rnd = random.Random(31)
    # A surface texture seen by three cameras, each adding its own sensor noise. A
    # candidate depth shifts where a source view samples the surface; the cost is
    # 1 − ZNCC of the reference window and the source window, averaged over the sources.
    n = 420
    def views(amp):
        surf = gauss([[amp * rnd.uniform(-1, 1) for _ in range(n)]], 1.6)[0]
        return [[sv + rnd.gauss(0, 0.04) for sv in surf] for _ in range(3)]
    tex, flat = views(1.0), views(0.004)
    x0, win, k = 210, 21, 7.0
    def ws(t, c):  # a window centred at c, sampled between pixels by linear interpolation
        out = []
        for q in range(-(win // 2), win // 2 + 1):
            x = c + q; i = int(math.floor(x)); f = x - i
            out.append(t[i] * (1 - f) + t[i + 1] * f)
        return out
    depths = [i / 30 for i in range(-90, 91)]
    def cost(vs):
        return [1 - (zncc(ws(vs[0], x0), ws(vs[1], x0 + k * d)) + zncc(ws(vs[0], x0), ws(vs[2], x0 - k * d))) / 2 for d in depths]
    b = ''
    C = (60, 50); G = 215
    ray = v_norm((0.55, 1)); tD = (G - C[1]) / ray[1]
    S1, S2 = (210, 46), (300, 72)
    b += line(20, G, 330, G, GREY, 2)
    b += line(*C, C[0] + ray[0] * (tD + 40), C[1] + ray[1] * (tD + 40), BLUE, 1.5)
    cands = [('d1', tD - 70, RED), ('d2', tD, GREEN), ('d3', tD + 26, RED)]
    for lab, t, c in cands:
        X = (C[0] + ray[0] * t, C[1] + ray[1] * t)
        for S in (S1, S2): b += line(*S, *X, c, 1, '4 3', op=0.8)
        b += circ(*X, 5, c) + text(X[0] - 10, X[1] + 4, lab, c, 12, 'end')
    b += cam2d(*C, math.atan2(ray[1], ray[0]), label='reference', lo=(-4, -12))
    for S, nm in ((S1, 'source 1'), (S2, 'source 2')):
        b += cam2d(*S, math.atan2(G - S[1], 150 - S[0]), label=nm, lo=(0, -12))
    # the patches: the reference window and what each candidate brings from the sources
    px, py, pw = 24, 262, 66
    b += image(px, py, pw, 12, strip_px(ws(tex[0], x0), -0.8, 0.8), smooth=False) + rect(px, py, pw, 12, BLUE, sw=1.2)
    b += text(px + pw / 2, py + 26, 'reference', BLUE, 10, 'middle')
    for ci, (lab, t, c) in enumerate(cands):
        d = (t - tD) / 30
        for si, sgn in enumerate((1, -1)):
            xx = px + 84 + ci * 78; yy = py + si * 16
            b += image(xx, yy, pw, 12, strip_px(ws(tex[1 + si], x0 + sgn * k * d), -0.8, 0.8), smooth=False) + rect(xx, yy, pw, 12, c, sw=1.2)
        b += text(px + 84 + ci * 78 + pw / 2, py + 44, lab, c, 10, 'middle')
    b += text(175, 328, 'each candidate depth warps the patch into', GREY, 11, 'middle') + text(175, 342, 'the source views; only d2 brings the same pixels', GREY, 11, 'middle')
    # cost against depth
    gx, gy, gw, gh = 400, 70, 270, 190
    b += line(gx, gy + gh, gx + gw, gy + gh, GREY, 1) + line(gx, gy, gx, gy + gh, GREY, 1)
    b += text(gx + gw / 2, gy + gh + 32, 'candidate depth', GREY, 11, 'middle')
    b += text(gx - 8, gy + 4, '2', GREY, 10, 'end') + text(gx - 8, gy + gh, '0', GREY, 10, 'end') + text(gx - 10, gy + gh / 2, 'cost', GREY, 11, 'end')
    dx = lambda d: gx + gw * (d - depths[0]) / (depths[-1] - depths[0])
    for vs, c in ((flat, GOLD), (tex, BLUE)):
        cs = cost(vs)
        b += poly([(dx(d), gy + gh - gh * min(1, max(0, v / 2))) for d, v in zip(depths, cs)], c, w=1.8)
    for lab, t, c in cands:
        d = (t - tD) / 30
        b += line(dx(d), gy + gh, dx(d), gy + gh + 5, c, 1.4) + text(dx(d), gy + gh + 17, lab, c, 11, 'middle')
    b += text(gx + 8, gy - 22, 'textured: one sharp minimum at the true depth', BLUE, 12)
    b += text(gx + 8, gy - 6, 'textureless: flat, no depth stands out', GOLD, 12)
    b += text(gx + gw / 2, gy + gh + 54, 'cost = 1 − ZNCC of the reference window', GREY, 11, 'middle') + text(gx + gw / 2, gy + gh + 68, 'and each warped source window', GREY, 11, 'middle')
    svg('photometric-cost.svg', W, H, b)

# ── geometric-consistency.svg ────────────────────────────────────────────────
def geocons():
    W, H = 700, 340
    b = ''
    ground = lambda x: 255 + 14 * math.sin(x / 40)
    def hit(C, d):
        t = 0
        while True:
            t += 0.5; X = (C[0] + d[0] * t, C[1] + d[1] * t)
            if X[1] >= ground(X[0]) or t > 900: return X
    def plane_pt(C, look, X, f=34):
        # where the ray C→X crosses the image line f px in front of C
        n = look; t = (-n[1], n[0]); d = (X[0] - C[0], X[1] - C[1]); z = d[0] * n[0] + d[1] * n[1]
        u = f * (d[0] * t[0] + d[1] * t[1]) / z
        return (C[0] + f * n[0] + u * t[0], C[1] + f * n[1] + u * t[1])
    for pi, sky in enumerate((False, True)):
        ox = pi * 350
        R, N = (ox + 90, 70), (ox + 250, 85)
        lr, ln = v_norm((0.25, 1)), v_norm((-0.45, 1))
        b += poly([(ox + x, ground(ox + x)) for x in range(10, 340, 6)], GREY, w=2)
        for C, lk in ((R, lr), (N, ln)):
            t = (-lk[1], lk[0]); P0 = (C[0] + 34 * lk[0], C[1] + 34 * lk[1])
            L_ = 60 if (sky and C == R) else 26
            b += line(P0[0] - L_ * t[0], P0[1] - L_ * t[1], P0[0] + L_ * t[0], P0[1] + L_ * t[1], FG, 2)
        d = v_norm((0.35 if not sky else -0.1, 1)) if not sky else v_norm((0.5, 0.55))
        p = plane_pt(R, lr, (R[0] + d[0], R[1] + d[1]))
        # 1. the reference depth: the surface, or for sky a guess that fits any depth
        X = hit(R, d) if not sky else (R[0] + d[0] * 150, R[1] + d[1] * 150)
        b += line(*R, *X, BLUE, 1.6)
        # 2. into the neighbour, read its own depth along that ray
        q = plane_pt(N, ln, X)
        dn = v_norm((X[0] - N[0], X[1] - N[1]))
        Y = hit(N, dn) if not sky else (N[0] + dn[0] * 60, N[1] + dn[1] * 60)
        b += line(*N, *X, GOLD, 1.3, '5 3') + line(*N, *Y, GOLD, 1.6)
        # 3. back into the reference
        p2 = plane_pt(R, lr, Y)
        b += line(*Y, *R, GREEN if not sky else RED, 1.3, '3 3')
        b += circ(*X, 5, BLUE) + circ(*Y, 4, GOLD)
        b += cam2d(*R, math.atan2(lr[1], lr[0]), label='reference', lo=(-6, -12)) + cam2d(*N, math.atan2(ln[1], ln[0]), label='neighbour', lo=(6, -12))
        b += circ(*p, 4, BLUE)
        b += circ(*p2, 6, GREEN if not sky else RED, fill=False, w=2)
        if sky:
            b += line(*p, *p2, RED, 2)
            b += text(p2[0] + 10, p2[1] - 8, 'ends far away', RED, 11)
            b += text(X[0] + 8, X[1] - 6, 'sky: any depth fits', BLUE, 11)
            b += text(Y[0] + 8, Y[1] + 4, 'neighbour’s own depth', GOLD, 11)
        else:
            b += text(X[0] + 8, X[1] - 8, 'surface point', BLUE, 11)
            b += text(p2[0] + 14, p2[1] + 18, 'back where it started', GREEN, 11)
        b += text(ox + 175, 26, 'sky pixel: the trip does not close, dropped' if sky else 'surface pixel: the trip closes, kept', RED if sky else GREEN, 13, 'middle')
    b += line(350, 40, 350, 310, DIM, 1, '2 4')
    b += text(350, 330, 'blue: the reference depth · gold: into the neighbour, its own depth · dashed: back into the reference', GREY, 11, 'middle')
    svg('geometric-consistency.svg', W, H, b)

# ── patchmatch.svg ───────────────────────────────────────────────────────────
def pmatch():
    W, H = 700, 340
    b = ''
    n, c = 8, 30; ox, oy = 30, 60
    for j in range(n):
        for i in range(n):
            red = (i + j) % 2 == 0
            b += rect(ox + i * c, oy + j * c, c, c, DIM, fill=RED if red else RAISED, sw=0.8, op=None)
            if red: b += rect(ox + i * c, oy + j * c, c, c, fill=BG if False else 'none')
    # dim the red cells so the picked pixel and its neighbours read
    b = ''
    for j in range(n):
        for i in range(n):
            red = (i + j) % 2 == 0
            b += rect(ox + i * c + 1, oy + j * c + 1, c - 2, c - 2, fill=RED if red else GREY, op=0.28 if red else 0.22)
    pi_, pj = 4, 4
    cx, cy = ox + (pi_ + 0.5) * c, oy + (pj + 0.5) * c
    b += rect(ox + pi_ * c + 1, oy + pj * c + 1, c - 2, c - 2, GOLD, fill=GOLD, sw=2, op=0.9)
    for (di, dj), ang in (((-1, 0), 0.5), ((1, 0), 0.2), ((0, -1), -0.4), ((0, 1), 0.7)):
        nx, ny = cx + di * c, cy + dj * c
        b += line(nx - 9 * math.cos(ang), ny - 9 * math.sin(ang), nx + 9 * math.cos(ang), ny + 9 * math.sin(ang), BLUE, 2.4)
        b += arrow(nx + di * -6 + (0 if di == 0 else 0), ny + dj * -6, cx + di * 0.45 * c, cy + dj * 0.45 * c, BLUE, 1.4, 5)
    b += text(ox + n * c / 2, 40, 'red and black pixels update in turn', FG, 12, 'middle')
    b += text(ox + n * c / 2, oy + n * c + 22, 'a red pixel (gold) tries its four black', GREY, 11, 'middle')
    b += text(ox + n * c / 2, oy + n * c + 36, 'neighbours’ planes (blue) as candidates', GREY, 11, 'middle')
    # inset: the neighbour's plane met by this pixel's own ray. A surface seen at a
    # grazing angle shows the difference best.
    ix = 340
    b += rect(ix, 50, 340, 260, DIM, sw=1, rx=6)
    b += text(ix + 170, 72, 'turning a neighbour’s plane into a depth', FG, 12, 'middle')
    C = (ix + 40, 100)
    A, B = (ix + 20, 250), (ix + 330, 175)
    on = lambda u: (A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1]))
    Xn, Xg = on(0.3), on(0.72)
    rn = v_norm(v_sub(Xn, C)); rp = v_norm(v_sub(Xg, C))
    ax = v_norm(v_add(rn, rp))                              # the camera's viewing axis
    tb = v_dot(v_sub(Xn, C), ax) / v_dot(rp, ax)
    Xb = (C[0] + tb * rp[0], C[1] + tb * rp[1])            # this ray meets a plane facing the camera through Xn
    b += line(*A, *B, GREY, 2)
    b += line(*C, *Xn, DIM, 1.2, '4 3')
    b += line(*C, Xg[0] + 24 * rp[0], Xg[1] + 24 * rp[1], BLUE, 1.6)
    b += line(*Xn, *on(0.85), GREEN, 4, op=0.55)
    u = v_norm(v_sub(Xb, Xn))                               # along the plane facing the camera
    b += line(Xn[0] - 30 * u[0], Xn[1] - 30 * u[1], Xb[0] + 24 * u[0], Xb[1] + 24 * u[1], RED, 1.6, '5 3')
    b += circ(*Xn, 4.5, GREY) + circ(*Xg, 5.5, GREEN) + circ(*Xb, 5.5, RED)
    b += cam2d(*C, math.atan2(rp[1], rp[0]), size=14)
    b += text(Xn[0] - 4, Xn[1] + 20, 'neighbour’s point', GREY, 11, 'middle')
    b += text(Xg[0] + 2, Xg[1] + 24, 'its plane met by this ray: right', GREEN, 11, 'middle')
    b += text(Xb[0] - 6, Xb[1] - 10, 'its depth copied: wrong', RED, 11, 'end')
    b += text(ix + 170, 280, 'green: the neighbour’s slanted plane · red: a copy facing', GREY, 11, 'middle')
    b += text(ix + 170, 296, 'the camera, which is what copying a depth assumes', GREY, 11, 'middle')
    svg('patchmatch.svg', W, H, b)

# ── mvs-pipeline.svg ─────────────────────────────────────────────────────────
def mvs():
    W, H = 720, 300
    rnd = random.Random(17)
    g = lambda x: 200 + 18 * math.sin(x / 22) + 10 * math.sin(x / 9 + 1)
    b = ''
    titles = ['1. posed cameras, sparse cloud', '2. one depth map', '3. a depth map per view', '4. fused dense cloud']
    for k in range(4):
        ox = 10 + k * 177
        b += rect(ox, 40, 167, 210, DIM, sw=1, rx=6)
        b += text(ox + 83, 270, titles[k], FG, 12, 'middle')
        if k < 3: b += arrow(ox + 169, 145, ox + 185, 145, GREY, 1.4, 6)
    cams = [(30, 70), (70, 66), (110, 70), (150, 66)]
    # 1
    ox = 10
    for cx_, cy_ in cams: b += cam2d(ox + cx_, cy_, math.pi / 2, size=12)
    for x in [rnd.uniform(12, 155) for _ in range(16)]: b += circ(ox + x, g(x) + rnd.gauss(0, 2), 2.6, GOLD)
    # 2: a depth map seen from straight above, computed from a terrain
    w, h = 36, 36
    terr = [[0.5 + 0.25 * math.sin(i / 5) * math.cos(j / 7) + 0.2 * math.sin((i + j) / 9) for i in range(w)] for j in range(h)]
    b += image(10 + 177 + 18, 70, 130, 130, map_px([[1 - v for v in row] for row in terr], lambda u: ramp(u, DEPTH)))
    b += rect(10 + 177 + 18, 70, 130, 130, DIM, sw=1)
    b += text(10 + 177 + 83, 222, 'near (yellow) to far (blue)', GREY, 10, 'middle')
    # 3: per-view surfaces, slightly different, with a few disagreeing pixels
    ox = 10 + 2 * 177
    cols = [BLUE, GREEN, GOLD]
    outl = []
    for vi, c in enumerate(cols):
        off = (vi - 1) * 1.6
        pts = [(ox + x, g(x) + off + rnd.gauss(0, 1.2)) for x in range(10, 160, 4)]
        b += poly(pts, c, w=1.4, op=0.85)
        for _ in range(3):
            x = rnd.uniform(15, 150); outl.append((ox + x, g(x) - rnd.uniform(18, 50)))
    for cx_, cy_ in cams[:3]: b += cam2d(ox + cx_ + 20, cy_, math.pi / 2, size=12)
    for p in outl: b += line(p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4, RED, 1.6) + line(p[0] - 4, p[1] + 4, p[0] + 4, p[1] - 4, RED, 1.6)
    b += text(ox + 83, 236, 'red: views disagree, dropped', RED, 10, 'middle')
    # 4
    ox = 10 + 3 * 177
    for x in [i * 0.9 for i in range(12, 172)]:
        for _ in range(2): b += circ(ox + x, g(x) + rnd.gauss(0, 1.3) + rnd.uniform(0, 3), 1.3, GOLD)
    b += text(360, 22, 'from posed cameras to a dense cloud: PatchMatch per image, then fusion', GREY, 11, 'middle')
    svg('mvs-pipeline.svg', W, H, b)

# ── sparse-vs-dense.svg ──────────────────────────────────────────────────────
def sparsedense():
    W, H = 700, 340
    rnd = random.Random(23)
    def z(x, y):
        h = 0.45 * math.sin(x * 0.9) * math.cos(y * 0.7) + 0.15 * math.sin(2.1 * x + y)
        if 0.3 < x < 1.5 and -0.6 < y < 0.5: h = max(h, 1.3)
        return h
    tex = scene_img(60, 60, 41)
    def colour(x, y):
        t = tex[int((y + 3) * 9.9) % 60][int((x + 3) * 9.9) % 60]
        if 0.3 < x < 1.5 and -0.6 < y < 0.5: return (196, 170, 150)
        return (100 + 70 * t, 110 + 55 * t, 80 + 35 * t)
    V = (-1.0, -7.5, 5.2); RV = look_at(V, (0.2, 0.3, 0.0)); fv = 260
    pw, ph = 300, 210
    def scr(P): (u, v), zc = project(RV, V, fv, pw / 2, ph / 2, P); return u, v, zc
    # sparse: points where features are, denser at the building's edges
    sp = []
    while len(sp) < 150:
        x, y = rnd.uniform(-3, 3), rnd.uniform(-3, 3)
        edge = min(abs(x - 0.3), abs(x - 1.5), abs(y + 0.6), abs(y - 0.5)) < 0.12 and 0.2 < x < 1.6 and -0.7 < y < 0.6
        if edge or rnd.random() < 0.25: sp.append((x, y, z(x, y)))
    b = ''
    ox1, ox2, oy = 20, 380, 60
    b += rect(ox1, oy, pw, ph, DIM, sw=1, rx=4) + rect(ox2, oy, pw, ph, DIM, sw=1, rx=4)
    for P in sp:
        u, v, _ = scr(P)
        if 0 < u < pw and 0 < v < ph: b += circ(ox1 + u, oy + v, 2.2, hexc(*colour(P[0], P[1])))
    # one point's track: three images that saw it
    P = sp[[i for i, q in enumerate(sp) if 0.25 < q[0] < 1.6 and q[2] > 1][0]]
    u, v, _ = scr(P)
    for k, (cx_, cy_) in enumerate(((ox1 + 60, oy + 18), (ox1 + 150, oy + 10), (ox1 + 240, oy + 20))):
        b += line(cx_, cy_, ox1 + u, oy + v, BLUE, 1.2) + cam2d(cx_, cy_, math.atan2(oy + v - cy_, ox1 + u - cx_), size=12)
    b += circ(ox1 + u, oy + v, 5, GOLD, fill=False, w=2)
    # dense: thousands of points splatted into an image with a depth buffer
    S = 2
    buf = [[None] * (pw // S) for _ in range(ph // S)]; zb = [[1e9] * (pw // S) for _ in range(ph // S)]
    for _ in range(26000):
        x, y = rnd.uniform(-3, 3), rnd.uniform(-3, 3)
        u_, v_, zc = scr((x, y, z(x, y)))
        i, j = int(u_ / S), int(v_ / S)
        if 0 <= i < pw // S and 0 <= j < ph // S and zc < zb[j][i]:
            zb[j][i] = zc; buf[j][i] = colour(x, y)
    # the building's walls, seen from the front
    for _ in range(5000):
        x, zz = rnd.uniform(0.3, 1.5), rnd.uniform(0, 1.3)
        u_, v_, zc = scr((x, -0.6, zz)); i, j = int(u_ / S), int(v_ / S)
        if 0 <= i < pw // S and 0 <= j < ph // S and zc < zb[j][i]: zb[j][i] = zc; buf[j][i] = (150, 132, 118)
    b += image(ox2, oy, pw, ph, buf, smooth=False)
    b += text(ox1 + pw / 2, 40, 'sparse cloud: tie points', FG, 13, 'middle') + text(ox2 + pw / 2, 40, 'dense cloud', FG, 13, 'middle')
    b += text(ox1 + pw / 2, oy + ph + 22, 'one point per matched feature, each with its track', GREY, 11, 'middle')
    b += text(ox1 + pw / 2, oy + ph + 38, 'thousands to a few hundred thousand points', GOLD, 11, 'middle')
    b += text(ox2 + pw / 2, oy + ph + 22, 'a point for nearly every pixel, fused from depth maps', GREY, 11, 'middle')
    b += text(ox2 + pw / 2, oy + ph + 38, 'millions to tens of millions of points', GOLD, 11, 'middle')
    b += text(ox1 + 70, oy + 14, 'its track', BLUE, 11)
    svg('sparse-vs-dense.svg', W, H, b)

def target(x, y, r=7):
    # a GCP target: a black and white quartered disc
    return circ(x, y, r, FG) + path(f'M {f2(x)} {f2(y)} L {f2(x + r)} {f2(y)} A {r} {r} 0 0 1 {f2(x)} {f2(y + r)} Z', None, fill=BG) + path(f'M {f2(x)} {f2(y)} L {f2(x - r)} {f2(y)} A {r} {r} 0 0 1 {f2(x)} {f2(y - r)} Z', None, fill=BG)
def cross(x, y, c, r=6, w=2):
    return line(x - r, y, x + r, y, c, w) + line(x, y - r, x, y + r, c, w)

# ── georeferencing.svg ───────────────────────────────────────────────────────
def georef():
    W, H = 700, 360
    rnd = random.Random(12)
    # the block in its own frame, and the true similarity to the map
    pts = [(rnd.uniform(-1, 1), rnd.uniform(-0.7, 0.7)) for _ in range(40)]
    cams = [(-0.8 + 0.4 * i, -0.95) for i in range(5)]
    gcp = [(-0.75, 0.5), (0.7, 0.45), (0.1, -0.55)]
    s_true, a_true, t_true = 1.3, math.radians(32), (525, 180)
    def T(p, s=s_true, a=a_true, t=t_true):
        q = rot2((p[0] * 70 * s, p[1] * 70 * s), a); return (t[0] + q[0], t[1] + q[1])
    surveyed = [(x + rnd.gauss(0, 4), y + rnd.gauss(0, 4)) for x, y in (T(g) for g in gcp)]
    # least-squares 2D similarity from model (scaled to px) to surveyed: z' = a·z + b in complex numbers
    zs = [complex(g[0] * 70, g[1] * 70) for g in gcp]; ws_ = [complex(*q) for q in surveyed]
    mz = sum(zs) / 3; mw = sum(ws_) / 3
    A = sum((w - mw) * (z - mz).conjugate() for z, w in zip(zs, ws_)) / sum(abs(z - mz) ** 2 for z in zs)
    fit = lambda p: (lambda w: (w.real, w.imag))(A * complex(p[0] * 70, p[1] * 70) + (mw - A * mz))
    b = ''
    # left: the model frame
    L = lambda p: (150 + p[0] * 95, 190 + p[1] * 95)
    b += arrow(*L((-1.25, 1.05)), *L((-0.75, 1.05)), DIM, 1.2, 6) + arrow(*L((-1.25, 1.05)), *L((-1.25, 0.55)), DIM, 1.2, 6)
    b += text(*L((-0.72, 1.12)), 'x', GREY, 10) + text(*L((-1.33, 0.52)), 'y', GREY, 10)
    for p in pts: b += circ(*L(p), 2.3, GOLD)
    for c in cams: b += cam2d(*L(c), math.pi / 2, size=10)
    for k, g in enumerate(gcp): b += target(*L(g), 6) + text(L(g)[0] + 10, L(g)[1] - 8, str(k + 1), FG, 12)
    b += text(150, 36, 'model frame: any scale, turn, position', FG, 12, 'middle')
    # right: the map grid and the fitted block
    gx0, gy0 = 380, 50
    for k in range(7):
        b += line(gx0 + k * 50, gy0, gx0 + k * 50, gy0 + 270, DIM, 0.7) + line(gx0, gy0 + k * 45, gx0 + 300, gy0 + k * 45, DIM, 0.7)
    b += text(gx0 + 310, gy0 + 274, 'E', GREY, 11) + text(gx0 - 6, gy0 + 8, 'N', GREY, 11, 'end')
    for p in pts:
        q = fit(p)
        if gx0 < q[0] < gx0 + 300 and gy0 < q[1] < gy0 + 270: b += circ(*q, 2.3, GOLD)
    for c in cams: q = fit(c); b += circ(*q, 4, BLUE)
    MAG = 4
    for k, (g, sv) in enumerate(zip(gcp, surveyed)):
        q = fit(g)
        b += cross(*sv, GREEN, 7) + target(*q, 5)
        e = (q[0] + MAG * (sv[0] - q[0]), q[1] + MAG * (sv[1] - q[1]))
        b += arrow(*q, *e, RED, 1.6, 6)
        b += curve((L(g)[0] + 10, L(g)[1]), (q[0] - 8, q[1]), -50 if k != 2 else 40, DIM, 1, '4 4', head=0)
    b += text(gx0 + 150, 36, 'map grid: scaled, turned and shifted onto it', FG, 12, 'middle')
    b += text(350, 342, f'green: surveyed position · red: the residual after the fit ({MAG}× longer) · the 7 unknowns: 1 scale, 3 rotation, 3 shift', GREY, 11, 'middle')
    svg('georeferencing.svg', W, H, b)

# ── gcp-marking.svg ──────────────────────────────────────────────────────────
def gcpmark():
    W, H = 700, 380
    b = ''
    # three photos of one target, each with the marked pixel
    for k, (u, v) in enumerate(((0.62, 0.55), (0.40, 0.48), (0.22, 0.60))):
        x, y = 40 + k * 130, 50
        b += thumb(x, y, 110, 74, 300 + k)
        b += target(x + u * 110, y + v * 74, 6)
        b += circ(x + u * 110, y + v * 74, 10, GREEN, fill=False, w=1.6)
        b += text(x + 55, y + 92, f'photo {k + 1}', GREY, 11, 'middle')
    b += text(220, 30, 'the target marked in each photo (green)', FG, 12, 'middle')
    # side view: three cameras, rays through the marked pixels nearly meeting
    X = (240, 300)
    cams = [(110, 175), (240, 160), (370, 175)]
    for C in cams:
        d = v_norm(v_sub(X, C)); off = random.Random(int(C[0])).gauss(0, 1.2)
        n = (-d[1], d[0]); end = (X[0] + 26 * d[0] + off * n[0], X[1] + 26 * d[1] + off * n[1])
        b += line(*C, *end, BLUE, 1.3)
        t = (-d[1], d[0]); P0 = (C[0] + 24 * d[0], C[1] + 24 * d[1])
        b += line(P0[0] - 14 * t[0], P0[1] - 14 * t[1], P0[0] + 14 * t[0], P0[1] + 14 * t[1], FG, 2) + circ(*P0, 3, GREEN)
        b += cam2d(*C, math.atan2(d[1], d[0]), size=12)
    b += circ(*X, 5.5, GOLD)
    b += text(X[0] - 14, X[1] + 22, 'triangulated', GOLD, 11, 'end')
    # the surveyed coordinate, and the residual between them
    Sv = (X[0] + 26, X[1] + 14)
    b += cross(*Sv, GREEN, 8, 2.2)
    b += line(*X, *Sv, RED, 2)
    b += text(Sv[0] + 12, Sv[1] + 18, 'surveyed', GREEN, 11)
    b += rect(450, 150, 230, 150, DIM, fill=RAISED, sw=1, rx=6)
    rows = [('GCP 7', FG), ('surveyed (project CRS)', GREEN), ('E 512,340.12 m', GREEN), ('N 7,120,553.40 m', GREEN), ('h 41.32 m', GREEN),
            ('triangulated − surveyed', RED), ('residual 3.1 cm', RED)]
    for k, (t, c) in enumerate(rows): b += text(466, 172 + k * 19, t, c, 12)
    b += curve((Sv[0] + 10, Sv[1] - 4), (446, 210), -30, DIM, 1, '4 4')
    b += text(350, 364, 'rays from the marked pixels meet in one triangulated point; its distance from the survey is the residual', GREY, 11, 'middle')
    svg('gcp-marking.svg', W, H, b)

# ── scale-bar.svg ────────────────────────────────────────────────────────────
def scalebar():
    W, H = 700, 330
    b = ''
    G = 250
    # the same object at two sizes, the larger seen from twice as far: identical images
    def scene(ox, s, dist):
        nonlocal b
        house = [(0, 0), (0, -40), (30, -62), (60, -40), (60, 0)]
        P = lambda p: (ox + p[0] * s, G + p[1] * s)
        b += poly([P(p) for p in house], GREY, fill=RAISED, w=1.6, closed=True)
        C = (ox + 30 * s, G - 31 * s - dist)
        for p in (house[1], house[2], house[3]):
            b += line(*C, *P(p), BLUE, 0.9, op=0.7)
        b += cam2d(*C, math.pi / 2, size=12)
        # the bar between two targets on the object
        b += target(*P((8, -6)), 5) + target(*P((52, -6)), 5)
        return P, C
    b += line(20, G, 680, G, GREY, 2)
    P1, C1 = scene(70, 1.0, 55)
    P2, C2 = scene(400, 2.0, 110)
    b += text(100, 34, 'a small object, close', FG, 12, 'middle') + text(460, 34, 'twice as large, twice as far', FG, 12, 'middle')
    # the one image both give
    ix, iy, iw, ih = 235, 70, 110, 80
    b += rect(ix, iy, iw, ih, DIM, fill=RAISED, sw=1)
    house = [(0, 0), (0, -40), (30, -62), (60, -40), (60, 0)]
    f_ = 0.9
    pr = lambda p: (ix + iw / 2 + (p[0] - 30) * f_, iy + ih - 12 + p[1] * f_ * 0.9)
    b += poly([pr(p) for p in house], GREY, fill=DIM, w=1.2, closed=True)
    b += text(ix + iw / 2, iy + ih + 16, 'the same photo from both', GREY, 11, 'middle')
    b += arrow(C1[0] + 14, C1[1] - 6, ix - 4, iy + 30, DIM, 1, 6) + arrow(C2[0] - 14, C2[1] - 6, ix + iw + 4, iy + 30, DIM, 1, 6)
    # the measured distance decides
    a, c = P1((8, -6)), P1((52, -6))
    b += line(a[0], a[1] + 18, c[0], c[1] + 18, GREEN, 2) + line(a[0], a[1] + 12, a[0], a[1] + 24, GREEN, 2) + line(c[0], c[1] + 12, c[0], c[1] + 24, GREEN, 2)
    b += text((a[0] + c[0]) / 2, a[1] + 40, 'measured: 2.00 m', GREEN, 12, 'middle')
    a2, c2 = P2((8, -6)), P2((52, -6))
    b += line(a2[0], a2[1] + 18, c2[0], c2[1] + 18, RED, 2, '5 3')
    b += text((a2[0] + c2[0]) / 2, a2[1] + 40, 'would be 4.00 m: not this one', RED, 12, 'middle')
    b += text(350, 318, 'the photos cannot tell the two apart; one measured distance between two targets fixes the scale', GREY, 11, 'middle')
    svg('scale-bar.svg', W, H, b)

# ── crs-polar.svg ────────────────────────────────────────────────────────────
def crspolar():
    import json
    W, H = 700, 400
    data = json.load(open(os.path.join(os.path.dirname(__file__), 'antarctica-110m.json')))
    R = 6371.0
    lam0 = math.radians(-57)              # UTM zone 21S, the Antarctic Peninsula's zone
    # spherical forms; the scale factor k is what a length on the map is off by
    def tm(lon, lat):
        p, l = math.radians(lat), math.radians(lon) - lam0
        B = math.cos(p) * math.sin(l)
        return 0.5 * R * math.log((1 + B) / (1 - B)), R * math.atan2(math.tan(p), math.cos(l))
    def tm_inv(x, y):
        D = y / R; p = math.asin(max(-1, min(1, math.sin(D) / math.cosh(x / R)))); l = lam0 + math.atan2(math.sinh(x / R), math.cos(D))
        k = 0.9996 / math.sqrt(max(1e-12, 1 - (math.cos(p) * math.sin(l - lam0)) ** 2))
        return math.degrees(p), k
    def ps(lon, lat):
        p, l = math.radians(lat), math.radians(lon)
        rho = 2 * R * math.tan(math.pi / 4 + p / 2)
        return rho * math.sin(l), rho * math.cos(l)
    def ps_inv(x, y):
        p = 2 * math.atan(math.hypot(x, y) / (2 * R)) - math.pi / 2
        k = (1 + math.sin(math.radians(71))) / (1 + math.sin(-p))     # true scale at 71° S, as EPSG:3031
        return math.degrees(p), k
    ERR = ((0, (98, 160, 118)), (0.33, (226, 200, 96)), (1, (206, 84, 72)))
    b = ''
    worst = {}
    for pi, (proj, inv, title) in enumerate(((tm, tm_inv, 'UTM zone 21S'), (ps, ps_inv, 'EPSG:3031 polar stereographic'))):
        ox, oy, bw, bh = 20 + pi * 345, 50, 320, 270
        lines = [[proj(lon, lat) for lon, lat in ln] for ln in data['lines']]
        allp = [p for ln in lines for p in ln]
        xs, ys = [p[0] for p in allp], [p[1] for p in allp]
        sc = min(bw / (max(xs) - min(xs)), bh / (max(ys) - min(ys))) * 0.9
        mx, my = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
        S = lambda p: (ox + bw / 2 + (p[0] - mx) * sc, oy + bh / 2 - (p[1] - my) * sc)
        # the scale error at every map pixel south of 60° S
        n = 80
        px = []
        for j in range(n):
            row = []
            for i in range(n):
                X = mx + ((i + 0.5) / n * bw - bw / 2) / sc; Y = my - ((j + 0.5) / n * bh - bh / 2) / sc
                lat, k = inv(X, Y)
                row.append(None if lat > -60 else min(1, abs(k - 1) / 0.15))
            px.append(row)
        worst[pi] = max(abs(inv(*p)[1] - 1) for p in allp)
        b += rect(ox, oy, bw, bh, fill=RAISED)
        b += image(ox, oy, bw, bh, map_px(px, lambda t: ramp(t, ERR)), op=0.75)
        cid = f'crs{pi}'
        b += f'  <clipPath id="{cid}"><rect x="{ox}" y="{oy}" width="{bw}" height="{bh}"/></clipPath>\n  <g clip-path="url(#{cid})">\n'
        for lon in range(-180, 180, 30):
            b += poly([S(proj(lon, lat)) for lat in [-60 - k for k in range(0, 30)]] + [S(proj(lon, -89.9))], DIM, w=0.6)
        for lat in (-60, -70, -80):
            b += poly([S(proj(lon, lat)) for lon in range(-180, 181, 3)], DIM, w=0.6)
        for ln in lines:
            b += poly([S(p) for p in ln], FG, w=1.3)
        if pi == 0:  # UTM is not defined south of 80° S
            b += poly([S(proj(lon, -80)) for lon in range(-180, 181, 3)], RED, w=2, dash='6 4')
            q = max((S(proj(lon, -80)) for lon in range(-180, 181, 3)), key=lambda p: p[1])
            b += text(q[0], q[1] + 16, 'UTM ends at 80° S', RED, 11, 'middle')
        pole = S(proj(0, -89.999))
        b += circ(*pole, 4.5, GOLD) + text(pole[0] + 8, pole[1] - 6, 'South Pole', GOLD, 11)
        b += '  </g>\n' + rect(ox, oy, bw, bh, DIM, sw=1)
        b += text(ox + bw / 2, 36, title, FG, 13, 'middle')
    b += text(20 + 160, 342, f'true only near its own 6°: up to {100 * worst[0]:.0f}% scale error on the coast', RED, 12, 'middle')
    b += text(365 + 160, 342, f'within {100 * worst[1]:.0f}% over the whole continent', GREEN, 12, 'middle')
    for k in range(60):
        b += rect(260 + k * 3, 362, 3.2, 10, fill=ramp(k / 59, ERR))
    b += text(254, 371, 'scale error 0%', GREY, 11, 'end') + text(446, 371, '15% +', GREY, 11)
    b += text(350, 392, 'coastline: Natural Earth', GREY, 10, 'middle')
    svg('crs-polar.svg', W, H, b)

# ── dem-coregistration.svg ───────────────────────────────────────────────────
def demcoreg():
    W, H = 700, 340
    rnd = random.Random(5)
    ridge = lambda x: 70 * math.exp(-((x - 160) / 70) ** 2) + 18 * math.exp(-((x - 250) / 40) ** 2)
    shift = 14
    b = ''
    for pi, (lab, t) in enumerate((('before: the DEM sits a little to the right', shift), ('after: moved left by the fitted shift', 0.6))):
        ox = 20 + pi * 345
        xs = list(range(0, 320, 3))
        ref = [(ox + x, 170 - ridge(x)) for x in xs]
        dem = [(ox + x, 170 - ridge(x - t) + rnd.gauss(0, 0.6)) for x in xs]
        b += poly(ref, GREY, w=2.2) + poly(dem, BLUE, w=1.6, dash='5 3')
        # the height differences below
        base = 260
        b += line(ox, base, ox + 320, base, DIM, 1)
        for x in xs:
            dh = ridge(x - t) - ridge(x)
            if abs(dh) > 0.3:
                b += line(ox + x, base, ox + x, base - 2.2 * dh, RED if dh > 0 else BLUE, 2.2, op=0.8)
        b += text(ox + 160, 36, lab, FG, 12, 'middle')
        b += text(ox + 4, 70, 'reference', GREY, 11) + text(ox + 4, 86, 'DEM', BLUE, 11)
        b += text(ox + 320, base + 18, 'DEM − reference', GREY, 11, 'end')
    b += text(20 + 80, 300, '−', BLUE, 16, 'middle') + text(20 + 240, 236, '+', RED, 16, 'middle')
    b += text(350, 326, 'a sideways shift reads as height error on slopes: + on one side of the ridge, − on the other', GREY, 11, 'middle')
    svg('dem-coregistration.svg', W, H, b)

# ── cloud-distance.svg ───────────────────────────────────────────────────────
def clouddist():
    W, H = 700, 330
    rnd = random.Random(19)
    surf = lambda x: 190 - 40 * math.sin(x / 70) - 14 * math.sin(x / 23)
    b = ''
    vmax = 24
    col = lambda d: ramp((max(-vmax, min(vmax, d)) / vmax + 1) / 2, DIVERGE)
    def epoch(x0, x1):
        out = []
        for _ in range(16):
            x = rnd.uniform(x0, x1); d = rnd.choice((-1, 1)) * rnd.uniform(6, 26)
            out.append((x, surf(x) - d))
        return out
    # left: a sparse reference cloud, nearest-point distance
    ref_pts = [(x, surf(x)) for x in range(20, 330, 22)]
    for p in ref_pts: b += circ(*p, 3, GREY)
    for q in epoch(30, 320):
        n = min(ref_pts, key=lambda p: math.dist(p, q))
        d = math.dist(n, q) * (1 if q[1] < surf(q[0]) else -1)
        b += line(*q, *n, DIM, 1.1)
        b += circ(*q, 4.5, col(d)) + circ(*q, 4.5, DIM, fill=False, w=0.8)
    # right: a mesh, exact perpendicular distance
    mesh = [(x, surf(x)) for x in range(370, 690, 4)]
    b += poly(mesh, GREY, w=2.2)
    for q in epoch(380, 680):
        best = None
        for a, c in zip(mesh, mesh[1:]):
            vx, vy = c[0] - a[0], c[1] - a[1]; t = max(0, min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / (vx * vx + vy * vy)))
            f = (a[0] + t * vx, a[1] + t * vy); dd = math.dist(f, q)
            if best is None or dd < best[0]: best = (dd, f)
        d = best[0] * (1 if q[1] < surf(q[0]) else -1)
        b += line(*q, *best[1], DIM, 1.1)
        b += circ(*q, 4.5, col(d)) + circ(*q, 4.5, DIM, fill=False, w=0.8)
    b += line(350, 50, 350, 280, DIM, 1, '2 4')
    b += text(175, 36, 'to a reference cloud: the nearest point', FG, 12, 'middle') + text(525, 36, 'to a mesh: the exact distance', FG, 12, 'middle')
    b += text(175, 270, 'with gaps between the points,', GREY, 11, 'middle') + text(175, 284, 'a distance reads a little long', GREY, 11, 'middle')
    for k in range(60):
        b += rect(250 + k * 3.3, 300, 3.4, 10, fill=col(-vmax + 2 * vmax * k / 59))
    b += text(244, 309, 'below', BLUE, 11, 'end') + text(454, 309, 'above', RED, 11)
    b += text(350, 326, 'signed distance: blue below the reference, white on it, red above', GREY, 11, 'middle')
    svg('cloud-distance.svg', W, H, b)

def voronoi(sites, box):
    # Each site's cell: the box clipped by the half-planes nearer to it than to the others.
    x0, y0, x1, y1 = box
    cells = []
    for i, p in enumerate(sites):
        poly_ = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        for j, q in enumerate(sites):
            if i == j: continue
            m = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2); n = (q[0] - p[0], q[1] - p[1])
            inside = lambda a: (a[0] - m[0]) * n[0] + (a[1] - m[1]) * n[1] <= 0
            out = []
            for a, c in zip(poly_, poly_[1:] + poly_[:1]):
                ia, ic = inside(a), inside(c)
                if ia: out.append(a)
                if ia != ic:
                    da = (a[0] - m[0]) * n[0] + (a[1] - m[1]) * n[1]; dc = (c[0] - m[0]) * n[0] + (c[1] - m[1]) * n[1]
                    t = da / (da - dc); out.append((a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])))
            poly_ = out
        cells.append(poly_)
    return cells

# ── orthophoto-vs-perspective.svg ────────────────────────────────────────────
def orthopersp():
    W, H = 700, 330
    b = ''
    G = 240
    hill = lambda x: 55 * math.exp(-((x - 70) / 38) ** 2)
    B0, B1, BH = 215, 265, 85
    def scene(ox):
        nonlocal b
        b += poly([(ox + x, G - hill(x)) for x in range(0, 320, 4)], GREY, w=2)
        b += rect(ox + B0, G - BH, B1 - B0, BH, GREY, fill=RAISED, sw=1.6)
    # left: perspective
    ox = 20; C = (ox + 150, 50)
    scene(ox)
    # the ground hidden behind the building from this camera
    far_top = (ox + B1, G - BH)
    t = (G - C[1]) / (far_top[1] - C[1]); shadow_end = C[0] + t * (far_top[0] - C[0])
    b += poly([(ox + B1, G), (shadow_end, G), (ox + B1, G - BH)], DIM, fill=DIM, w=1, op=0.6, closed=True)
    b += text(ox + B1 + 18, G - BH - 6, 'hidden from', GREY, 11) + text(ox + B1 + 18, G - BH + 8, 'this photo', GREY, 11)
    for P, c in (((ox + B0, G - BH), RED), ((ox + B1, G - BH), RED), ((ox + 70, G - hill(70)), GOLD)):
        t = (G - C[1]) / (P[1] - C[1]); gx = C[0] + t * (P[0] - C[0])
        b += line(*C, *P, BLUE, 1.2) + line(*P, gx, G, BLUE, 1, '3 3')
        b += line(P[0], G + 14, P[0], G + 22, GREEN, 2) + line(gx, G + 14, gx, G + 22, c, 2)
        b += arrow(P[0], G + 18, gx + (3 if gx > P[0] else -3), G + 18, c, 1.2, 5)
    b += cam2d(*C, math.pi / 2, size=16)
    b += text(ox + 150, 30, 'photo: perspective', FG, 13, 'middle')
    b += text(ox + 150, 290, 'the roof and the hilltop land away from where', GREY, 11, 'middle') + text(ox + 150, 304, 'they stand (red): the building leans out', GREY, 11, 'middle')
    # right: orthographic
    ox = 365
    scene(ox)
    for x in list(range(20, 320, 22)):
        top = G - (BH if B0 <= x <= B1 else hill(x))
        b += line(ox + x, 50, ox + x, top, BLUE, 1, op=0.7)
    for P in ((ox + B0, G - BH), (ox + B1, G - BH), (ox + 70, G - hill(70))):
        b += line(P[0], G + 14, P[0], G + 22, GREEN, 2)
    b += text(ox + 160, 30, 'orthophoto: straight down everywhere', FG, 13, 'middle')
    b += text(ox + 160, 290, 'every point over its own place (green):', GREY, 11, 'middle') + text(ox + 160, 304, 'one scale, measurable like a map', GREY, 11, 'middle')
    b += text(350, 324, 'the depth maps act as a z-buffer: ground hidden in one photo is coloured from another', GREY, 11, 'middle')
    svg('orthophoto-vs-perspective.svg', W, H, b)

# ── ortho-seamlines.svg ──────────────────────────────────────────────────────
def orthoseams():
    W, H = 700, 350
    rnd = random.Random(14)
    box = (40, 40, 400, 320)
    sites = [(95 + 125 * i + rnd.gauss(0, 10), 85 + 95 * j + rnd.gauss(0, 8)) for j in range(3) for i in range(3)]
    cells = voronoi(sites, box)
    b = rect(box[0], box[1], box[2] - box[0], box[3] - box[1], DIM, fill=RAISED, sw=1)
    # a building on the border of cells 4 and 5
    p, q = sites[4], sites[5]
    m = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
    bx, by, bw, bh = m[0] - 16, m[1] - 18, 30, 34
    for k, cell in enumerate(cells):
        b += poly(cell, DIM, fill=[BLUE, GOLD, GREEN][k % 3], w=1, op=0.12, closed=True)
    # every border, the blending band either side of it
    edges = set()
    for cell in cells:
        for a, c in zip(cell, cell[1:] + cell[:1]):
            on_box = (abs(a[0] - c[0]) < 1e-6 and a[0] in (box[0], box[2])) or (abs(a[1] - c[1]) < 1e-6 and a[1] in (box[1], box[3]))
            if not on_box: edges.add(tuple(sorted(((round(a[0], 1), round(a[1], 1)), (round(c[0], 1), round(c[1], 1))))))
    bent = None
    for (a, c) in edges:
        mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
        if math.dist(mid, m) < 30 and bent is None: bent = (a, c); continue
        b += line(*a, *c, GOLD, 12, op=0.18) + line(*a, *c, GOLD, 1.6)
    a, c = bent
    # the seam bends round the building, through open ground
    left = bx - 10
    pth = f'M {f2(a[0])} {f2(a[1])} L {f2(a[0] + (c[0] - a[0]) * 0.25)} {f2(by - 12)} Q {f2(left)} {f2(by - 6)} {f2(left)} {f2(by + bh / 2)} Q {f2(left)} {f2(by + bh + 6)} {f2(a[0] + (c[0] - a[0]) * 0.75)} {f2(by + bh + 12)} L {f2(c[0])} {f2(c[1])}'
    b += path(pth, GOLD, w=12, op=0.18) + path(pth, GOLD, w=2.2)
    b += line(*a, *c, RED, 1.2, '4 3')
    b += rect(bx, by, bw, bh, FG, fill=GREY, sw=1.2)
    for k, s_ in enumerate(sites): b += cross(*s_, BLUE, 5, 2)
    # a key on the right
    kx = 440
    b += cross(kx + 8, 72, BLUE, 6, 2) + text(kx + 24, 70, 'nadir point: where a photo', FG, 12) + text(kx + 24, 85, 'looks straight down', FG, 12)
    b += rect(kx, 106, 16, 16, DIM, fill=BLUE, op=0.25) + text(kx + 24, 119, 'the ground that photo colours', FG, 12)
    b += line(kx, 152, kx + 16, 152, GOLD, 2) + text(kx + 24, 157, 'seamline', GOLD, 12)
    b += line(kx, 186, kx + 16, 186, GOLD, 12, op=0.25) + text(kx + 24, 191, 'blending band either side', GOLD, 12)
    b += line(kx, 220, kx + 16, 220, RED, 1.2, '4 3') + text(kx + 24, 225, 'the straight seam through the roof,', RED, 12)
    b += text(kx + 24, 241, 'bent round it by the graph cut', RED, 12)
    b += text(220, 340, 'a 3 × 3 block of photos split into the regions each one colours', GREY, 11, 'middle')
    svg('ortho-seamlines.svg', W, H, b)

# ── seamlines.svg ────────────────────────────────────────────────────────────
def seamlines():
    W, H = 700, 360
    b = ''
    # two photos meeting at a seam; a building sits on the midline and leans differently in each
    for pi, (lab, bent) in enumerate((('nearest nadir: straight through the roof', False), ('graph cut: round the building', True))):
        ox, oy, w, h = 20 + pi * 345, 50, 320, 180
        mx = ox + w / 2
        b += rect(ox, oy, w / 2, h, fill=BLUE, op=0.10) + rect(mx, oy, w / 2, h, fill=GOLD, op=0.10)
        b += rect(ox, oy, w, h, DIM, sw=1)
        b += text(ox + 40, oy + 18, 'photo A', BLUE, 11) + text(ox + w - 40, oy + 18, 'photo B', GOLD, 11, 'end')
        bx, by, bw, bh = mx - 30, oy + 70, 60, 46
        # each photo sees the roof displaced away from its own nadir, and a little differently
        def building(dx, dy):
            return rect(bx, by, bw, bh, DIM, fill=RAISED, sw=1) + rect(bx + dx, by + dy, bw, bh, FG, fill=GREY, sw=1.2)
        A_, B_ = building(12, -12), building(-12, -5)
        cl, cr = f'sl{pi}l', f'sl{pi}r'
        if not bent:
            b += f'  <clipPath id="{cl}"><rect x="{ox}" y="{oy}" width="{w / 2}" height="{h}"/></clipPath>\n  <clipPath id="{cr}"><rect x="{mx}" y="{oy}" width="{w / 2}" height="{h}"/></clipPath>\n'
            b += f'  <g clip-path="url(#{cl})">\n' + A_ + '  </g>\n' + f'  <g clip-path="url(#{cr})">\n' + B_ + '  </g>\n'
            b += line(mx, oy, mx, oy + h, RED, 2.2)
            b += text(mx + 6, oy + h - 8, 'the roof breaks at the seam', RED, 11)
        else:
            b += B_
            pth = f'M {f2(mx)} {oy} L {f2(mx)} {f2(by - 34)} Q {f2(bx - 40)} {f2(by - 30)} {f2(bx - 40)} {f2(by + bh / 2)} Q {f2(bx - 40)} {f2(by + bh + 26)} {f2(mx)} {f2(by + bh + 34)} L {f2(mx)} {f2(oy + h)}'
            b += path(pth, GREEN, w=2.2)
            b += text(ox + w / 2, oy + h - 8, 'the whole building from B', GREEN, 11, 'middle')
        b += text(ox + w / 2, 34, lab, FG, 12, 'middle')
    # colour balance across the seam
    sy = 270
    for k, (lab, gains) in enumerate((('before colour balance: an exposure step', (0.62, 0.42)), ('after: one gain per photo, no step', (0.52, 0.52)))):
        x0 = 20 + k * 345
        rnd = random.Random(7)
        row = []
        for i in range(64):
            g = gains[0] if i < 32 else gains[1]
            v = g + 0.12 * math.sin(i / 3.1) + rnd.gauss(0, 0.03)
            row.append(v)
        img = [row for _ in range(10)]
        b += image(x0, sy, 320, 40, gray_px(img, 0.1, 0.9), smooth=False) + rect(x0, sy, 320, 40, DIM, sw=1)
        b += line(x0 + 160, sy - 4, x0 + 160, sy + 44, GOLD, 1.4, '3 3')
        b += text(x0 + 160, sy - 10, lab, GREY, 11, 'middle')
    b += text(350, 344, 'seams are placed where the photos agree, then their brightness is balanced', GREY, 11, 'middle')
    svg('seamlines.svg', W, H, b)

# ── multiband-blending.svg ───────────────────────────────────────────────────
def multiband():
    W, H = 700, 380
    w, h = 72, 40
    sc = scene_img(w, h, 27)
    A = [[0.75 * v - 0.02 for v in row] for row in sc]
    Bm = [[0.9 * v + 0.2 for v in row] for row in sc]        # the same ground, exposed brighter
    step = [[1.0 if i < w / 2 else 0.0 for i in range(w)] for _ in range(h)]
    def bands(I):
        g1, g2 = gauss(I, 1.2), gauss(I, 4.0)
        return [[[a - c for a, c in zip(r1, r2)] for r1, r2 in zip(I, g1)], [[a - c for a, c in zip(r1, r2)] for r1, r2 in zip(g1, g2)], g2]
    bA, bB = bands(A), bands(Bm)
    sig = [0.4, 2.5, 10.0]
    masks = [gauss(step, s) for s in sig]
    blended = [[[m * a + (1 - m) * c for m, a, c in zip(rm, ra, rc)] for rm, ra, rc in zip(masks[k], bA[k], bB[k])] for k in range(3)]
    result = [[sum(blended[k][j][i] for k in range(3)) for i in range(w)] for j in range(h)]
    naive = [[A[j][i] if i < w / 2 else Bm[j][i] for i in range(w)] for j in range(h)]
    S = 2.4; iw, ih = w * S, h * S
    b = ''
    b += text(20 + iw / 2, 40, 'cut at the seam: a step', FG, 12, 'middle')
    b += image(20, 50, iw, ih, gray_px(naive, 0, 1.1)) + rect(20, 50, iw, ih, DIM, sw=1)
    b += line(20 + iw / 2, 46, 20 + iw / 2, 54 + ih, GOLD, 1.2, '3 3')
    names = ['fine detail', 'medium', 'coarse: brightness']
    for k in range(3):
        y = 160 + k * 72
        m = max(abs(v) for row in blended[k] for v in row) if k < 2 else None
        b += image(250, y, iw * 0.6, ih * 0.6, gray_px(masks[k], 0, 1)) + rect(250, y, iw * 0.6, ih * 0.6, DIM, sw=1)
        px = map_px(blended[k], lambda v: ramp((max(-1, min(1, v / m)) + 1) / 2, GRAYS)) if k < 2 else gray_px(blended[k], 0, 1.1)
        b += image(390, y, iw * 0.6, ih * 0.6, px) + rect(390, y, iw * 0.6, ih * 0.6, DIM, sw=1)
        b += text(240, y + ih * 0.3 + 4, names[k], GREY, 11, 'end')
    b += text(250 + iw * 0.3, 148, 'its mask', GREY, 11, 'middle') + text(390 + iw * 0.3, 148, 'band, blended', GREY, 11, 'middle')
    b += text(250 + iw * 0.3, 92, 'narrow for fine detail,', GREY, 11, 'middle') + text(250 + iw * 0.3, 106, 'wide for brightness', GREY, 11, 'middle')
    rx = 520
    b += text(rx + iw * 0.35, 40, 'bands added back', FG, 12, 'middle')
    b += image(rx, 50, iw * 0.7, ih * 0.7, gray_px(result, 0, 1.1)) + rect(rx, 50, iw * 0.7, ih * 0.7, DIM, sw=1)
    b += text(rx + iw * 0.35, 130, 'no step, no ghosting', GREEN, 12, 'middle')
    for k in range(3):
        y = 160 + k * 72 + ih * 0.3
        b += line(390 + iw * 0.6 + 6, y, rx + iw * 0.35, 128 + 14, DIM, 1, '3 3')
    b += text(350, 372, 'each band mixes the two photos (left: A, right: B) over its own width, then the bands are summed', GREY, 11, 'middle')
    svg('multiband-blending.svg', W, H, b)

# ── seam-levelling.svg ───────────────────────────────────────────────────────
def seamlevel():
    W, H = 700, 340
    rnd = random.Random(9)
    xs = [i for i in range(0, 301, 3)]
    seam = 150
    tex = [0.06 * math.sin(x / 7) + 0.03 * math.sin(x / 2.3) + rnd.gauss(0, 0.01) for x in xs]
    base = [(0.42 if x < seam else 0.62) for x in xs]
    step = 0.62 - 0.42
    # the correction: half the step at the seam, fading away from it
    corr = [(step / 2) * math.exp(-abs(x - seam) / 55) * (1 if x < seam else -1) for x in xs]
    b = ''
    def plot(ox, oy, vals, c, lab, lo=0.2, hi=0.85, h=90, zero=False):
        nonlocal b
        b += line(ox, oy + h, ox + 300, oy + h, DIM, 1)
        b += line(ox + seam, oy - 4, ox + seam, oy + h + 4, GOLD, 1.2, '3 3')
        pts = [(ox + x, oy + h - h * (v - lo) / (hi - lo)) for x, v in zip(xs, vals)]
        left = [p for x, p in zip(xs, pts) if x < seam]; right = [p for x, p in zip(xs, pts) if x >= seam]
        b += poly(left, c, w=1.8) + poly(right, c, w=1.8)
        b += text(ox + 150, oy - 12, lab, FG, 12, 'middle')
    plot(30, 60, [b_ + t for b_, t in zip(base, tex)], GREY, 'before: a step at the seam')
    plot(370, 60, [b_ + t + c for b_, t, c in zip(base, tex, corr)], GREEN, 'after: the same detail, no step')
    # the corrections themselves
    ox, oy = 200, 230
    b += line(ox, oy + 40, ox + 300, oy + 40, DIM, 1) + line(ox + seam, oy - 4, ox + seam, oy + 84, GOLD, 1.2, '3 3')
    pts = [(ox + x, oy + 40 - 300 * c) for x, c in zip(xs, corr)]
    b += poly([p for x, p in zip(xs, pts) if x < seam], BLUE, w=2) + poly([p for x, p in zip(xs, pts) if x >= seam], RED, w=2)
    b += text(ox + 150, oy - 14, 'the added correction: a smooth ramp on each side', FG, 12, 'middle')
    b += text(ox + 40, oy + 22, 'chart A: up', BLUE, 11) + text(ox + 260, oy + 72, 'chart B: down', RED, 11, 'end')
    b += text(30 + 75, 176, 'chart A', GREY, 11, 'middle') + text(30 + 225, 176, 'chart B', GREY, 11, 'middle')
    b += text(350, 330, 'brightness along a line across the seam; deep inside a chart the correction fades', GREY, 11, 'middle')
    svg('seam-levelling.svg', W, H, b)

# ── graph-cut.svg ────────────────────────────────────────────────────────────
def graphcut():
    W, H = 700, 400
    n = 4
    # each pixel's preference for label A (cost of B) and B (cost of A)
    prefA = [[0.95, 0.9, 0.85, 0.6], [0.9, 0.85, 0.55, 0.2], [0.85, 0.3, 0.15, 0.1], [0.4, 0.15, 0.1, 0.05]]
    # disagreement costs between neighbours: low along a diagonal valley
    def ncost(a, c):
        (i, j), (k, l) = a, c
        mid = ((i + k) / 2, (j + l) / 2)
        return 0.12 + 1.1 * min(1, abs(mid[0] + mid[1] - 2.5) / 1.2)
    nodes = [(i, j) for j in range(n) for i in range(n)]
    idx = {p: k + 2 for k, p in enumerate(nodes)}; Sx, Tx = 0, 1
    cap = {}
    def add(u, v, c): cap[(u, v)] = cap.get((u, v), 0) + c
    for (i, j) in nodes:
        add(Sx, idx[(i, j)], prefA[j][i]); add(idx[(i, j)], Tx, 1 - prefA[j][i])
        for di, dj in ((1, 0), (0, 1)):
            q = (i + di, j + dj)
            if q in idx: c = ncost((i, j), q); add(idx[(i, j)], idx[q], c); add(idx[q], idx[(i, j)], c)
    # Edmonds–Karp max flow
    flow = {k: 0 for k in cap}
    adj = {}
    for (u, v) in cap: adj.setdefault(u, set()).add(v); adj.setdefault(v, set()).add(u)
    res = lambda u, v: cap.get((u, v), 0) - flow.get((u, v), 0) + flow.get((v, u), 0) * 0
    def resid(u, v): return cap.get((u, v), 0) - flow.get((u, v), 0) + flow.get((v, u), 0)
    total = 0
    while True:
        par = {Sx: None}; qu = [Sx]
        while qu and Tx not in par:
            u = qu.pop(0)
            for v in adj[u]:
                if v not in par and resid(u, v) > 1e-9: par[v] = u; qu.append(v)
        if Tx not in par: break
        path_ = []; v = Tx
        while par[v] is not None: path_.append((par[v], v)); v = par[v]
        f = min(resid(u, v) for u, v in path_)
        for u, v in path_:
            back = min(f, flow.get((v, u), 0)); flow[(v, u)] = flow.get((v, u), 0) - back
            flow[(u, v)] = flow.get((u, v), 0) + f - back
        total += f
    side = set(par)                        # reachable from S: label A
    b = ''
    ox, oy, c = 230, 110, 62
    P = lambda i, j: (ox + i * c, oy + j * c)
    Spt, Tpt = (ox + 1.5 * c, 50), (ox + 1.5 * c, oy + 3 * c + 70)
    for (i, j) in nodes:
        p = P(i, j)
        b += line(*p, *Spt, GOLD, 0.6 + 4 * prefA[j][i], op=0.35) + line(*p, *Tpt, BLUE, 0.6 + 4 * (1 - prefA[j][i]), op=0.35)
    for (i, j) in nodes:
        for di, dj in ((1, 0), (0, 1)):
            q = (i + di, j + dj)
            if q in idx: b += line(*P(i, j), *P(*q), GREY, 0.8 + 6 * ncost((i, j), q))
    # the cut: the dual segments of every severed neighbour edge
    segs = []
    for (i, j) in nodes:
        for di, dj in ((1, 0), (0, 1)):
            q = (i + di, j + dj)
            if q in idx and ((idx[(i, j)] in side) != (idx[q] in side)):
                mx, my = P(i + di / 2, j + dj / 2)
                if di: segs.append(((mx, my - c / 2), (mx, my + c / 2)))
                else: segs.append(((mx - c / 2, my), (mx + c / 2, my)))
    for a, d in segs: b += line(*a, *d, RED, 3)
    for (i, j) in nodes:
        a_side = idx[(i, j)] in side
        b += circ(*P(i, j), 11, GOLD if a_side else BLUE) + circ(*P(i, j), 11, BG, fill=False, w=2)
    b += circ(*Spt, 15, GOLD) + text(Spt[0], Spt[1] + 5, 'A', BG, 14, 'middle')
    b += circ(*Tpt, 15, BLUE) + text(Tpt[0], Tpt[1] + 5, 'B', BG, 14, 'middle')
    b += text(Spt[0] + 24, Spt[1] + 4, 'terminal: label A', GOLD, 12) + text(Tpt[0] + 24, Tpt[1] + 4, 'terminal: label B', BLUE, 12)
    lx = 20
    b += text(lx, 130, 'grey edges: what two', GREY, 11) + text(lx, 145, 'neighbours disagreeing costs', GREY, 11)
    b += text(lx, 175, 'gold and blue edges: each', GREY, 11) + text(lx, 190, 'pixel’s preference', GREY, 11)
    b += text(lx, 220, 'thicker: costs more', GREY, 11)
    b += text(lx, 260, 'red: the minimum cut,', RED, 12) + text(lx, 276, 'along the weakest edges', RED, 12)
    b += text(lx, 300, f'its cost = the max flow, {total:.2f}', RED, 11)
    b += text(350, 392, 'the cut splits the pixels: those left with A take label A, the rest B', GREY, 11, 'middle')
    svg('graph-cut.svg', W, H, b)

def solve(A, y):
    # Gaussian elimination for a small dense system
    n = len(A); M = [row[:] + [y[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c])); M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [a - f * bb for a, bb in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]

# ── poisson-mesh.svg ─────────────────────────────────────────────────────────
def poisson():
    W, H = 720, 300
    rnd = random.Random(3)
    surf = lambda x: 120 + 18 * math.sin(x / 22) + 8 * math.sin(x / 9)
    gap = (78, 112)                                      # nothing sampled here
    xs = [x for x in [rnd.uniform(6, 154) for _ in range(46)] if not (gap[0] < x < gap[1])]
    pts = sorted((x, surf(x) + rnd.gauss(0, 1)) for x in xs)
    def normal(x):
        d = (surf(x + 0.5) - surf(x - 0.5)); n = v_norm((d, -1)); return n
    b = ''
    titles = ['1. oriented points', '2. octree around them', '3. closed isosurface', '4. after trimming']
    for k in range(4):
        ox = 10 + k * 178
        b += rect(ox, 40, 168, 210, DIM, sw=1, rx=6) + text(ox + 84, 270, titles[k], FG, 12, 'middle')
        if k < 3: b += arrow(ox + 170, 145, ox + 186, 145, GREY, 1.4, 6)
    P = lambda k, x, y: (10 + k * 178 + 4 + x, 40 + 10 + y)
    # 1
    for x, y in pts:
        n = normal(x); p = P(0, x, y)
        b += arrow(*p, p[0] + 14 * n[0], p[1] + 14 * n[1], BLUE, 1.1, 4) + circ(*p, 2.4, GOLD)
    # 2: subdivide every cell holding a point, to depth 5
    def quad(x, y, s, d):
        nonlocal b
        inside = [p for p in pts if x <= p[0] < x + s and y <= p[1] < y + s]
        b += rect(*P(1, x, y), s, s, DIM, sw=0.6)
        if inside and d < 5:
            h = s / 2
            for dx in (0, h):
                for dy in (0, h): quad(x + dx, y + dy, h, d + 1)
    quad(0, 20, 160, 0)
    for x, y in pts: b += circ(*P(1, x, y), 1.8, GOLD)
    # 3: the isosurface: through the points, ballooning over the gap and closed underneath
    top = [(x, surf(x)) for x in range(4, 157, 3) if not (gap[0] < x < gap[1])]
    def closed(k, balloon):
        left = [P(k, x, y) for x, y in top if x <= gap[0]]; right = [P(k, x, y) for x, y in top if x >= gap[1]]
        a, c = left[-1], right[0]
        mid = ((a[0] + c[0]) / 2, min(a[1], c[1]) - balloon)
        d = 'M ' + ' L '.join(f'{f2(p[0])} {f2(p[1])}' for p in left)
        d += f' Q {f2(mid[0])} {f2(mid[1])} {f2(c[0])} {f2(c[1])} L ' + ' L '.join(f'{f2(p[0])} {f2(p[1])}' for p in right)
        return d, left, right
    d, left, right = closed(2, 34)
    bot = P(2, 156, 186); bot2 = P(2, 4, 186)
    b += path(d + f' Q {f2(bot[0] + 6)} {f2(bot[1] - 40)} {f2(bot[0])} {f2(bot[1])} L {f2(bot2[0])} {f2(bot2[1])} Q {f2(bot2[0] - 6)} {f2(bot2[1] - 40)} {f2(left[0][0])} {f2(left[0][1])} Z', GREEN, fill=GREEN, w=1.8, op=0.25)
    b += path(d + f' Q {f2(bot[0] + 6)} {f2(bot[1] - 40)} {f2(bot[0])} {f2(bot[1])} L {f2(bot2[0])} {f2(bot2[1])} Q {f2(bot2[0] - 6)} {f2(bot2[1] - 40)} {f2(left[0][0])} {f2(left[0][1])} Z', GREEN, w=1.8)
    gm = P(2, (gap[0] + gap[1]) / 2, 0)
    b += text(gm[0], 72, 'balloon over the gap', RED, 10, 'middle')
    b += text(10 + 2 * 178 + 84, 232, 'closed below as well', RED, 10, 'middle')
    # 4: trimmed where the points are sparse
    b += poly(left := [P(3, x, y) for x, y in top if x <= gap[0]], GREEN, w=2) + poly([P(3, x, y) for x, y in top if x >= gap[1]], GREEN, w=2)
    for x, y in pts: b += circ(*P(3, x, y), 1.6, GOLD)
    b += text(P(3, (gap[0] + gap[1]) / 2, 0)[0], 92, 'left open', GREY, 10, 'middle')
    b += text(10 + 3 * 178 + 84, 232, 'cut where no points support it', GREY, 10, 'middle')
    b += text(360, 22, 'screened Poisson in a cross-section: the points’ normals define a closed surface, then it is trimmed', GREY, 11, 'middle')
    svg('poisson-mesh.svg', W, H, b)

# ── mesh-decimation.svg ──────────────────────────────────────────────────────
def decimate():
    W, H = 700, 340
    b = ''
    # one edge collapse, top view: a fan around v1–v2
    v1, v2 = (90, 150), (150, 150)
    ring = [(60, 100), (120, 85), (180, 100), (195, 150), (180, 200), (120, 215), (60, 200), (45, 150)]
    def tris(vs, centre_pairs):
        out = ''
        for a, c, d in centre_pairs: out += poly([a, c, d], GREY, fill=RAISED, w=1.2, closed=True)
        return out
    fan1 = [(v1, ring[7], ring[0]), (v1, ring[0], ring[1]), (v1, ring[5], ring[6]), (v1, ring[6], ring[7]),
            (v2, ring[1], ring[2]), (v2, ring[2], ring[3]), (v2, ring[3], ring[4]), (v2, ring[4], ring[5])]
    gone = [(v1, v2, ring[1]), (v1, v2, ring[5])]
    b += tris(None, fan1)
    for t in gone: b += poly(list(t), RED, fill=RED, w=1.2, op=0.35, closed=True)
    b += line(*v1, *v2, RED, 2.6)
    b += circ(*v1, 4.5, BLUE) + circ(*v2, 4.5, BLUE) + text(v1[0] - 6, v1[1] - 8, 'v1', BLUE, 12, 'end') + text(v2[0] + 6, v2[1] - 8, 'v2', BLUE, 12)
    b += text(120, 40, 'one edge collapse', FG, 13, 'middle')
    b += text(120, 240, 'the two triangles', RED, 11, 'middle') + text(120, 254, 'on the edge (red) go', RED, 11, 'middle')
    b += arrow(205, 150, 235, 150, GREY, 1.6, 7)
    # after: merged vertex
    off = 170
    vm = (off + 122, 152)
    for a, c in zip(ring, ring[1:] + ring[:1]):
        b += poly([vm, (a[0] + off, a[1]), (c[0] + off, c[1])], GREY, fill=RAISED, w=1.2, closed=True)
    b += circ(*vm, 5, GREEN) + text(vm[0], vm[1] - 10, 'v̄', GREEN, 13, 'middle')
    b += text(off + 122, 240, 'v̄: least summed squared', GREEN, 11, 'middle') + text(off + 122, 254, 'distance to the faces’ planes', GREEN, 11, 'middle')
    # right: a terrain mesh simplified by error: big triangles on flat ground, small on the ridge
    zf = lambda x, y: 60 * math.exp(-((x - y * 0.6 - 0.25) / 0.08) ** 2) + 4 * math.sin(6 * x) * math.sin(5 * y)
    N = 16
    full = 2 * N * N
    def err(x, y, s):  # how far the square's flat interpolation is from the terrain
        c = [zf(x, y), zf(x + s, y), zf(x, y + s), zf(x + s, y + s)]
        return max(abs(zf(x + s * u, y + s * v) - ((1 - u) * (1 - v) * c[0] + u * (1 - v) * c[1] + (1 - u) * v * c[2] + u * v * c[3])) for u in (0.25, 0.5, 0.75) for v in (0.25, 0.5, 0.75))
    def build(tol):
        sq = []
        def rec(x, y, s):
            if s > 1 / N + 1e-9 and err(x, y, s) > tol: [rec(x + dx, y + dy, s / 2) for dx in (0, s / 2) for dy in (0, s / 2)]
            else: sq.append((x, y, s))
        rec(0, 0, 1)
        return sq
    tol = 0.3
    for _ in range(40):
        sq = build(tol)
        if 2 * len(sq) <= full / 4: break
        tol *= 1.25
    ox, oy, S = 420, 60, 240
    zs = [zf(x / 40, y / 40) for x in range(41) for y in range(41)]; zlo, zhi = min(zs), max(zs)
    for (x, y, s) in sq:
        c = ramp((zf(x + s / 2, y + s / 2) - zlo) / (zhi - zlo))
        a, bb, cc, dd = (ox + x * S, oy + y * S), (ox + (x + s) * S, oy + y * S), (ox + (x + s) * S, oy + (y + s) * S), (ox + x * S, oy + (y + s) * S)
        b += poly([a, bb, cc], DIM, fill=c, w=0.6, closed=True) + poly([a, cc, dd], DIM, fill=c, w=0.6, closed=True)
    b += text(ox + S / 2, 40, f'a terrain mesh: {full:,} triangles to {2 * len(sq):,}', FG, 13, 'middle')
    b += text(ox + S / 2, oy + S + 20, 'large triangles on flat ground,', GREY, 11, 'middle') + text(ox + S / 2, oy + S + 34, 'small ones along the ridge', GREY, 11, 'middle')
    svg('mesh-decimation.svg', W, H, b)

# ── texture-atlas.svg ────────────────────────────────────────────────────────
def atlas():
    W, H = 700, 330
    rnd = random.Random(8)
    def tex(kind, w=24, h=24):
        px = []
        for j in range(h):
            row = []
            for i in range(w):
                if kind == 'top': t = 0.5 + 0.2 * math.sin(i / 2.5) * math.cos(j / 3) + rnd.gauss(0, 0.06); row.append((80 + 60 * t, 120 + 60 * t, 70 + 30 * t))
                else:
                    mortar = j % 6 == 0 or (i + (6 if (j // 6) % 2 else 0)) % 12 == 0
                    base = (178, 92, 70) if kind == 'side1' else (160, 84, 66)
                    row.append((205, 200, 190) if mortar else tuple(c + rnd.gauss(0, 8) for c in base))
            px.append(row)
        return px
    T = {k: tex(k) for k in ('top', 'side1', 'side2')}
    def mapped(px, o, u, v):
        # the unit square onto the parallelogram o + s·u + t·v
        uri = png_uri(px)
        return f'  <image width="1" height="1" preserveAspectRatio="none" style="image-rendering:pixelated" transform="matrix({f2(u[0])} {f2(u[1])} {f2(v[0])} {f2(v[1])} {f2(o[0])} {f2(o[1])})" href="{uri}"/>\n'
    b = ''
    # the box, in an oblique view
    O = (80, 140); ux, uy, uz = (110, 30), (-50, 34), (0, -80)
    top_o = (O[0] + uz[0], O[1] + uz[1])
    b += mapped(T['top'], top_o, ux, uy)
    b += mapped(T['side1'], (top_o[0] + uy[0], top_o[1] + uy[1]), ux, (-uz[0], -uz[1]))
    right_o = (top_o[0] + ux[0], top_o[1] + ux[1])          # the faces at the nearest corner show
    b += mapped(T['side2'], right_o, uy, (-uz[0], -uz[1]))
    for o_, a_, c_ in ((top_o, ux, uy), ((top_o[0] + uy[0], top_o[1] + uy[1]), ux, (0, 80)), (right_o, uy, (0, 80))):
        b += poly([o_, (o_[0] + a_[0], o_[1] + a_[1]), (o_[0] + a_[0] + c_[0], o_[1] + a_[1] + c_[1]), (o_[0] + c_[0], o_[1] + c_[1])], FG, w=1.2, closed=True)
    # one triangle on the top face: its corners in (s, t) of that chart
    tri = [(0.2, 0.25), (0.75, 0.3), (0.45, 0.8)]
    onbox = [(top_o[0] + s * ux[0] + t * uy[0], top_o[1] + s * ux[1] + t * uy[1]) for s, t in tri]
    b += poly(onbox, GOLD, w=2, closed=True)
    for k, p in enumerate(onbox): b += circ(*p, 3.5, GOLD) + text(p[0] + 5, p[1] - 5, str(k + 1), GOLD, 11)
    b += text(110, 36, 'a textured box', FG, 13, 'middle')
    # the atlas page
    ax, ay, A = 400, 50, 240
    b += rect(ax, ay, A, A, DIM, fill=RAISED, sw=1)
    charts = {'top': (ax + 8, ay + 8, 120, 120), 'side1': (ax + 136, ay + 8, 96, 150), 'side2': (ax + 8, ay + 136, 120, 90)}
    for k, (x, y, w_, h_) in charts.items():
        b += image(x, y, w_, h_, T[k], smooth=False) + rect(x, y, w_, h_, FG, sw=1.2)
    x, y, w_, h_ = charts['top']
    onpage = [(x + s * w_, y + t * h_) for s, t in tri]
    b += poly(onpage, GOLD, w=2, closed=True)
    for k, p in enumerate(onpage): b += circ(*p, 3.5, GOLD) + text(p[0] + 5, p[1] - 5, str(k + 1), GOLD, 11)
    b += text(ax + A / 2, 36, 'one atlas page: the charts packed side by side', FG, 13, 'middle')
    b += text(ax + A + 8, ay + 70, 'top', GREY, 11) + text(ax + A + 8, ay + 150, 'sides', GREY, 11)
    b += curve((onbox[1][0] + 10, onbox[1][1] - 6), (onpage[0][0] - 8, onpage[0][1]), -40, GOLD, 1.2, '4 3')
    b += text(350, 320, 'each corner carries UV coordinates: where on the page its colour comes from', GREY, 11, 'middle')
    svg('texture-atlas.svg', W, H, b)

# ── view-selection.svg ───────────────────────────────────────────────────────
def viewsel():
    W, H = 700, 330
    rnd = random.Random(2)
    n = 14
    # triangles of a grid mesh; five photos, each best near its own nadir, plus per-triangle noise
    nadirs = [(0.2, 0.25), (0.75, 0.2), (0.5, 0.55), (0.2, 0.8), (0.8, 0.8)]
    cols = [BLUE, GOLD, GREEN, RED, GREY]
    tris = []
    for j in range(n):
        for i in range(n):
            for half in (0, 1):
                cx = (i + (0.66 if half else 0.33)) / n; cy = (j + (0.33 if half else 0.66)) / n
                tris.append((i, j, half, cx, cy))
    cost = [[min(1, math.dist((t[3], t[4]), nd) * 1.6) + rnd.uniform(0, 0.55) for nd in nadirs] for t in tris]
    idx = {(t[0], t[1], t[2]): k for k, t in enumerate(tris)}
    def nbrs(t):
        i, j, h = t[0], t[1], t[2]
        out = [(i, j, 1 - h)]
        out += [(i, j - 1, 0)] if h else [(i, j + 1, 1)]
        out += [(i + 1, j, 0)] if h else [(i - 1, j, 1)]
        return [idx[q] for q in out if q in idx]
    N = [nbrs(t) for t in tris]
    lab0 = [min(range(5), key=lambda k: c[k]) for c in cost]
    lab = lab0[:]
    lam = 0.35
    for _ in range(12):  # iterated conditional modes: each triangle takes its best label given its neighbours
        for k in range(len(tris)):
            lab[k] = min(range(5), key=lambda L: cost[k][L] + lam * sum(1 for m in N[k] if lab[m] != L))
    seams = lambda L: sum(1 for k in range(len(tris)) for m in N[k] if m > k and L[k] != L[m])
    b = ''
    for pi, (L, title) in enumerate(((lab0, 'no seam penalty: confetti'), (lab, 'with a seam penalty: large patches'))):
        ox, oy, S = 30 + pi * 350, 50, 230
        for k, (i, j, h, _, _) in enumerate(tris):
            a, c_, d, e = (ox + i * S / n, oy + j * S / n), (ox + (i + 1) * S / n, oy + j * S / n), (ox + (i + 1) * S / n, oy + (j + 1) * S / n), (ox + i * S / n, oy + (j + 1) * S / n)
            pts = [a, c_, d] if h else [a, d, e]
            b += poly(pts, BG, fill=cols[L[k]], w=0.4, closed=True)
        for nd, c in zip(nadirs, cols): b += cross(ox + nd[0] * S, oy + nd[1] * S, FG, 5, 2)
        b += text(ox + S / 2, 36, title, FG, 13, 'middle')
        b += text(ox + S / 2, oy + S + 20, f'{seams(L)} seam edges', GREY, 11, 'middle')
    b += text(350, 318, 'each colour: the photo a triangle takes its texture from; crosses: the photos’ nadir points', GREY, 11, 'middle')
    svg('view-selection.svg', W, H, b)

# ── icp-point-to-plane.svg ───────────────────────────────────────────────────
def icp():
    W, H = 700, 400
    rnd = random.Random(6)
    f = lambda x: 40 * math.sin(x / 45) + 12 * math.sin(x / 13)
    ref = [(x, f(x)) for x in range(0, 301, 12)]
    def nrm(x):
        d = f(x + 0.5) - f(x - 0.5); return v_norm((-d, 1))
    true_mov = [(x, f(x)) for x in [6 + 11.5 * k + rnd.uniform(-2, 2) for k in range(25)]]
    th, t0 = math.radians(5), (14, -10)
    moved = [(lambda q: (q[0] + t0[0], q[1] + t0[1]))(rot2(p, th, (150, 0))) for p in true_mov]
    b = ''
    def draw_panel(ox, oy, mode):
        nonlocal b
        S = lambda p: (ox + p[0], oy - p[1])
        b += poly([S((x, f(x))) for x in range(0, 301, 3)], DIM, w=1, dash='3 3')
        for p in ref:
            b += circ(*S(p), 2.6, BLUE)
            if mode == 'plane': n = nrm(p[0]); b += line(*S(p), *S((p[0] + 12 * n[0], p[1] + 12 * n[1])), BLUE, 0.9)
        for q in moved:
            r = min(ref, key=lambda p: math.dist(p, q))
            if mode == 'point':
                b += line(*S(q), *S(r), RED, 1.2)
            else:
                n = nrm(r[0]); d = (q[0] - r[0]) * n[0] + (q[1] - r[1]) * n[1]
                foot = (q[0] - d * n[0], q[1] - d * n[1])
                b += line(*S(q), *S(foot), GREEN, 1.4)
            b += circ(*S(q), 2.6, GOLD)
    draw_panel(20, 140, 'point'); draw_panel(370, 140, 'plane')
    b += text(170, 36, 'point to point: pairs pull along the surface', FG, 12, 'middle')
    b += text(520, 36, 'point to plane: only the offset off it counts', FG, 12, 'middle')
    b += text(170, 214, 'blue: reference · gold: moving cloud', GREY, 11, 'middle')
    b += text(520, 214, 'residual along the reference’s normal', GREEN, 11, 'middle')
    # point-to-plane ICP, run for three iterations
    cur = moved[:]
    states = [cur]
    for it in range(3):
        A = [[0.0] * 3 for _ in range(3)]; y = [0.0] * 3
        cx = sum(p[0] for p in cur) / len(cur); cy = sum(p[1] for p in cur) / len(cur)
        for q in cur:
            r = min(ref, key=lambda p: math.dist(p, q)); n = nrm(r[0])
            # small rotation θ about the centroid, then shift: residual n·(q + θ·perp(q−c) + t − r)
            px, py = -(q[1] - cy), q[0] - cx
            J = [n[0] * px + n[1] * py, n[0], n[1]]; e = (q[0] - r[0]) * n[0] + (q[1] - r[1]) * n[1]
            for i in range(3):
                y[i] -= J[i] * e
                for k in range(3): A[i][k] += J[i] * J[k]
        thv, tx, ty = solve(A, y)
        cur = [(lambda q: (q[0] + tx, q[1] + ty))(rot2(p, thv, (cx, cy))) for p in cur]
        states.append(cur)
    b += line(20, 228, 680, 228, DIM, 1, '2 4')
    for k, st in enumerate(states):
        ox, oy = 25 + k * 166, 330
        S = lambda p: (ox + p[0] * 0.5, oy - p[1] * 0.5)
        b += poly([S((x, f(x))) for x in range(0, 301, 4)], BLUE, w=1.2)
        for q in st: b += circ(*S(q), 1.8, GOLD)
        rms = math.sqrt(sum(((q[0] - min(ref, key=lambda p: math.dist(p, q))[0]) * nrm(q[0])[0] + (q[1] - f(q[0])) * nrm(q[0])[1]) ** 2 for q in st) / len(st))
        b += text(ox + 75, 384, 'start' if k == 0 else f'iteration {k}', FG, 11, 'middle')
    b += text(350, 250, 'point to plane, iteration by iteration: the moving cloud settles onto the reference', GREY, 11, 'middle')
    svg('icp-point-to-plane.svg', W, H, b)

# ── 3d-tiles.svg ─────────────────────────────────────────────────────────────
def tiles3d():
    W, H = 700, 360
    ox, oy, S = 30, 40, 300                              # the root tile, 2,000 m across
    cam = (0.18, 0.86); cam_h = 120.0                   # camera position (fraction) and height (m)
    root_m, ge0, thresh, k_px = 2000.0, 64.0, 16.0, 1000.0
    tiles = []
    def rec(x, y, s, d):
        cxm, cym = (x + s / 2) * root_m, (y + s / 2) * root_m
        dist = math.sqrt((cxm - cam[0] * root_m) ** 2 + (cym - cam[1] * root_m) ** 2 + cam_h ** 2)
        dist = max(dist - s * root_m * 0.7, cam_h)      # to the tile's near side, roughly
        ge = ge0 / 2 ** d; sse = ge * k_px / dist
        if sse > thresh and d < 5:
            for dx in (0, s / 2):
                for dy in (0, s / 2): rec(x + dx, y + dy, s / 2, d + 1)
        else: tiles.append((x, y, s, d, sse, ge))
    rec(0, 0, 1, 0)
    b = ''
    shades = [RAISED, BLUE, GREEN, GOLD, RED, RED]
    for (x, y, s, d, sse, ge) in tiles:
        b += rect(ox + x * S, oy + y * S, s * S, s * S, DIM, fill=shades[d], sw=0.8, op=None if d == 0 else 0.22 + 0.06 * d)
        b += rect(ox + x * S, oy + y * S, s * S, s * S, DIM, sw=0.8)
        if s * S >= 36: b += text(ox + (x + s / 2) * S, oy + (y + s / 2) * S + 4, f'{sse:.0f} px', FG, 11 if s * S > 60 else 9, 'middle')
    # the camera and its view
    cx, cy = ox + cam[0] * S, oy + cam[1] * S
    b += poly([(cx, cy), (cx + 190, cy - 230), (cx + 300, cy - 120)], BLUE, fill=BLUE, w=1, op=0.10, closed=True)
    b += poly([(cx + 190, cy - 230), (cx, cy), (cx + 300, cy - 120)], BLUE, w=1.2, dash='4 3')
    b += cam2d(cx, cy, math.atan2(-175, 245), size=16)
    b += text(cx - 8, cy + 22, 'camera', BLUE, 11, 'middle')
    # key
    kx = 370
    b += text(kx, 70, 'a tile is split when its geometric error,', FG, 12) + text(kx, 86, 'seen from the camera, exceeds 16 px', FG, 12)
    for d in range(5):
        y = 120 + d * 28
        b += rect(kx, y, 18, 18, DIM, fill=shades[d], sw=0.8, op=None if d == 0 else 0.22 + 0.06 * d)
        b += text(kx + 28, y + 14, f'level {d}: {2000 / 2 ** d:,.0f} m tile, geometric error {64 / 2 ** d:g} m', GREY, 11)
    b += text(kx, 280, 'numbers: each drawn tile’s error on screen', GREY, 11)
    b += text(kx, 296, 'far tiles stay coarse; near ones refine', GREY, 11)
    svg('3d-tiles.svg', W, H, b)

def dem_tile(n, seed=0):
    # a small terrain: a ridge, a valley and a knoll, in metres on a 1 m grid
    return [[30 * math.exp(-(((i - n * 0.35) / (n * 0.22)) ** 2)) * (0.6 + 0.4 * math.sin(j / n * 3))
             + 18 * math.exp(-(((i - n * 0.75) ** 2 + (j - n * 0.3) ** 2) / (n * 0.15) ** 2)) + 0.12 * j
             for i in range(n)] for j in range(n)]
def horn(z, dx=1.0):
    n = len(z); g = lambda j, i: z[min(n - 1, max(0, j))][min(n - 1, max(0, i))]
    gx = [[((g(j - 1, i + 1) + 2 * g(j, i + 1) + g(j + 1, i + 1)) - (g(j - 1, i - 1) + 2 * g(j, i - 1) + g(j + 1, i - 1))) / (8 * dx) for i in range(n)] for j in range(n)]
    gy = [[((g(j + 1, i - 1) + 2 * g(j + 1, i) + g(j + 1, i + 1)) - (g(j - 1, i - 1) + 2 * g(j - 1, i) + g(j - 1, i + 1))) / (8 * dx) for i in range(n)] for j in range(n)]
    return gx, gy            # gy: change toward the south (rows grow southward)
def hsv(h, s, v):
    i = int(h * 6) % 6; f = h * 6 - int(h * 6); p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]

# ── terrain-derivatives.svg ──────────────────────────────────────────────────
def terrain():
    W, H = 720, 340
    n = 56
    z = dem_tile(n)
    gx, gy = horn(z, 4.0)                                   # 4 m cells
    zlo = min(min(r) for r in z); zhi = max(max(r) for r in z)
    slope = [[math.degrees(math.atan(math.hypot(a, c))) for a, c in zip(ra, rc)] for ra, rc in zip(gx, gy)]
    # aspect: the compass direction the slope faces (downhill), 0 = north, clockwise
    aspect = [[(math.degrees(math.atan2(-a, c)) + 360) % 360 for a, c in zip(ra, rc)] for ra, rc in zip(gx, gy)]
    az, alt = math.radians(315), math.radians(45)          # sun from the north-west
    def shade(a, c):
        sl = math.atan(math.hypot(a, c)); asp = math.atan2(-a, c)
        return max(0, math.cos(alt) * math.cos(sl) + math.sin(alt) * math.sin(sl) * math.cos(az - asp - math.pi) * -1)
    # a direct form: light vector from the NW, surface normal from the gradient
    L = (math.sin(az) * math.cos(alt), -math.cos(az) * math.cos(alt), math.sin(alt))   # x east, y south, z up
    hs = [[max(0, v_dot(v_norm((-a, -c, 1)), L)) for a, c in zip(ra, rc)] for ra, rc in zip(gx, gy)]
    S = 150
    b = ''
    panels = [('heights', map_px(z, lambda v: ramp((v - zlo) / (zhi - zlo)))),
              ('slope', map_px(slope, lambda v: ramp(min(1, v / 45), ((0, (240, 240, 230)), (1, (150, 60, 50)))))),
              ('aspect', [[tuple(255 * c for c in hsv(a / 360, 0.55, 0.9)) for a in row] for row in aspect]),
              ('hillshade, sun from the north-west', gray_px(hs, 0, 1))]
    for k, (lab, px) in enumerate(panels):
        x = 20 + k * 172
        b += image(x, 50, S, S, px) + rect(x, 50, S, S, DIM, sw=1)
        b += text(x + S / 2, 36, lab, FG, 12, 'middle')
    # keys
    b += text(20 + S / 2, 222, f'{zlo:.0f} to {zhi:.0f} m, on 4 m cells', GREY, 11, 'middle')
    b += text(192 + S / 2, 222, '0° flat to 45°+ steep', GREY, 11, 'middle')
    wx, wy, wr = 364 + S / 2, 270, 24
    for k in range(36):
        a0, a1 = math.radians(k * 10 - 90), math.radians(k * 10 - 80)
        col = hexc(*(255 * c for c in hsv(k * 10 / 360, 0.55, 0.9)))
        b += poly([(wx, wy), (wx + wr * math.cos(a0), wy + wr * math.sin(a0)), (wx + wr * math.cos(a1), wy + wr * math.sin(a1))], None, fill=col, closed=True)
    for lab_, a in (('N', -90), ('E', 0), ('S', 90), ('W', 180)):
        b += text(wx + (wr + 9) * math.cos(math.radians(a)), wy + (wr + 9) * math.sin(math.radians(a)) + 4, lab_, GREY, 10, 'middle')
    b += text(364 + S / 2, 222, 'the way the slope faces', GREY, 11, 'middle')
    sx, sy = 536 + 18, 68
    b += arrow(sx, sy, sx + 26, sy + 26, GOLD, 2.2, 8) + circ(sx, sy, 6, GOLD)
    b += text(536 + S / 2, 222, 'light from 315°, 45° high', GREY, 11, 'middle')
    b += text(360, 330, 'one DEM tile four ways; slope, aspect and hillshade all come from Horn’s 3 × 3 gradient', GREY, 11, 'middle')
    svg('terrain-derivatives.svg', W, H, b)

# ── gap-interpolation.svg ────────────────────────────────────────────────────
def gapfill():
    W, H = 700, 340
    nx, ny, c = 18, 13, 20
    z = [[0.5 + 0.3 * math.sin(i / 4) * math.cos(j / 5) + 0.02 * j for i in range(nx)] for j in range(ny)]
    holes = {(3, 3), (13, 2), (8, 9), (4, 10)}
    big = {(i, j) for i in range(10, 17) for j in range(5, 11)}
    nod = holes | big
    r = 2.0
    measured = lambda i, j: (i, j) not in nod
    def fill(i, j):
        near = [(math.hypot(i - a, j - bb), z[bb][a]) for a in range(nx) for bb in range(ny) if measured(a, bb) and 0 < math.hypot(i - a, j - bb) <= r]
        if not near: return None
        return sum(v / d ** 2 for d, v in near) / sum(1 / d ** 2 for d, v in near)
    b = ''
    zl, zh = min(min(rw) for rw in z), max(max(rw) for rw in z)
    for pi, after in enumerate((False, True)):
        ox, oy = 20 + pi * 345, 50
        for j in range(ny):
            for i in range(nx):
                x, y = ox + i * c / 1.12, oy + j * c / 1.12; cc = c / 1.12
                if measured(i, j):
                    b += rect(x, y, cc, cc, fill=ramp((z[j][i] - zl) / (zh - zl)))
                else:
                    v = fill(i, j) if after else None
                    if v is None:
                        b += rect(x, y, cc, cc, fill=RAISED) + line(x + 2, y + cc - 2, x + cc - 2, y + 2, DIM, 1)
                    else:
                        b += rect(x, y, cc, cc, fill=ramp((v - zl) / (zh - zl))) + circ(x + cc / 2, y + cc / 2, 2.2, FG)
        b += rect(ox, oy, nx * c / 1.12, ny * c / 1.12, DIM, sw=1)
        b += text(ox + nx * c / 2.24, 36, 'after: filled within the radius' if after else 'before: holes with no height', FG, 12, 'middle')
        cc = c / 1.12
        if after:
            for (i, j) in ((3, 3), (13, 7)):
                b += circ(ox + (i + 0.5) * cc, oy + (j + 0.5) * cc, r * cc, GOLD if (i, j) == (3, 3) else RED, fill=False, w=1.8)
    b += text(20 + 345 + 2, 318, 'gold: a small hole, measured cells inside the radius: filled (dot)', GOLD, 11)
    b += text(20 + 345 + 2, 334, 'red: deep in the large hole, none inside: stays nodata', RED, 11)
    b += text(20, 318, 'only the rim of the large hole is filled;', GREY, 11) + text(20, 334, 'a filled cell never feeds another', GREY, 11)
    svg('gap-interpolation.svg', W, H, b)

# ── elevation-profile.svg ────────────────────────────────────────────────────
def profile():
    W, H = 700, 330
    n = 60
    z = [[40 + 35 * abs((i - n * 0.5) / (n * 0.5)) ** 1.4 + 6 * math.sin(j / 6) + 0.2 * j for i in range(n)] for j in range(n)]
    hole = lambda i, j: (i - 38) ** 2 + (j - 24) ** 2 < 30
    zl = min(min(r) for r in z); zh = max(max(r) for r in z)
    S = 4.0; ox, oy = 30, 40
    b = rect(ox, oy, n * S, n * S, DIM, fill=RAISED, sw=1)
    b += image(ox, oy, n * S, n * S, map_px([[None if hole(i, j) else (v - zl) / (zh - zl) for i, v in enumerate(row)] for j, row in enumerate(z)], ramp))
    b += rect(ox, oy, n * S, n * S, DIM, sw=1)
    line_pts = [(4, 44), (30, 30), (56, 18)]
    b += poly([(ox + x * S, oy + y * S) for x, y in line_pts], RED, w=2.4)
    for k, (x, y) in enumerate(line_pts): b += circ(ox + x * S, oy + y * S, 4, RED)
    b += text(ox + 4 * S - 6, oy + 44 * S + 18, 'A', RED, 12) + text(ox + 56 * S + 4, oy + 18 * S - 8, 'B', RED, 12)
    b += text(ox + 38 * S, oy + 24 * S + 4, 'no height', GREY, 10, 'middle')
    b += text(ox + n * S / 2, 30, 'the line drawn across a valley', FG, 12, 'middle')
    # sample about one cell apart, bilinear between cell centres; a nodata cell breaks the line
    def zat(x, y):
        i, j = int(x), int(y); fx, fy = x - i, y - j
        cells = [(i, j), (i + 1, j), (i, j + 1), (i + 1, j + 1)]
        if any(hole(a, c) or not (0 <= a < n and 0 <= c < n) for a, c in cells): return None
        return (z[j][i] * (1 - fx) + z[j][i + 1] * fx) * (1 - fy) + (z[j + 1][i] * (1 - fx) + z[j + 1][i + 1] * fx) * fy
    samples = []; dist = 0.0
    for (a, c) in zip(line_pts, line_pts[1:]):
        L = math.dist(a, c); m = int(L)
        for k in range(m):
            t = k / m; x, y = a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])
            samples.append((dist + t * L, zat(x, y)))
        dist += L
    gx, gy, gw, gh = 330, 60, 340, 190
    b += line(gx, gy + gh, gx + gw, gy + gh, GREY, 1) + line(gx, gy, gx, gy + gh, GREY, 1)
    vs = [v for _, v in samples if v is not None]; lo, hi = min(vs) - 5, max(vs) + 5
    P = lambda d, v: (gx + gw * d / dist, gy + gh - gh * (v - lo) / (hi - lo))
    seg = []
    for d, v in samples:
        if v is None:
            if len(seg) > 1: b += poly(seg, GOLD, w=2)
            seg = []
            continue
        seg.append(P(d, v))
    if len(seg) > 1: b += poly(seg, GOLD, w=2)
    gap_ds = [d for d, v in samples if v is None]
    if gap_ds:
        x0, x1 = P(min(gap_ds), lo)[0], P(max(gap_ds), lo)[0]
        b += rect(x0, gy, x1 - x0, gh, fill=RAISED, op=0.7) + text((x0 + x1) / 2, gy + 16, 'gap: no height', GREY, 10, 'middle')
    b += text(gx, gy + gh + 18, 'A', RED, 12, 'middle') + text(gx + gw, gy + gh + 18, 'B', RED, 12, 'middle')
    b += text(gx + gw / 2, gy + gh + 34, f'distance along the line (m, {dist:.0f} m long)', GREY, 11, 'middle')
    b += text(gx - 8, gy + 4, f'{hi:.0f}', GREY, 10, 'end') + text(gx - 8, gy + gh, f'{lo:.0f}', GREY, 10, 'end')
    b += text(gx - 30, gy + gh / 2, 'height', GREY, 11, 'end') if False else text(gx + 4, gy - 8, 'height (m)', GREY, 11)
    b += text(gx + gw / 2, 30, 'the profile: height against distance', FG, 12, 'middle')
    b += text(350, 320, 'sampled about one DEM cell apart; where the DEM has no height the profile breaks rather than inventing terrain', GREY, 11, 'middle')
    svg('elevation-profile.svg', W, H, b)

# ── level-of-detail.svg ──────────────────────────────────────────────────────
def lod():
    W, H = 720, 320
    rnd = random.Random(4)
    zt = lambda x, y: 0.12 + 0.08 * math.sin(5 * x) * math.cos(4 * y) + 0.05 * math.sin(11 * x + 3 * y)
    def iso(ox, oy, s):
        return lambda p: (ox + s * (p[0] - p[1]) * 0.87, oy + s * ((p[0] + p[1]) * 0.5 - p[2] * 1.0))
    def cube(P, x, y, z_, e, c, w=1.2):
        pts = lambda a: P(a)
        v = [(x + dx * e, y + dy * e, z_ + dz * e) for dz in (0, 1) for dy in (0, 1) for dx in (0, 1)]
        out = ''
        for a, bb in ((0, 1), (1, 3), (3, 2), (2, 0), (4, 5), (5, 7), (7, 6), (6, 4), (0, 4), (1, 5), (2, 6), (3, 7)):
            out += line(*P(v[a]), *P(v[bb]), c, w, op=0.85)
        return out
    def sample(x0, y0, e, m):
        # a node's sample: about one point per cell of an m × m grid over its square
        out = []
        for i in range(m):
            for j in range(m):
                x = x0 + (i + rnd.random()) * e / m; y = y0 + (j + rnd.random()) * e / m
                out.append((x, y, zt(x, y)))
        return out
    root = sample(0, 0, 1, 11)
    child = sample(0.5, 0.5, 0.5, 11)
    grand = sample(0.75, 0.75, 0.25, 11)
    b = ''
    titles = ['root: a sparse sample of all', 'one child adds its own sample', 'and its child again']
    for k in range(3):
        P = iso(120 + k * 240, 155, 105)
        b += cube(P, 0, 0, 0, 1, DIM, 1)
        pts = root + (child if k >= 1 else []) + (grand if k >= 2 else [])
        for p in sorted(pts, key=lambda p: p[0] + p[1]):
            col = GOLD if p in root else (GREEN if p in child else BLUE)
            b += circ(*P(p), 1.9, col)
        if k >= 1: b += cube(P, 0.5, 0.5, 0, 0.5, GREEN, 1.4)
        if k >= 2: b += cube(P, 0.75, 0.75, 0, 0.25, BLUE, 1.6)
        b += text(120 + k * 240, 288, titles[k], FG, 12, 'middle')
        if k < 2: b += arrow(120 + k * 240 + 100, 160, 120 + k * 240 + 136, 160, GREY, 1.4, 6)
    b += text(360, 22, 'an octree of a terrain cloud: each node keeps a thin even sample, its children the detail', GREY, 11, 'middle')
    b += text(360, 310, 'every point is in exactly one node; the viewer loads the nodes largest on screen first', GREY, 11, 'middle')
    svg('level-of-detail.svg', W, H, b)

# ── ground-classification.svg ────────────────────────────────────────────────
def groundcls():
    W, H = 700, 340
    rnd = random.Random(10)
    terr = lambda x: 230 - 18 * math.sin(x / 90) - 6 * math.sin(x / 31)
    pts = []
    for x in [rnd.uniform(10, 690) for _ in range(260)]:
        if 250 < x < 380: continue                               # under the roof: no ground seen
        if 480 < x < 600 and rnd.random() < 0.75: continue      # under the tree: a few ground hits only
        pts.append((x, terr(x) + rnd.gauss(0, 1.2)))
    for x in [rnd.uniform(250, 380) for _ in range(40)]:        # the roof
        pts.append((x, 120 + abs(x - 315) * 0.45 + rnd.gauss(0, 1)))
    for y in [rnd.uniform(150, 225) for _ in range(10)]:         # wall points
        pts.append((250 + rnd.gauss(0, 1), y)); pts.append((380 + rnd.gauss(0, 1), y))
    for _ in range(70):                                          # the canopy
        a = rnd.uniform(0, 2 * math.pi); r = rnd.uniform(0.6, 1) ** 0.5
        pts.append((540 + 62 * r * math.cos(a), 130 + 40 * r * math.sin(a)))
    # the cloth: dropped onto the cloud turned upside down, held by its springs
    # 100 cells, 15 spring passes: stiff enough to span the roof, loose enough to follow
    # the open ground (a stiffer cloth spans more and follows less)
    N = 100; xs = [10 + k * 680 / (N - 1) for k in range(N)]
    lowest = [None] * N                                          # per cell, the lowest point (largest y on screen)
    for x, y in pts:
        k = min(N - 1, max(0, round((x - 10) / (680 / (N - 1)))))
        lowest[k] = y if lowest[k] is None else max(lowest[k], y)
    cl = [400.0] * N; fixed = [False] * N
    for _ in range(300):
        for k in range(N):
            if fixed[k]: continue
            cl[k] -= 1.5
            if lowest[k] is not None and cl[k] <= lowest[k]: cl[k] = lowest[k]; fixed[k] = True
        for _ in range(15):                                      # springs between neighbours
            for k in range(N - 1):
                d = cl[k + 1] - cl[k]
                if fixed[k] and fixed[k + 1]: continue
                if fixed[k]: cl[k + 1] -= d * 0.5
                elif fixed[k + 1]: cl[k] += d * 0.5
                else: cl[k] += d * 0.25; cl[k + 1] -= d * 0.25
    cloth = lambda x: (lambda k: cl[k])(min(N - 1, max(0, round((x - 10) / (680 / (N - 1))))))
    b = ''
    tol = 6
    for x, y in pts:
        g = abs(y - cloth(x)) < tol
        b += circ(x, y, 2.6, GOLD if g else GREEN)
    b += poly([(x, c) for x, c in zip(xs, cl)], BLUE, w=2.2)
    for x in range(40, 680, 60):
        b += arrow(x, cloth(x) + 34, x, cloth(x) + 8, BLUE, 1.2, 6, op=0.6)
    b += text(315, 270, 'spans under the roof', BLUE, 11, 'middle') + text(540, 266, 'reaches the ground between the branches', BLUE, 11, 'middle')
    b += text(100, 290, 'cloth, pushed up from below', BLUE, 11, 'middle')
    b += circ(450, 30, 4, GOLD) + text(460, 34, 'ground: within the tolerance of the cloth', GOLD, 12)
    b += circ(450, 50, 4, GREEN) + text(460, 54, 'above ground', GREEN, 12)
    b += text(350, 326, 'cloth simulation in a side view: the cloud seen from below, a cloth that touches open ground and bridges what stands on it', GREY, 11, 'middle')
    svg('ground-classification.svg', W, H, b)

FIGURES = [gsd, lens, baseline, ransac, fov, tri, pinhole, principal, sor, dod, smoothing, normal, contours, binning,
           volume, gauge, lowe, track, cog, mgraph, pose,
           kpmatch, fmatrix, homog, cheir, pnp, incsfm,
           bundle, selfcal, cycle, presel, mdensity, sensors,
           siftscale, siftdesc, sharp, imask, fiducial, depthmap,
           photocost, geocons, pmatch, mvs, sparsedense,
           georef, gcpmark, scalebar, crspolar, demcoreg, clouddist,
           orthopersp, orthoseams, seamlines, multiband, seamlevel, graphcut,
           poisson, decimate, atlas, viewsel, icp, tiles3d,
           terrain, gapfill, profile, lod, groundcls]
only = set(sys.argv[2:])
for f in FIGURES:
    if not only or f.__name__ in only: f()
print('ok')

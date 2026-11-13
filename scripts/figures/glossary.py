# Glossary figures (src/glossary/assets/*.svg), drawn from computed geometry in the style
# of epipolar-geometry.svg (dark ground, its palette): distortion from the Brown radial
# model, uncertainty ellipses from the rays' information matrices, RANSAC by scoring every
# point pair. Rewrites the six figures it knows:
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

for f in (gsd, lens, baseline, ransac, fov, tri): f()
print('ok')

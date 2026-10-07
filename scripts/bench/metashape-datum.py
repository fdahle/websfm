"""GeoScan PUTI: do the GCP survey and the RTK camera file share a datum?

Metashape's adjusted block (solved with both cameras and GCPs) is the independent
photogrammetric link between the two reference sets: its cameras are tied to one file,
its markers (re-triangulated from Metashape's own marks, calibration and pixel
convention) are compared with the other. Also compares a websfm bench run's
checkpoint residuals with that block, per GCP. Numbers: HANDOVER ▸ B-bench ▸ GeoScan datum.

usage (WSL, needs numpy):
  python3 scripts/bench/metashape-datum.py <Project.files dir> <Metadata dir> [bench-out/<run>.json [variant]]
"""
import json, re, sys, zipfile
import numpy as np

proj, meta = sys.argv[1], sys.argv[2]
bench = sys.argv[3] if len(sys.argv) > 3 else None
variant = sys.argv[4] if len(sys.argv) > 4 else 'priors+arm'
zdoc = lambda p: zipfile.ZipFile(p).read('doc.xml').decode('utf8')
chunk = zdoc(f'{proj}/0/chunk.zip')
frame = zdoc(f'{proj}/0/0/frame.zip')

def attrs(tag):
    return dict(re.findall(r'(\w+)="([^"]*)"', tag))

def nums(s):
    return np.array([float(v) for v in s.split()])

# ---- geodesy (WGS84) -------------------------------------------------------
A, F = 6378137.0, 1 / 298.257223563
E2 = F * (2 - F)

def geo2ecef(lat, lon, h):
    la, lo = np.radians(lat), np.radians(lon)
    n = A / np.sqrt(1 - E2 * np.sin(la) ** 2)
    return np.array([(n + h) * np.cos(la) * np.cos(lo), (n + h) * np.cos(la) * np.sin(lo),
                     (n * (1 - E2) + h) * np.sin(la)])

# ---- chunk: transform, sensor, cameras, markers ----------------------------
tr = re.search(r'<transform>\s*<rotation[^>]*>([^<]*)</rotation>\s*<translation[^>]*>([^<]*)</translation>\s*<scale[^>]*>([^<]*)</scale>', chunk)
CR, CT, CS = nums(tr.group(1)).reshape(3, 3), nums(tr.group(2)), float(tr.group(3))
to_ecef = lambda X: CS * CR @ X + CT

cal = re.search(r'<calibration type="frame" class="adjusted">([\s\S]*?)</calibration>', chunk).group(1)
K = {k: float(re.search(fr'<{k}>([^<]*)</{k}>', cal).group(1)) if re.search(fr'<{k}>', cal) else 0.0
     for k in ['f', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2', 'b1', 'b2']}
W, H = 6000, 4000
ant = attrs(re.search(r'<antenna>[\s\S]*?<reference ([^>]*)/>', chunk).group(1))
ANT = np.array([float(ant['x']), float(ant['y']), float(ant['z'])])

cams = {}
for m in re.finditer(r'<camera id="(\d+)"[^>]*label="([^"]*)">([\s\S]*?)</camera>', chunk):
    body = m.group(3)
    t = re.search(r'<transform>([^<]*)</transform>', body)
    if not t:
        continue
    T = nums(t.group(1)).reshape(4, 4)
    ref = re.search(r'<reference ([^>]*)/>', body)
    r = attrs(ref.group(1)) if ref else {}
    cams[m.group(1)] = dict(label=m.group(2).lower(), R=T[:3, :3], C=T[:3, 3],
                            ref=(float(r['y']), float(r['x']), float(r['z'])) if 'x' in r else None,
                            enabled=r.get('enabled') == 'true')

markers = {}
for m in re.finditer(r'<marker id="(\d+)" label="([^"]*)">\s*<reference ([^>]*)/>', chunk):
    r = attrs(m.group(3))
    markers[m.group(1)] = dict(label=m.group(2), ref=(float(r['y']), float(r['x']), float(r['z'])),
                               enabled=r['enabled'] == 'true', obs=[])
for m in re.finditer(r'<marker marker_id="(\d+)">([\s\S]*?)</marker>', frame):
    if m.group(1) not in markers:
        continue
    for l in re.finditer(r'<location ([^>]*)/>', m.group(2)):
        a = attrs(l.group(1))
        if a['camera_id'] in cams:
            markers[m.group(1)]['obs'].append((a['camera_id'], float(a['x']), float(a['y'])))

# ---- Metashape frame camera model: pixel -> camera ray ----------------------
def project_norm(x, y):
    r2 = x * x + y * y
    rad = 1 + K['k1'] * r2 + K['k2'] * r2 ** 2 + K['k3'] * r2 ** 3
    xd = x * rad + K['p1'] * (r2 + 2 * x * x) + 2 * K['p2'] * x * y
    yd = y * rad + K['p2'] * (r2 + 2 * y * y) + 2 * K['p1'] * x * y
    return W / 2 + K['cx'] + xd * K['f'] + xd * K['b1'] + yd * K['b2'], H / 2 + K['cy'] + yd * K['f']

def undistort(u, v):
    yd = (v - H / 2 - K['cy']) / K['f']
    xd = (u - W / 2 - K['cx'] - yd * K['b2']) / (K['f'] + K['b1'])
    x, y = xd, yd
    for _ in range(50):  # Newton on the forward model, numeric Jacobian
        pu, pv = project_norm(x, y)
        e = np.array([pu - u, pv - v])
        h = 1e-7
        J = np.array([[(project_norm(x + h, y)[0] - pu) / h, (project_norm(x, y + h)[0] - pu) / h],
                      [(project_norm(x + h, y)[1] - pv) / h, (project_norm(x, y + h)[1] - pv) / h]])
        d = np.linalg.solve(J, e)
        x, y = x - d[0], y - d[1]
        if abs(d).max() < 1e-12:
            break
    return x, y

def triangulate(obs):
    """Least-squares ray intersection (chunk frame), then Gauss-Newton on reprojection."""
    Aacc, bacc = np.zeros((3, 3)), np.zeros(3)
    for cid, u, v in obs:
        c = cams[cid]
        x, y = undistort(u, v)
        d = c['R'] @ np.array([x, y, 1.0]); d /= np.linalg.norm(d)
        P = np.eye(3) - np.outer(d, d)
        Aacc += P; bacc += P @ c['C']
    X = np.linalg.solve(Aacc, bacc)
    for _ in range(10):
        r, J = [], []
        for cid, u, v in obs:
            c = cams[cid]
            def proj(X):
                p = c['R'].T @ (X - c['C'])
                return np.array(project_norm(p[0] / p[2], p[1] / p[2]))
            p0 = proj(X)
            r.extend(p0 - [u, v])
            J.extend(np.array([(proj(X + e) - p0) / 1e-6 for e in np.eye(3) * 1e-6]).T)
        J, r = np.array(J), np.array(r)
        X = X - np.linalg.lstsq(J, r, rcond=None)[0]
    return X, np.sqrt(np.mean(r.reshape(-1, 2) ** 2) * 2)

# ---- local ENU frame -------------------------------------------------------
lat0, lon0 = 59.8420, 31.4720
O = geo2ecef(lat0, lon0, 100.0)
la, lo = np.radians(lat0), np.radians(lon0)
ENU = np.array([[-np.sin(lo), np.cos(lo), 0],
                [-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)],
                [np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)]])
enu = lambda X: ENU @ (X - O)
enu_geo = lambda g: enu(geo2ecef(*g))

def stats(name, D):
    D = np.asarray(D)
    print(f'  {name:<44} n={len(D):3d}  mean E/N/U {D.mean(0)[0]*100:+6.2f} {D.mean(0)[1]*100:+6.2f} {D.mean(0)[2]*100:+6.2f} cm'
          f'   sd {D.std(0)[0]*100:5.2f} {D.std(0)[1]*100:5.2f} {D.std(0)[2]*100:5.2f} cm')

# ---- provided files ----------------------------------------------------------
def table(path):
    rows = []
    for line in open(path, encoding='utf8'):
        if line.startswith('#') or not line.strip():
            continue
        rows.append([c.strip() for c in line.split('\t')])
    return rows

file_cams = {re.sub(r'\.[^.]+$', '', r[0]).lower(): (float(r[1]), float(r[2]), float(r[3])) for r in table(f'{meta}/Cameras_WGS84.txt')}
file_gcps = {r[0]: (float(r[1]), float(r[2]), float(r[3])) for r in table(f'{meta}/GCPs_WGS84.txt')}

print(f'chunk scale {CS:.4f}, f {K["f"]:.2f}, cx {K["cx"]:.2f} cy {K["cy"]:.2f}, antenna {ANT}')
print(f'{len(cams)} aligned cameras, {len(markers)} markers ({sum(m["enabled"] for m in markers.values())} control)')

# 1. Metashape reference vs provided files: the same datum shift for both sets?
print('\n1. Metashape project reference minus provided *_WGS84.txt')
stats('cameras', [enu_geo(c['ref']) - enu_geo(file_cams[c['label']]) for c in cams.values() if c['ref'] and c['label'] in file_cams])
stats('GCPs', [enu_geo(m['ref']) - enu_geo(file_gcps[m['label']]) for m in markers.values() if m['label'] in file_gcps])

# 2. Metashape's adjusted antenna positions; pick the antenna-axis convention that fits.
def antenna_ecef(c, s):
    return to_ecef(c['C'] + c['R'] @ (ANT * s) / CS)
print('\n2. Metashape adjusted antenna minus its own camera reference (convention test)')
for s, name in [((1, 1, 1), 'offset as given (x, y, z)'), ((1, -1, -1), 'flipped (x, -y, -z)')]:
    stats(name, [enu(antenna_ecef(c, np.array(s))) - enu_geo(c['ref']) for c in cams.values() if c['ref'] and c['enabled']])
SIGN = None
best = min([(1, 1, 1), (1, -1, -1)], key=lambda s: np.mean([np.sum((enu(antenna_ecef(c, np.array(s))) - enu_geo(c['ref'])) ** 2) for c in cams.values() if c['ref']]))
SIGN = np.array(best)
print(f'  -> using {best}')

# 3. Markers triangulated from Metashape's cameras, vs its own reference.
print('\n3. Markers triangulated in Metashape\'s block minus marker reference')
tri = {}
for mid, m in markers.items():
    if len(m['obs']) >= 2:
        X, rms = triangulate(m['obs'])
        tri[m['label']] = (to_ecef(X), rms, m['enabled'])
for lbl, (X, rms, en) in sorted(tri.items(), key=lambda kv: int(kv[0])):
    d = enu(X) - enu_geo([m for m in markers.values() if m['label'] == lbl][0]['ref'])
    print(f'    {lbl:>3} {"control" if en else "CHECK  "} {len([m for m in markers.values() if m["label"] == lbl][0]["obs"]):2d} marks '
          f'reproj {rms:4.2f}px  dE {d[0]*100:+6.2f} dN {d[1]*100:+6.2f} dU {d[2]*100:+6.2f} cm')
ref_of = {m['label']: m['ref'] for m in markers.values()}
stats('control markers', [enu(X) - enu_geo(ref_of[l]) for l, (X, _, en) in tri.items() if en and l != '19'])
stats('check markers', [enu(X) - enu_geo(ref_of[l]) for l, (X, _, en) in tri.items() if not en])
stats('all but 19', [enu(X) - enu_geo(ref_of[l]) for l, (X, _, en) in tri.items() if l != '19'])

# 4. The test in TODO ▸ ACC: tie Metashape's block to the RTK file alone (translation,
#    then 7-parameter), carry the markers along, compare with the GCP survey file.
def helmert(P, Q):
    """Q ≈ s R P + t (Horn/Umeyama)."""
    mp, mq = P.mean(0), Q.mean(0)
    U, S, Vt = np.linalg.svd((Q - mq).T @ (P - mp))
    D = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))])
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / np.sum((P - mp) ** 2)
    return s, R, mq - s * R @ mp

print('\n4. Block tied to the RTK file only; markers carried along, minus the GCP file')
pairs = [(enu(antenna_ecef(c, SIGN)), enu_geo(file_cams[c['label']])) for c in cams.values() if c['label'] in file_cams]
P, Q = np.array([p for p, _ in pairs]), np.array([q for _, q in pairs])
mk = [(l, enu(X)) for l, (X, _, _) in tri.items() if l in file_gcps and l != '19']
G = np.array([enu_geo(file_gcps[l]) for l, _ in mk]); M = np.array([x for _, x in mk])

t = (Q - P).mean(0)
stats('cameras after translation (fit residual)', P + t - Q)
stats('GCPs after translation', M + t - G)
s, R, tt = helmert(P, Q)
print(f'  7-param: scale {(s-1)*1e6:+.1f} ppm, rotation {np.degrees(np.arccos(np.clip((np.trace(R)-1)/2, -1, 1)))*3600:.2f}"')
stats('cameras after 7-param (fit residual)', (s * (R @ P.T)).T + tt - Q)
stats('GCPs after 7-param', (s * (R @ M.T)).T + tt - G)

# 5. Same, tied to the GCP file only; cameras carried along, minus the RTK file.
print('\n5. Block tied to the GCP file only; cameras carried along, minus the RTK file')
s2, R2, t2 = helmert(M, G)
print(f'  7-param: scale {(s2-1)*1e6:+.1f} ppm')
stats('GCPs after 7-param (fit residual)', (s2 * (R2 @ M.T)).T + t2 - G)
stats('cameras after 7-param', (s2 * (R2 @ P.T)).T + t2 - Q)

# 6. Per GCP: is each one converted like the cameras? (Metashape ref - file) - camera shift
print('\n6. Per GCP: (Metashape ref - file) minus the cameras\' mean shift')
cam_shift = np.mean([enu_geo(c['ref']) - enu_geo(file_cams[c['label']]) for c in cams.values() if c['ref'] and c['label'] in file_cams], axis=0)
dev = {}
for m in sorted(markers.values(), key=lambda m: int(m['label'])):
    if m['label'] in file_gcps:
        d = enu_geo(m['ref']) - enu_geo(file_gcps[m['label']]) - cam_shift
        dev[m['label']] = d
        print(f'    {m["label"]:>3} dE {d[0]*100:+8.2f} dN {d[1]*100:+8.2f} dU {d[2]*100:+8.2f} cm')
stats('GCPs except 19', [d for l, d in dev.items() if l != '19'])

# 7. GCP 19 as the other GCPs were converted (project ref -> file), in degrees/metres
d = np.mean([np.subtract(file_gcps[m['label']], m['ref']) for m in markers.values() if m['label'] in file_gcps and m['label'] != '19'], axis=0)
sd = np.std([np.subtract(file_gcps[m['label']], m['ref']) for m in markers.values() if m['label'] in file_gcps and m['label'] != '19'], axis=0)
r19 = [m['ref'] for m in markers.values() if m['label'] == '19'][0]
fixed = np.add(r19, d)
print(f'\n7. GCP 19: file {file_gcps["19"]}\n    project ref {r19}\n    converted   {fixed[0]:.8f} {fixed[1]:.8f} {fixed[2]:.3f}  (conversion sd {sd[0]*1e9:.1f}e-9 deg, {sd[1]*1e9:.1f}e-9 deg, {sd[2]*1000:.1f} mm)')
X19 = tri['19'][0]
print('    Metashape RTK-tied block minus converted 19 (cm):', np.round(((s * (R @ enu(X19))) + tt - enu_geo(fixed)) * 100, 1))

# 8. websfm (a bench run's checkpoint rows, at the mark offset it scored them with) vs Metashape's RTK-tied block, per checkpoint
if not bench:
    sys.exit(0)
ws = {}
for row in json.load(open(bench, encoding='utf8'))['stages'][f'recon[{variant}]']['checkpointCheck']['rows']:
    m = re.match(r'^(\d+)[^:]*: dE (\S+) dN (\S+) dU (\S+)', row)
    if m:
        ws[m.group(1)] = [float(m.group(i)) for i in (2, 3, 4)]
ms = {l: (s * (R @ x)) + tt - enu_geo(file_gcps[l]) for l, x in mk}
print('\n8. Checkpoint residuals, websfm vs Metashape block tied to RTK only (cm)')
L = [l for l in sorted(ms, key=int) if l in ws]
for l in L:
    w, m_ = np.array(ws[l]) * 100, ms[l] * 100
    print(f'    {l:>3}  websfm {w[0]:+6.1f} {w[1]:+6.1f} {w[2]:+6.1f}   metashape {m_[0]:+6.1f} {m_[1]:+6.1f} {m_[2]:+6.1f}   diff {w[0]-m_[0]:+6.1f} {w[1]-m_[1]:+6.1f} {w[2]-m_[2]:+6.1f}')
Wm, Mm = np.array([ws[l] for l in L]), np.array([ms[l] for l in L])
stats('websfm', Wm); stats('metashape (RTK-tied)', Mm); stats('websfm - metashape', Wm - Mm)
for i, ax in enumerate('ENU'):
    print(f'  corr {ax}: {np.corrcoef(Wm[:, i], Mm[:, i])[0, 1]:+.2f}')
rms = lambda D: (np.sqrt(np.mean(D[:, 0] ** 2 + D[:, 1] ** 2)) * 100, np.sqrt(np.mean(D[:, 2] ** 2)) * 100)
print('  RMS H / V cm: websfm %.1f / %.1f   metashape %.1f / %.1f' % (*rms(Wm), *rms(Mm)))
print('  minus each mean: websfm %.1f / %.1f   metashape %.1f / %.1f' % (*rms(Wm - Wm.mean(0)), *rms(Mm - Mm.mean(0))))

# 9. What does the shared vertical pattern follow?
print('\n9. Vertical residual vs GCP position (least squares, cm)')
Gp = np.array([enu_geo(file_gcps[l]) for l in L])
cc = Gp.mean(0)
rel = Gp - cc
cams_enu = Q
print(f'  GCP heights {Gp[:,2].min():.1f}..{Gp[:,2].max():.1f} m, block centre of cameras E {cams_enu[:,0].mean()-cc[0]:+.0f} N {cams_enu[:,1].mean()-cc[1]:+.0f} m from GCP centroid')
for name, D in [('websfm', Wm), ('metashape', Mm), ('websfm - metashape', Wm - Mm)]:
    u = D[:, 2] * 100
    for lab, X in [('height', rel[:, 2:3]), ('plane E,N', rel[:, :2]), ('plane + r^2 (dome)', np.c_[rel[:, :2], (rel[:, 0]**2 + rel[:, 1]**2) / 1e6]),
                   ('height + plane', np.c_[rel[:, :3]])]:
        Xd = np.c_[np.ones(len(u)), X]
        coef, *_ = np.linalg.lstsq(Xd, u, rcond=None)
        res = u - Xd @ coef
        print(f'  {name:<20} ~ {lab:<20} rms {np.sqrt(np.mean((u-u.mean())**2)):4.1f} -> {np.sqrt(np.mean(res**2)):4.1f}   coef ' + ' '.join(f'{c:+.3f}' for c in coef[1:]))
k = np.polyfit(Mm[:, 2], Wm[:, 2], 1)
print(f'  websfm U = {k[0]:.2f} * metashape U {k[1]*100:+.1f} cm')
for l, g, w, m_ in zip(L, Gp, Wm, Mm):
    print(f'    {l:>3} h {g[2]:6.2f} m  E {g[0]-cc[0]:+6.0f} N {g[1]-cc[1]:+6.0f}  dU websfm {w[2]*100:+6.1f} metashape {m_[2]*100:+6.1f}')

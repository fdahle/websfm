// Reseau crosses (SAT-5) — pure detection math, no Vue / OPFS / DOM.
//
// A reseau camera (the KH-9 mapping camera: a 1 cm grid on a glass plate in front of
// the film) exposes a lattice of small black crosses on every frame. Measured against
// their nominal positions they give the scan placement AND the film's own deformation
// (fiducialCalibration.js 'reseau' model). This module finds one cross in a window and
// plans the lattice; workers/ops/detect.js reads the windows and drives the search.

// The nominal lattice: crosses every `spacingMm` over the film, centred on the frame
// centre (the principal point is a separate calibration value). Node ids `r:i:j` are
// the slots the detections and the calibration marks share.
export function reseauLattice({ spacingMm, filmWidthMm, filmHeightMm }) {
  if (!(spacingMm > 0) || !(filmWidthMm > 0) || !(filmHeightMm > 0)) return []
  const ni = Math.floor(filmWidthMm / 2 / spacingMm + 1e-9),
    nj = Math.floor(filmHeightMm / 2 / spacingMm + 1e-9)
  const nodes = []
  for (let j = -nj; j <= nj; j++)
    for (let i = -ni; i <= ni; i++) {
      nodes.push({ id: `r:${i}:${j}`, i, j, xMm: i * spacingMm, yMm: j * spacingMm })
    }
  return nodes
}

// A node's predicted scan position with the scan placed centred and unrotated: film
// mm (y up) → scan px (rows down), the pixel-edge convention.
export function nominalScanPosition(node, { width, height, pitchMm }) {
  return { px: width / 2 + node.xMm / pitchMm, py: height / 2 - node.yMm / pitchMm }
}

// The most cross-like point of a grayscale window: two perpendicular dark lines of
// half-length `armPx` and width `widthPx` crossing there. Each arm's contrast is the
// mean of (the two parallel bands `gap` px either side) − (the line band) along the arm;
// the score is the weaker arm, so a single dark line (a road, a field edge) scores low.
// Searched over the centres at least `armPx + gap` from the window's edges; the peak is
// refined to sub-pixel by a parabola in x and y.
// gray: { data: Float32Array, width, height } → { x, y, score } (window px, pixel-edge
// coordinates: the centre of pixel (c, r) is (c + 0.5, r + 0.5)) or null.
export function crossInWindow(gray, { armPx, widthPx = 1 }) {
  const { data, width: W, height: H } = gray
  const L = Math.max(2, Math.round(armPx)),
    w = Math.max(1, Math.round(widthPx))
  const gap = w + 1 + Math.ceil(w / 2)
  const m = L + gap + w
  if (W < 2 * m + 1 || H < 2 * m + 1) return null
  // Band means: vertical box of height w (for horizontal lines), horizontal box of width w.
  const vb = new Float32Array(W * H),
    hb = new Float32Array(W * H)
  const h0 = Math.floor((w - 1) / 2),
    h1 = w - 1 - h0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sv = 0,
        sh = 0,
        nv = 0,
        nh = 0
      for (let k = -h0; k <= h1; k++) {
        const yy = y + k,
          xx = x + k
        if (yy >= 0 && yy < H) {
          sv += data[yy * W + x]
          nv++
        }
        if (xx >= 0 && xx < W) {
          sh += data[y * W + xx]
          nh++
        }
      }
      vb[y * W + x] = sv / nv
      hb[y * W + x] = sh / nh
    }
  // Line contrast per pixel: horizontal (bands above/below) and vertical (left/right).
  const ch = new Float32Array(W * H),
    cv = new Float32Array(W * H)
  for (let y = gap; y < H - gap; y++)
    for (let x = gap; x < W - gap; x++) {
      const i = y * W + x
      ch[i] = 0.5 * (vb[i - gap * W] + vb[i + gap * W]) - vb[i]
      cv[i] = 0.5 * (hb[i - gap] + hb[i + gap]) - hb[i]
    }
  // Arm sums by prefix sums: horizontal arm along rows of ch, vertical along columns of cv.
  const rowPre = new Float64Array((W + 1) * H),
    colPre = new Float64Array(W * (H + 1))
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) rowPre[y * (W + 1) + x + 1] = rowPre[y * (W + 1) + x] + ch[y * W + x]
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) colPre[(y + 1) * W + x] = colPre[y * W + x] + cv[y * W + x]
  const score = new Float32Array(W * H).fill(-Infinity)
  let best = -Infinity,
    bx = -1,
    by = -1
  for (let y = m; y < H - m; y++)
    for (let x = m; x < W - m; x++) {
      const a = (rowPre[y * (W + 1) + x + L + 1] - rowPre[y * (W + 1) + x - L]) / (2 * L + 1)
      const b = (colPre[(y + L + 1) * W + x] - colPre[(y - L) * W + x]) / (2 * L + 1)
      const s = Math.min(a, b)
      score[y * W + x] = s
      if (s > best) {
        best = s
        bx = x
        by = y
      }
    }
  if (bx < 0 || !(best > 0)) return null
  const peak = (sm, s0, sp) => {
    const d = sm - 2 * s0 + sp
    return Number.isFinite(d) && d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (sm - sp)) / d)) : 0
  }
  const dx = peak(score[by * W + bx - 1], best, score[by * W + bx + 1])
  const dy = peak(score[(by - 1) * W + bx], best, score[(by + 1) * W + bx])
  return { x: bx + 0.5 + dx, y: by + 0.5 + dy, score: best }
}

// Least-squares affine scan px ≈ A·(xMm, yMm, 1) from found crosses — the placement
// that predicts the rest of the lattice. null with fewer than 3 or a degenerate set.
export function fitLatticeAffine(found) {
  if (found.length < 3) return null
  const N = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    bx = [0, 0, 0],
    byv = [0, 0, 0]
  for (const f of found) {
    const r = [f.xMm, f.yMm, 1]
    for (let a = 0; a < 3; a++) {
      bx[a] += r[a] * f.px
      byv[a] += r[a] * f.py
      for (let b = 0; b < 3; b++) N[a][b] += r[a] * r[b]
    }
  }
  const solve = (rhs) => {
    const M = N.map((row, i) => [...row, rhs[i]])
    for (let c = 0; c < 3; c++) {
      let p = c
      for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
      if (!(Math.abs(M[p][c]) > 1e-9)) return null
      ;[M[c], M[p]] = [M[p], M[c]]
      for (let r = 0; r < 3; r++)
        if (r !== c) {
          const k = M[r][c] / M[c][c]
          for (let j = c; j < 4; j++) M[r][j] -= k * M[c][j]
        }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]
  }
  const ax = solve(bx),
    ay = solve(byv)
  return ax && ay
    ? {
        ax,
        ay,
        predict: (xMm, yMm) => ({ px: ax[0] * xMm + ax[1] * yMm + ax[2], py: ay[0] * xMm + ay[1] * yMm + ay[2] }),
      }
    : null
}

// ── Half-frame scans ─────────────────────────────────────────────────────
// Some archives scan a frame in two overlapping parts (KH-9: `<frame>_a` the left of
// the film, `<frame>_b` the right). A half has no frame centre to place the lattice
// from: its crosses are found by growing from one (workers/ops/detect.js, mode
// 'grow'), each with grid steps (di right, dj down) relative to the first, and the
// steps become lattice indices here. Rows: a half shows the full film height, so its
// rows are centred. Columns: from the half's outer edge, the outermost column being
// the film's (−ni on the left half, +ni on the right); `shift` moves them by whole
// columns (the overlap check tries ±1, in case an edge column was missed).
// found: [{ di, dj, px, py, score }] → [{ slot, i, j, px, py, score }] plus counts.
export function assignReseauIndices(found, { side, ni, nj, shift = 0 }) {
  if (!found.length) return { detections: [], columns: 0, rows: 0, rowsExpected: 2 * nj + 1 }
  let dimin = Infinity,
    dimax = -Infinity,
    djmin = Infinity,
    djmax = -Infinity
  for (const f of found) {
    dimin = Math.min(dimin, f.di)
    dimax = Math.max(dimax, f.di)
    djmin = Math.min(djmin, f.dj)
    djmax = Math.max(djmax, f.dj)
  }
  const rows = djmax - djmin + 1,
    columns = dimax - dimin + 1
  const djc = Math.round((djmin + djmax) / 2)
  const colOf =
    side === 'left'
      ? (di) => -ni + (di - dimin) + shift
      : side === 'right'
        ? (di) => ni - (dimax - di) + shift
        : (di) => di - Math.round((dimin + dimax) / 2) + shift
  const detections = []
  for (const f of found) {
    const i = colOf(f.di),
      j = djc - f.dj // image rows run down, film y up
    if (Math.abs(i) > ni || Math.abs(j) > nj) continue
    detections.push({ slot: `r:${i}:${j}`, i, j, px: f.px, py: f.py, score: f.score })
  }
  return { detections, columns, rows, rowsExpected: 2 * nj + 1 }
}

// The half-frame pairs among `images` ({ id, name }): `<stem>_a` with `<stem>_b`
// (also -a / -b, any case, before the extension). → [{ stem, a, b }] (images).
export function pairReseauHalves(images) {
  const bySide = new Map()
  for (const img of images) {
    const m = /^(.*)[_-]([ab])(\.[^.]+)?$/i.exec(img.name)
    if (!m) continue
    const stem = m[1],
      side = m[2].toLowerCase()
    if (!bySide.has(stem)) bySide.set(stem, {})
    bySide.get(stem)[side] = img
  }
  return [...bySide]
    .filter(([, p]) => p.a && p.b)
    .map(([stem, p]) => ({ stem, a: p.a, b: p.b }))
    .sort((x, y) => x.stem.localeCompare(y.stem))
}

// The stitched frame's grid: the film's lattice extent plus `marginMm`, at `pitchMm`,
// centred on the film's (0, 0). Pixel (c, r) covers film x ∈ [x0 + c·p, x0 + (c+1)·p),
// y ∈ (y0 − (r+1)·p, y0 − r·p]. The principal point (certificate, mm) in the sensor
// table's pixel-centre convention: cx = W/2 + ppx/p − ½, cy = H/2 − ppy/p − ½.
export function stitchedFrameGeometry({
  spacingMm,
  filmWidthMm,
  filmHeightMm,
  pitchMm,
  marginMm = 2,
  ppxMm = 0,
  ppyMm = 0,
}) {
  const ni = Math.floor(filmWidthMm / 2 / spacingMm + 1e-9),
    nj = Math.floor(filmHeightMm / 2 / spacingMm + 1e-9)
  const halfW = Math.max(ni * spacingMm, filmWidthMm / 2) + marginMm,
    halfH = Math.max(nj * spacingMm, filmHeightMm / 2) + marginMm
  const width = 2 * Math.ceil(halfW / pitchMm),
    height = 2 * Math.ceil(halfH / pitchMm)
  return {
    width,
    height,
    pitchMm,
    x0Mm: (-width / 2) * pitchMm,
    y0Mm: (height / 2) * pitchMm,
    ni,
    nj,
    cx: width / 2 + ppxMm / pitchMm - 0.5,
    cy: height / 2 - ppyMm / pitchMm - 0.5,
  }
}

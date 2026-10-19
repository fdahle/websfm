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
  const ni = Math.floor(filmWidthMm / 2 / spacingMm + 1e-9), nj = Math.floor(filmHeightMm / 2 / spacingMm + 1e-9)
  const nodes = []
  for (let j = -nj; j <= nj; j++) for (let i = -ni; i <= ni; i++) {
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
  const L = Math.max(2, Math.round(armPx)), w = Math.max(1, Math.round(widthPx))
  const gap = w + 1 + Math.ceil(w / 2)
  const m = L + gap + w
  if (W < 2 * m + 1 || H < 2 * m + 1) return null
  // Band means: vertical box of height w (for horizontal lines), horizontal box of width w.
  const vb = new Float32Array(W * H), hb = new Float32Array(W * H)
  const h0 = Math.floor((w - 1) / 2), h1 = w - 1 - h0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sv = 0, sh = 0, nv = 0, nh = 0
    for (let k = -h0; k <= h1; k++) {
      const yy = y + k, xx = x + k
      if (yy >= 0 && yy < H) { sv += data[yy * W + x]; nv++ }
      if (xx >= 0 && xx < W) { sh += data[y * W + xx]; nh++ }
    }
    vb[y * W + x] = sv / nv; hb[y * W + x] = sh / nh
  }
  // Line contrast per pixel: horizontal (bands above/below) and vertical (left/right).
  const ch = new Float32Array(W * H), cv = new Float32Array(W * H)
  for (let y = gap; y < H - gap; y++) for (let x = gap; x < W - gap; x++) {
    const i = y * W + x
    ch[i] = 0.5 * (vb[i - gap * W] + vb[i + gap * W]) - vb[i]
    cv[i] = 0.5 * (hb[i - gap] + hb[i + gap]) - hb[i]
  }
  // Arm sums by prefix sums: horizontal arm along rows of ch, vertical along columns of cv.
  const rowPre = new Float64Array((W + 1) * H), colPre = new Float64Array(W * (H + 1))
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rowPre[y * (W + 1) + x + 1] = rowPre[y * (W + 1) + x] + ch[y * W + x]
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) colPre[(y + 1) * W + x] = colPre[y * W + x] + cv[y * W + x]
  const score = new Float32Array(W * H).fill(-Infinity)
  let best = -Infinity, bx = -1, by = -1
  for (let y = m; y < H - m; y++) for (let x = m; x < W - m; x++) {
    const a = (rowPre[y * (W + 1) + x + L + 1] - rowPre[y * (W + 1) + x - L]) / (2 * L + 1)
    const b = (colPre[(y + L + 1) * W + x] - colPre[(y - L) * W + x]) / (2 * L + 1)
    const s = Math.min(a, b)
    score[y * W + x] = s
    if (s > best) { best = s; bx = x; by = y }
  }
  if (bx < 0 || !(best > 0)) return null
  const peak = (sm, s0, sp) => {
    const d = sm - 2 * s0 + sp
    return Number.isFinite(d) && d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (sm - sp) / d)) : 0
  }
  const dx = peak(score[by * W + bx - 1], best, score[by * W + bx + 1])
  const dy = peak(score[(by - 1) * W + bx], best, score[(by + 1) * W + bx])
  return { x: bx + 0.5 + dx, y: by + 0.5 + dy, score: best }
}

// Least-squares affine scan px ≈ A·(xMm, yMm, 1) from found crosses — the placement
// that predicts the rest of the lattice. null with fewer than 3 or a degenerate set.
export function fitLatticeAffine(found) {
  if (found.length < 3) return null
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], byv = [0, 0, 0]
  for (const f of found) {
    const r = [f.xMm, f.yMm, 1]
    for (let a = 0; a < 3; a++) { bx[a] += r[a] * f.px; byv[a] += r[a] * f.py; for (let b = 0; b < 3; b++) N[a][b] += r[a] * r[b] }
  }
  const solve = (rhs) => {
    const M = N.map((row, i) => [...row, rhs[i]])
    for (let c = 0; c < 3; c++) {
      let p = c
      for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
      if (!(Math.abs(M[p][c]) > 1e-9)) return null
      ;[M[c], M[p]] = [M[p], M[c]]
      for (let r = 0; r < 3; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j < 4; j++) M[r][j] -= k * M[c][j] }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]
  }
  const ax = solve(bx), ay = solve(byv)
  return ax && ay ? { ax, ay, predict: (xMm, yMm) => ({ px: ax[0] * xMm + ax[1] * yMm + ax[2], py: ay[0] * xMm + ay[1] * yMm + ay[2] }) } : null
}

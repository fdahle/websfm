// Compose a multi-pass self-calibration into a single radial distortion bag (WS2).
//
// The sparse pipeline folds self-calibrated distortion out of the keypoints once per
// BA pass (undistort in place — exact). But dense MVS and the run summary need ONE
// distortion bag per sensor to reproduce that fold on the rasters, and simply summing
// each pass's k1 (the old approximation) is wrong beyond first order and ignores k2/k3.
//
// Instead we fit a single {k1,k2,k3} that reproduces the *net* transform from the
// pristine (as-observed, post-ingest) keypoints to their fully-folded positions. The
// forward radial distortion — distorted = ideal·(1 + k1·r² + k2·r⁴ + k3·r⁶), r the
// ideal/folded radius — is LINEAR in the coefficients, so this is one small
// normal-equation solve over the real keypoint pairs (which already span the frame).
//
// Pure: no Vue/OPFS/worker. `K` = { fx, fy, cx, cy }.

// Solve a small symmetric system A·x = b (m ≤ 3) by Gaussian elimination with partial
// pivoting. Returns null if singular.
function solveSmall(A, b) {
  const m = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < m; col++) {
    let piv = col
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-20) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < m; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= m; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row[m] / row[i])
}

// Fit the composed radial bag mapping `pristineKps` (distorted observations) to
// `foldedKps` (their self-cal-folded ideal positions) about K. `active` picks which
// coeffs to fit — k1 is always on; k2/k3 join only when their bit was refined (a
// column absent from the fit stays exactly 0). Returns { k1, k2, k3, fitRmsPx, n }.
export function fitComposedRadial(pristineKps, foldedKps, K, active = {}) {
  const { fx, fy, cx, cy } = K
  const cols = ['k1']
  if (active.k2) cols.push('k2')
  if (active.k3) cols.push('k3')
  const m = cols.length
  // Power of r² for each column: k1→1, k2→2, k3→3.
  const pow = cols.map((c) => (c === 'k1' ? 1 : c === 'k2' ? 2 : 3))

  const AtA = Array.from({ length: m }, () => new Array(m).fill(0))
  const Atb = new Array(m).fill(0)
  const n = Math.min(pristineKps.length, foldedKps.length)
  let used = 0
  for (let i = 0; i < n; i++) {
    const p = pristineKps[i], f = foldedKps[i]
    if (!p || !f) continue
    const fxn = (f.x - cx) / fx, fyn = (f.y - cy) / fy       // ideal (folded) normalised
    const pxn = (p.x - cx) / fx, pyn = (p.y - cy) / fy       // distorted (pristine) normalised
    const r2 = fxn * fxn + fyn * fyn
    // Basis value for each column at this point (per axis: coord · r²^pow).
    const basisX = pow.map((k) => fxn * r2 ** k)
    const basisY = pow.map((k) => fyn * r2 ** k)
    const tx = pxn - fxn, ty = pyn - fyn                     // forward-distortion displacement
    for (let a = 0; a < m; a++) {
      Atb[a] += basisX[a] * tx + basisY[a] * ty
      for (let b = 0; b < m; b++) AtA[a][b] += basisX[a] * basisX[b] + basisY[a] * basisY[b]
    }
    used++
  }
  if (used < m) return { k1: 0, k2: 0, k3: 0, fitRmsPx: 0, n: used }
  const sol = solveSmall(AtA, Atb) || new Array(m).fill(0)
  const bag = { k1: 0, k2: 0, k3: 0 }
  cols.forEach((c, i) => { bag[c] = sol[i] })

  // Fit RMS in pixels: predicted pristine vs actual over the same points.
  let sse = 0, cnt = 0
  for (let i = 0; i < n; i++) {
    const p = pristineKps[i], f = foldedKps[i]
    if (!p || !f) continue
    const fxn = (f.x - cx) / fx, fyn = (f.y - cy) / fy
    const r2 = fxn * fxn + fyn * fyn
    const d = 1 + bag.k1 * r2 + bag.k2 * r2 * r2 + bag.k3 * r2 * r2 * r2
    const predX = (fxn * d) * fx + cx, predY = (fyn * d) * fy + cy
    sse += (predX - p.x) ** 2 + (predY - p.y) ** 2; cnt++
  }
  const fitRmsPx = cnt ? Math.sqrt(sse / cnt) : 0
  return { ...bag, fitRmsPx, n: used }
}

// Guard against a runaway higher-order fit. Sample the radial map r → r·(1 + k1·r² +
// k2·r⁴ + k3·r⁶) out to `maxNormR` (the image-corner normalised radius) and require it
// to stay monotonically increasing (a fold that reverses would mirror pixels) and the
// corner displacement to stay under `maxShiftPx` (~a lens, not a fisheye). `fxApprox`
// converts the normalised corner displacement to pixels. Returns { ok, reason }.
export function radialCurveOk(bag, maxNormR, fxApprox, maxShiftPx = 50) {
  const { k1 = 0, k2 = 0, k3 = 0 } = bag || {}
  const steps = 40
  let prevMapped = -Infinity
  for (let i = 0; i <= steps; i++) {
    const r = (maxNormR * i) / steps
    const r2 = r * r
    const d = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
    const mapped = r * d
    if (mapped < prevMapped) {
      return { ok: false, reason: `radial map non-monotonic at r=${r.toFixed(3)} (fold would mirror pixels)` }
    }
    prevMapped = mapped
  }
  const cornerShift = Math.abs(maxNormR * (k1 * maxNormR ** 2 + k2 * maxNormR ** 4 + k3 * maxNormR ** 6)) * fxApprox
  if (cornerShift > maxShiftPx) {
    return { ok: false, reason: `corner shift ${cornerShift.toFixed(0)}px exceeds ${maxShiftPx}px (runaway distortion)` }
  }
  return { ok: true, reason: '' }
}

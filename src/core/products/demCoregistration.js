// Co-registration of a DEM to a reference DEM (Tools ▸ Products ▸ Co-register DEM…):
// the chain xDEM runs (xDEM contributors), each step optional, on cells of stable
// ground. Pure.
//
//   1. horizontal shift: Nuth & Kääb (2011), core/eval/demCoregister.js;
//   2. vertical shift: the median height difference after it (xDEM VerticalShift);
//   3. tilt: a polynomial of order 1 (a plane) or 2 fitted to what is left, by least
//      squares over the cells within 3 NMAD, twice (xDEM Deramp). It has a constant
//      term, so a tilt also takes up an offset the vertical shift left.
//
// The result applies to the DEM itself (coregisterDemGrid: its origin moves, its
// heights lose the vertical shift and tilt) or to the georeference the DEM was built
// in (coregisteredSimilarity: the fitted similarity composed with the correction, so
// every product built after it lands on the reference).
//
// Sign: Δh = DEM − reference. `shift` = [east, north] is where the DEM sits against the
// reference (demCoregister.js): the DEM's feature at p + shift is the reference's at p.
// The correction moves the DEM by −shift, then subtracts dz(p) = vertical + tilt(p),
// both evaluated where the cell lands.

import { coregisterNuthKaab } from '../eval/demCoregister.js'
import { COREG_TUNING } from '../tuning.js'
import { median, nmad } from '../stats.js'

function spreadOf(v) {
  const m = median(v)
  return { median: m, nmad: nmad(v, m), n: v.length }
}

// The DEM's cells to co-register on: a regular sub-grid of about `maxPoints` cells
// with a height, inside `include(x, y)` (stable ground) when given. Each cell's own
// height, no interpolation. Stable ground is often a few per cent of the DEM (Melville:
// rock outcrops, 5 %), so a sub-grid that finds too few cells is made finer, from how
// many it found. → { points: [{ x, y, z }], cell (the DEM's cell: the slope's
// finite-difference step on the reference) }
export function sampleDemPoints(dem, { include = null, maxPoints = COREG_TUNING.maxPoints } = {}) {
  const { width: w, height: h, gsd, originX, originY, data, mask } = dem
  const collect = (step) => {
    const points = []
    let tested = 0
    for (let r = step >> 1; r < h; r += step) {
      const y = originY - (r + 0.5) * gsd
      for (let c = step >> 1; c < w; c += step) {
        const i = r * w + c
        if (mask && !mask[i]) continue
        const z = data[i]
        if (!Number.isFinite(z)) continue
        tested++
        const x = originX + (c + 0.5) * gsd
        if (include && !include(x, y)) continue
        points.push({ x, y, z })
      }
    }
    return { points, tested }
  }
  let step = Math.max(1, Math.ceil(Math.sqrt((w * h) / maxPoints)))
  let got = collect(step)
  if (got.points.length < maxPoints / 2 && step > 1) {
    // The share the first pass kept, of the cells with a height: the step that gives
    // maxPoints of them.
    const share = Math.max(got.points.length, 1) / Math.max(got.tested, 1)
    const finer = Math.max(1, Math.floor(step * Math.sqrt((got.points.length || 1) / maxPoints)))
    const byShare = Math.max(1, Math.floor(Math.sqrt((w * h * share) / maxPoints)))
    step = Math.min(step - 1, Math.max(finer, byShare))
    got = collect(step)
  }
  return { points: got.points, cell: gsd }
}

// The polynomial terms of order 1 or 2 at (u, w), the centred and scaled position.
const terms = (order, u, w) => (order === 1 ? [1, u, w] : [1, u, w, u * u, u * w, w * w])

// Least squares of y over the terms, on the points `use` keeps. → coefficients or null.
function fitPoly(order, pts, ys, use) {
  const k = order === 1 ? 3 : 6
  const A = Array.from({ length: k }, () => new Float64Array(k)),
    b = new Float64Array(k)
  for (let i = 0; i < pts.length; i++) {
    if (!use[i]) continue
    const t = terms(order, pts[i][0], pts[i][1])
    for (let a = 0; a < k; a++) {
      b[a] += t[a] * ys[i]
      for (let c = 0; c < k; c++) A[a][c] += t[a] * t[c]
    }
  }
  return solve(A, b)
}

// Gaussian elimination with partial pivoting; null when singular.
function solve(A0, b0) {
  const n = b0.length
  const A = A0.map((r) => Float64Array.from(r)),
    b = Float64Array.from(b0)
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    if (!(Math.abs(A[p][c]) > 1e-12)) return null
    ;[A[c], A[p]] = [A[p], A[c]]
    ;[b[c], b[p]] = [b[p], b[c]]
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c]
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]
      b[r] -= f * b[c]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]
    x[r] = s / A[r][r]
  }
  return x
}

// The height correction of a result at (x, y), where a corrected cell lands:
// vertical shift + tilt. In the DEM's units.
export function correctionAt(coreg, x, y) {
  let dz = coreg.vertical ?? 0
  const t = coreg.tilt
  if (t) {
    const ts = terms(t.order, (x - t.center[0]) / t.scale, (y - t.center[1]) / t.scale)
    for (let i = 0; i < ts.length; i++) dz += t.coeffs[i] * ts[i]
  }
  return dz
}

/**
 * Co-register DEM points to a reference.
 *   points: [{ x, y, z }] (sampleDemPoints), sampleRef(x, y) → reference height | null,
 *   cell: the points' spacing.
 *   steps: { horizontal (bool), vertical (bool), tilt: 'off' | 'plane' | 'quadratic' }
 * → { shift: [east, north], vertical, tilt: { order, center, scale, coeffs } | null,
 *     before, after: { median, nmad, n } of Δh on the points, horizontal: { n,
 *     iterations, converged } | null }, or { error } when the points cannot carry it:
 *     'overlap' (fewer than COREG_TUNING.minPoints with a reference height), 'slopes'
 *     (the horizontal step found too few slopes of every aspect).
 */
export function coregisterDem(points, sampleRef, { cell, horizontal = true, vertical = true, tilt = 'off' } = {}) {
  const tune = COREG_TUNING
  const dhAt = (p, s) => {
    const r = sampleRef(p.x - s[0], p.y - s[1])
    return Number.isFinite(r) ? p.z - r : NaN
  }
  const before = points.map((p) => dhAt(p, [0, 0])).filter(Number.isFinite)
  if (before.length < tune.minPoints) return { error: 'overlap' }

  let shift = [0, 0],
    nk = null
  if (horizontal) {
    const r = coregisterNuthKaab(points, sampleRef, {
      cell,
      minSlopeDeg: tune.minSlopeDeg,
      maxSlopeDeg: tune.maxSlopeDeg,
      maxIterations: tune.maxIterations,
      tolerance: tune.tolerance,
    })
    if (!r) return { error: 'slopes' }
    shift = r.shift
    nk = { n: r.n, iterations: r.iterations, converged: r.converged }
  }

  // Δh after the shift, at the position each corrected cell lands on.
  const pts = [],
    dh = []
  for (const p of points) {
    const d = dhAt(p, shift)
    if (!Number.isFinite(d)) continue
    pts.push([p.x - shift[0], p.y - shift[1]])
    dh.push(d)
  }
  if (dh.length < tune.minPoints) return { error: 'overlap' }
  const v = vertical ? median(dh) : 0
  let ramp = null
  if (tilt === 'plane' || tilt === 'quadratic') {
    const order = tilt === 'plane' ? 1 : 2
    // Centred and scaled to ±1 over the points, for a well-conditioned fit.
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
    const center = [(x0 + x1) / 2, (y0 + y1) / 2]
    const scale = Math.max(x1 - x0, y1 - y0, cell) / 2
    const uv = pts.map(([x, y]) => [(x - center[0]) / scale, (y - center[1]) / scale])
    const ys = dh.map((d) => d - v)
    // Least squares on the cells within 3 NMAD of the median, then again on those
    // within 3 NMAD of the first fit: blunders and change left in the stable mask
    // would tilt a plain fit.
    let use = (() => {
      const { median: m, nmad } = spreadOf(ys)
      return ys.map((y) => Math.abs(y - m) <= tune.trimNmad * nmad)
    })()
    let coeffs = null
    for (let pass = 0; pass < 2; pass++) {
      coeffs = fitPoly(order, uv, ys, use)
      if (!coeffs) break
      const res = ys.map((y, i) => y - terms(order, uv[i][0], uv[i][1]).reduce((s, t, k) => s + t * coeffs[k], 0))
      const { median: m, nmad } = spreadOf(res)
      use = res.map((r) => Math.abs(r - m) <= tune.trimNmad * nmad)
    }
    if (coeffs) ramp = { order, center, scale, coeffs }
  }
  const result = { shift, vertical: v, tilt: ramp }
  const after = dh.map((d, i) => d - correctionAt(result, pts[i][0], pts[i][1]))
  return { ...result, before: spreadOf(before), after: spreadOf(after), horizontal: nk }
}

// The DEM with a co-registration applied: its origin moves by −shift, each cell loses
// the correction where it lands. Mask and support stay (the same grid).
// → { originX, originY, data, zMin, zMax }
export function coregisterDemGrid(dem, coreg) {
  const { width: w, height: h, gsd, data } = dem
  const originX = dem.originX - coreg.shift[0],
    originY = dem.originY - coreg.shift[1]
  const out = new Float32Array(data.length)
  let zMin = Infinity,
    zMax = -Infinity
  for (let r = 0; r < h; r++) {
    const y = originY - (r + 0.5) * gsd
    for (let c = 0; c < w; c++) {
      const i = r * w + c
      const z = data[i]
      if (!Number.isFinite(z)) {
        out[i] = z
        continue
      }
      const v = z - correctionAt(coreg, originX + (c + 0.5) * gsd, y)
      out[i] = v
      if (v < zMin) zMin = v
      if (v > zMax) zMax = v
    }
  }
  return { originX, originY, data: out, zMin, zMax }
}

// Anchors for moving a georeference: up to `max` of the DEM points, spread over them
// (every k-th), as [x, y, z] in the DEM's CRS.
export function coregistrationAnchors(points, max = COREG_TUNING.anchors) {
  const every = Math.max(1, Math.ceil(points.length / max))
  const out = []
  for (let i = 0; i < points.length; i += every) out.push([points[i].x, points[i].y, points[i].z])
  return out
}

// Where the correction takes a point of the DEM's CRS: moved by −shift, lowered by the
// correction where it lands.
function corrected(coreg, [x, y, z]) {
  const tx = x - coreg.shift[0],
    ty = y - coreg.shift[1]
  return [tx, ty, z - correctionAt(coreg, tx, ty)]
}

// A georeference's co-registration as point pairs in its CRS: `from`, where the fit puts
// each anchor, and `to`, where it belongs. Kept with the project, so every refit is moved
// again without the DEM. → { from, to }
export function coregistrationPairs(anchors, coreg) {
  return { from: anchors.map((p) => [...p]), to: anchors.map((p) => corrected(coreg, p)) }
}

// A further co-registration, measured on a DEM built in the already moved georeference:
// the targets move on. → { from, to }
export function chainCoregistration(pairs, coreg) {
  return { from: pairs.from, to: pairs.to.map((p) => corrected(coreg, p)) }
}

// The mean move of the pairs, [east, north, up]: what the log and the dialog quote.
export function coregistrationMove({ from, to }) {
  const m = [0, 0, 0]
  for (let i = 0; i < from.length; i++) for (let k = 0; k < 3; k++) m[k] += (to[i][k] - from[i][k]) / from.length
  return m
}

// The georeference moved onto the reference: the similarity that best takes each
// anchor's model point to its target. A plane is a shear, not a rotation, so it fits
// only to within `rms` (millimetres over a few km for a tilt of a few metres); a
// quadratic surface cannot move a similarity at all (the caller refuses it).
//   pairs: coregistrationPairs; toSfm(p) → the model point a grid point comes from
//   (frameFromSimilarity of the fit); fit(pairs) → the new similarity (fitGeoreference
//   with the fit's local frame).
// → { sim, rms } or null.
export function coregisteredSimilarity({ from, to }, { toSfm, fit }) {
  const sim = fit(from.map((p, i) => ({ src: toSfm(p), dst: to[i], weight: 1 })))
  if (!sim) return null
  return { sim, rms: sim.rms ?? null }
}

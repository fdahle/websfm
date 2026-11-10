import { NMAD_K } from '../constants.js'

// F13 — reference-DEM-constrained bundle adjustment (TODO ▸ F13, issue #8): sparse points
// over stable ground pulled toward a reference DEM, as a weak "the ground is about here"
// prior, so a block without ground control cannot bend. Pure: points, the georeference
// frame and a reference sampler in, anchors out.
//
// An anchor is bundle_adjust's own (bundle.rs `anchor_flat`/`anchor_weight`): a target
// and a 3×3 precision on one of the model's points. Here the precision has rank one,
// along the vertical: the point is held to the DEM's height and nowhere else, so its
// horizontal place stays the photos' business. The target is where the point is now,
// moved vertically onto the DEM, so a solve is run a few times with its anchors rebuilt
// in between (a point that moves sideways meets the DEM elsewhere).
//
// The weight is the reference's vertical uncertainty, `sigma` (project units, metres in
// a metric CRS); a point whose height is far from the DEM's (moved ice, a building the
// DEM does not have, a blunder) is left out: beyond `outlierK` × the NMAD of the
// differences around their median, and never closer than 3 σ.
//
//   points   SparsePoints (pos, vcount) in the model (SfM) frame
//   frame    { fromSfm(p) → project [x, y, z], toSfm([x, y, z]) → model } (georef.js
//            frameFromSimilarity)
//   sample   (x, y) → reference height in the project CRS, or NaN off it
//   include  (x, y) → whether the place is stable ground (null: everywhere)
// → { anchors: [{ ptIdx, target: [x, y, z] (model), precision: 3×3 (model) }],
//     stats: { candidates, used, rejected, median, nmad, scatter (about the smooth
//     surface), sigma (the one used: at least `sigma`, and `scatter` with floorAtScatter) } }
//     (lengths in project units)
export function demAnchors({
  points,
  frame,
  sample,
  include = null,
  sigma = 2,
  minViews = 3,
  maxAnchors = 4000,
  outlierK = 4,
  // Hold the shape only: each target sits at the reference's height plus the median
  // difference, an unknown datum shift between the reference and the control taken out.
  relative = false,
  // Hold no firmer than the reference agrees with the photos: σ is at least the scatter
  // of the height differences about a smooth (quadratic) surface through them, so a DEM
  // that disagrees by metres (cliffs at its cell size, trees, changed ground) is not held
  // at a declared ±2 m. The smooth part is left out of the measure because it is the bend
  // the hold is there to remove.
  floorAtScatter = true,
}) {
  const empty = {
    anchors: [],
    stats: { candidates: 0, used: 0, rejected: 0, median: NaN, nmad: NaN, scatter: NaN, sigma },
  }
  if (!points?.pos || !(sigma > 0)) return empty
  const { pos, vcount } = points
  const n = vcount.length
  const cand = []
  for (let i = 0; i < n; i++) {
    if (vcount[i] < minViews) continue
    const p = frame.fromSfm([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]])
    if (!p.every(Number.isFinite)) continue
    if (include && !include(p[0], p[1])) continue
    const zr = sample(p[0], p[1])
    if (!Number.isFinite(zr)) continue
    cand.push({ i, p, zr, dz: p[2] - zr })
  }
  if (!cand.length) return empty
  const dzs = cand.map((c) => c.dz).sort((a, b) => a - b)
  const median = dzs[dzs.length >> 1]
  const dev = dzs.map((d) => Math.abs(d - median)).sort((a, b) => a - b)
  const nmad = NMAD_K * dev[dev.length >> 1]
  const reach = Math.max(outlierK * nmad, 3 * sigma)
  const kept = cand.filter((c) => Math.abs(c.dz - median) <= reach)
  const scatter = localScatter(kept, median)
  const sigmaUsed = floorAtScatter && scatter > sigma ? scatter : sigma
  const picked = spreadEvenly(kept, maxAnchors)
  const anchors = picked.map(({ i, p, zr }) => {
    const zt = relative ? zr + median : zr
    const target = frame.toSfm([p[0], p[1], zt])
    // The vertical in the model frame, and how many model units a project unit is there.
    const up = frame.toSfm([p[0], p[1], zt + 1]).map((v, k) => v - target[k])
    const len = Math.hypot(up[0], up[1], up[2])
    const u = up.map((v) => v / len)
    const w = 1 / (sigmaUsed * len) ** 2
    const precision = [0, 1, 2].map((a) => [0, 1, 2].map((b) => w * u[a] * u[b]))
    return { ptIdx: i, target, precision }
  })
  return {
    anchors,
    stats: {
      candidates: cand.length,
      used: anchors.length,
      rejected: cand.length - kept.length,
      median,
      nmad,
      scatter,
      sigma: sigmaUsed,
    },
  }
}

// The NMAD of the height differences about the least-squares quadratic surface through
// them (x, y centred and scaled), or about their median when too few or degenerate.
function localScatter(items, median) {
  const nmadOf = (r) => {
    const a = r.map(Math.abs).sort((x, y) => x - y)
    return a.length ? NMAD_K * a[a.length >> 1] : NaN
  }
  if (items.length < 12) return nmadOf(items.map((c) => c.dz - median))
  let cx = 0,
    cy = 0
  for (const c of items) {
    cx += c.p[0]
    cy += c.p[1]
  }
  cx /= items.length
  cy /= items.length
  let sc = 0
  for (const c of items) sc = Math.max(sc, Math.abs(c.p[0] - cx), Math.abs(c.p[1] - cy))
  if (!(sc > 0)) return nmadOf(items.map((c) => c.dz - median))
  const basis = (c) => {
    const x = (c.p[0] - cx) / sc,
      y = (c.p[1] - cy) / sc
    return [1, x, y, x * x, x * y, y * y]
  }
  const N = Array.from({ length: 6 }, () => new Float64Array(7))
  for (const c of items) {
    const b = basis(c)
    for (let r = 0; r < 6; r++) {
      for (let k = 0; k < 6; k++) N[r][k] += b[r] * b[k]
      N[r][6] += b[r] * c.dz
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 6; col++) {
    let piv = col
    for (let r = col + 1; r < 6; r++) if (Math.abs(N[r][col]) > Math.abs(N[piv][col])) piv = r
    if (!(Math.abs(N[piv][col]) > 1e-12 * items.length)) return nmadOf(items.map((c) => c.dz - median))
    ;[N[col], N[piv]] = [N[piv], N[col]]
    for (let r = 0; r < 6; r++) {
      if (r === col) continue
      const f = N[r][col] / N[col][col]
      for (let k = col; k < 7; k++) N[r][k] -= f * N[col][k]
    }
  }
  const coef = N.map((row, r) => row[6] / row[r])
  return nmadOf(items.map((c) => c.dz - basis(c).reduce((a, v, k) => a + v * coef[k], 0)))
}

// At most `max` of `items` (each with a project place `p`), spread over their extent: one
// per cell of a grid with about `max` cells, the first in each.
function spreadEvenly(items, max) {
  if (items.length <= max) return items
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const { p } of items) {
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  const cell = Math.sqrt(Math.max(1e-12, (x1 - x0) * (y1 - y0)) / max) || 1
  const seen = new Set()
  const out = []
  for (const it of items) {
    const key = `${Math.floor((it.p[0] - x0) / cell)},${Math.floor((it.p[1] - y0) / cell)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
    if (out.length >= max) break
  }
  return out
}

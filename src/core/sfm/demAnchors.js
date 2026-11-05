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
//     stats: { candidates, used, rejected, median, nmad } } (median, nmad: project units)
export function demAnchors({
  points,
  frame,
  sample,
  include = null,
  sigma = 2,
  minViews = 3,
  maxAnchors = 4000,
  outlierK = 4,
}) {
  const empty = { anchors: [], stats: { candidates: 0, used: 0, rejected: 0, median: NaN, nmad: NaN } }
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
  const picked = spreadEvenly(kept, maxAnchors)
  const anchors = picked.map(({ i, p, zr }) => {
    const target = frame.toSfm([p[0], p[1], zr])
    // The vertical in the model frame, and how many model units a project unit is there.
    const up = frame.toSfm([p[0], p[1], zr + 1]).map((v, k) => v - target[k])
    const len = Math.hypot(up[0], up[1], up[2])
    const u = up.map((v) => v / len)
    const w = 1 / (sigma * len) ** 2
    const precision = [0, 1, 2].map((a) => [0, 1, 2].map((b) => w * u[a] * u[b]))
    return { ptIdx: i, target, precision }
  })
  return {
    anchors,
    stats: { candidates: cand.length, used: anchors.length, rejected: cand.length - kept.length, median, nmad },
  }
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

// Find GCPs by terrain (Coarse matcher ▸ Terrain): the sparse cloud aligned to a
// reference DEM by ICP, for when the photos and any reference image share too little
// to match (snow, cloud, a reference with only elevation). Pure.
//
// A start is needed: ICP converged on Rachel Glacier from ~400 m and 1° off, not from
// 1.9 km and 3°. The prior similarity of the image look (referenceLook.js
// fitSimilarity2d: orthophoto px → reference px, from footprints, GPS or a
// georeference) gives it, the height offset coming from the DEM itself.

import { spreadCandidates } from './referenceGcps.js'

/**
 * The prior as a 3D similarity from the orthophoto's frame (x, y, z in its own
 * units) to the reference DEM's CRS: { scale, R, t } with p' = scale·R·p + t (the
 * cloudAlign.js convention), the height offset left at 0 for the DEM to set.
 * `prior` maps orthophoto native px to DEM native px; `ortho` { originX, originY,
 * gsd }; `geo` the DEM's geoTransform { originX, originY, scaleX, scaleY } (north up).
 */
export function terrainInitial(prior, ortho, geo) {
  // ortho px: u = (x − ox)/g, v = (oy − y)/g; DEM px (c, r) = prior(u, v);
  // X = gx + c·sx, Y = gy + r·sy (sy < 0). Linear in (x, y), so:
  const { a, b, tx, ty } = prior
  const g = ortho.gsd,
    sx = geo.scaleX,
    sy = geo.scaleY
  // ∂X/∂x, ∂X/∂y, ∂Y/∂x, ∂Y/∂y
  const m = [(sx * a) / g, (sx * b) / g, (sy * b) / g, (-sy * a) / g]
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
  const R = [
    [m[0] / scale, m[1] / scale, 0],
    [m[2] / scale, m[3] / scale, 0],
    [0, 0, 1],
  ]
  // The image of the frame origin (x = y = 0).
  const u0 = -ortho.originX / g,
    v0 = ortho.originY / g
  const c0 = a * u0 - b * v0 + tx,
    r0 = b * u0 + a * v0 + ty
  return { scale, R, t: [geo.originX + c0 * sx, geo.originY + r0 * sy, 0] }
}

/** Median of the finite values, or NaN. */
export function median(values) {
  const v = values.filter(Number.isFinite).sort((p, q) => p - q)
  return v.length ? v[v.length >> 1] : NaN
}

/**
 * Candidate controls after the terrain fit: sparse tracks seen in at least two photos
 * whose transformed position lies on the DEM within 3× the fit's RMS, accepted by
 * `accept(x, y)` (stable ground, reference CRS) when given, spread over the block as
 * the image path does. `items`: [{ pointIndex, local:[u,v] orthophoto px, x, y
 * (reference CRS), reference:[col,row] DEM px, residual (m, vertical, signed),
 * observations }]; `rms` the fit's RMS (m); `pixel` the DEM pixel size (m).
 */
export function terrainCandidates(items, { rms, pixel, accept = null, width, height, limit = 30 }) {
  const gate = 3 * Math.max(rms, pixel)
  const pool = []
  for (const it of items) {
    if (it.observations.length < 2 || !Number.isFinite(it.residual) || Math.abs(it.residual) > gate) continue
    if (accept && !accept(it.x, it.y)) continue
    const z = it.residual / Math.max(rms, 1e-9)
    pool.push({
      ...it,
      z: null,
      tile: 0,
      offsetPx: 0,
      // σ of the position: the fit's RMS, in DEM pixels.
      residual: Math.abs(it.residual),
      residualRefPx: rms / pixel,
      confidence: Math.exp(-0.5 * z * z) * (it.observations.length >= 3 ? 1 : 0.8),
    })
  }
  return spreadCandidates(pool, width, height, { limit, minSeparation: Math.min(width, height) / 40 })
}

// The ICP passes: correspondence radius (m) and method. Point-to-point first, which
// pulls in from hundreds of metres; point-to-plane, which settles along slopes, last.
export function terrainPasses(priorMisfit = 0) {
  return [
    { maxDistance: Math.max(600, 3 * priorMisfit), pointToPlane: false },
    { maxDistance: 300, pointToPlane: false },
    { maxDistance: 150, pointToPlane: true },
    { maxDistance: 60, pointToPlane: true },
  ]
}

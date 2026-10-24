// The learned coarse look of Find GCPs (workers/ops/referenceGcps.js): which scales
// and rotations to try, and the rotated raster each one matches. Pure.
//
// A film orthophoto and a modern satellite image share their large shapes (ridges,
// rock outlines, coasts) but little texture: on Rachel Glacier SIFT found 11 true
// matches in 105, a learned detector with LightGlue 98–145 RANSAC inliers at 0.5–0.8
// reference px. Learned detectors are neither scale- nor rotation-invariant, though.
// DISK held from ×0.8 to ×1.25 of the true scale and SuperPoint to ×1.56, and both
// within about ±15° of the true rotation. So every look reads both rasters at the
// same metres per pixel and turns the orthophoto to the hypothesis' rotation first.

const D2R = Math.PI / 180

/**
 * Least-squares 2D similarity q = s·R(θ)·p + t from point pairs, refit once without
 * the pairs more than 3× the median residual (and 2 px) off. `pairs`: [{ p:[x,y],
 * q:[x,y] }]. → { a, b, tx, ty, scale, rotationDeg, rms, used } with q = [a·x − b·y +
 * tx, b·x + a·y + ty], or null with fewer than 3 usable pairs, or when the fit says
 * nothing: targets that do not spread (scanned photos whose GPS fields all hold one
 * point fitted a scale of 1e-28 on Rachel) or a misfit over a third of their spread.
 */
export function fitSimilarity2d(pairs) {
  const fit = (list) => {
    const n = list.length
    if (n < 2) return null
    let px = 0,
      py = 0,
      qx = 0,
      qy = 0
    for (const { p, q } of list) {
      px += p[0] / n
      py += p[1] / n
      qx += q[0] / n
      qy += q[1] / n
    }
    let sr = 0,
      si = 0,
      ss = 0
    for (const { p, q } of list) {
      const ax = p[0] - px,
        ay = p[1] - py,
        bx = q[0] - qx,
        by = q[1] - qy
      sr += ax * bx + ay * by
      si += ax * by - ay * bx
      ss += ax * ax + ay * ay
    }
    if (!(ss > 0)) return null
    const a = sr / ss,
      b = si / ss
    return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) }
  }
  const resid = (m, { p, q }) =>
    Math.hypot(m.a * p[0] - m.b * p[1] + m.tx - q[0], m.b * p[0] + m.a * p[1] + m.ty - q[1])
  const usable = pairs.filter(({ p, q }) => [...p, ...q].every(Number.isFinite))
  if (usable.length < 3) return null
  let m = fit(usable)
  if (!m) return null
  const r = usable.map((pq) => resid(m, pq)).sort((x, y) => x - y)
  const cut = Math.max(2, 3 * r[r.length >> 1])
  const kept = usable.filter((pq) => resid(m, pq) <= cut)
  if (kept.length >= 3 && kept.length < usable.length) m = fit(kept) ?? m
  const used = kept.length >= 3 ? kept : usable
  const rms = Math.sqrt(used.reduce((s, pq) => s + resid(m, pq) ** 2, 0) / used.length)
  const spread = (k) => {
    const cx = used.reduce((s, pq) => s + pq[k][0], 0) / used.length,
      cy = used.reduce((s, pq) => s + pq[k][1], 0) / used.length
    return Math.sqrt(used.reduce((s, pq) => s + (pq[k][0] - cx) ** 2 + (pq[k][1] - cy) ** 2, 0) / used.length)
  }
  const qSpread = spread('q')
  if (!(qSpread >= 3) || !(spread('p') >= 3) || rms > qSpread / 3) return null
  return {
    ...m,
    scale: Math.hypot(m.a, m.b),
    rotationDeg: (((Math.atan2(m.b, m.a) / D2R) % 360) + 360) % 360,
    rms,
    used: used.length,
  }
}

/** The 3×3 (flat, row-major) homography of a similarity { a, b, tx, ty }. */
export const similarityHomography = ({ a, b, tx, ty }) => [a, -b, tx, b, a, ty, 0, 0, 1]

/** The rotation (degrees, 0–360) a homography applies around (x, y). */
export function homographyRotation(H, x, y) {
  const w = (u, v) => {
    const d = H[6] * u + H[7] * v + H[8]
    return [(H[0] * u + H[1] * v + H[2]) / d, (H[3] * u + H[4] * v + H[5]) / d]
  }
  const p = w(x, y),
    q = w(x + 1, y)
  return (((Math.atan2(q[1] - p[1], q[0] - p[0]) / D2R) % 360) + 360) % 360
}

// The rotation and scale steps of the sweep: 30° covers the ±15° a learned
// detector tolerates; √2 in scale stays inside DISK's ×0.8–1.25 at the midpoints.
export const ROTATION_STEP_DEG = 30
export const SCALE_STEPS = [1, Math.SQRT2, Math.SQRT1_2, 2, 0.5]

/**
 * Coarse look hypotheses, best first: { scale (reference px per orthophoto px),
 * rotationDeg, stage }. With a `prior` (fitSimilarity2d from camera positions or
 * footprints), its own rotation and scale, ±15° beside it, then the full rotation
 * sweep at its scale. Without one, `guessScale` (the search area and the orthophoto
 * read at the same size, as hist-sfm does) through SCALE_STEPS, each swept through
 * every rotation.
 */
export function coarseHypotheses({ prior = null, guessScale = 1 }) {
  const out = []
  const sweep = (scale, from, stage) => {
    for (let k = 0; k < 360 / ROTATION_STEP_DEG; k++)
      out.push({ scale, rotationDeg: (from + k * ROTATION_STEP_DEG) % 360, stage })
  }
  if (prior) {
    const r = prior.rotationDeg
    for (const d of [0, 15, -15]) out.push({ scale: prior.scale, rotationDeg: (r + d + 360) % 360, stage: 'prior' })
    sweep(prior.scale, r + ROTATION_STEP_DEG, 'sweep')
    return out
  }
  for (const k of SCALE_STEPS) sweep(guessScale * k, 0, 'sweep')
  return out
}

/** The ±10° refinements around a sweep's best rotation (hist-sfm's local pass). */
export const refineRotations = (deg) => [-10, 10].map((d) => (deg + d + 360) % 360)

/**
 * Turn a gray raster by `deg` (clockwise on screen: image y points down) about its
 * centre into a canvas that holds all of it; bilinear, a sample valid only when its
 * four sources are. `toSource(x, y)` maps a rotated sample back to the original.
 * → { data: Float32Array, valid: Uint8Array, width, height, toSource }
 */
export function rotateGray({ data, valid, width, height }, deg) {
  const c = Math.cos(deg * D2R),
    s = Math.sin(deg * D2R)
  const W = Math.max(1, Math.ceil(Math.abs(width * c) + Math.abs(height * s) - 1e-9)),
    H = Math.max(1, Math.ceil(Math.abs(width * s) + Math.abs(height * c) - 1e-9))
  const cx = width / 2,
    cy = height / 2,
    CX = W / 2,
    CY = H / 2
  const toSource = (x, y) => {
    const dx = x - CX,
      dy = y - CY
    return [c * dx + s * dy + cx, -s * dx + c * dy + cy]
  }
  const out = new Float32Array(W * H),
    ok = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [u, v] = toSource(x + 0.5, y + 0.5)
      const x0 = Math.floor(u - 0.5),
        y0 = Math.floor(v - 0.5)
      if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) continue
      const i = y0 * width + x0
      if (!valid[i] || !valid[i + 1] || !valid[i + width] || !valid[i + width + 1]) continue
      const fx = u - 0.5 - x0,
        fy = v - 0.5 - y0
      out[y * W + x] =
        (1 - fy) * ((1 - fx) * data[i] + fx * data[i + 1]) +
        fy * ((1 - fx) * data[i + width] + fx * data[i + width + 1])
      ok[y * W + x] = 1
    }
  return {
    data: out,
    valid: ok,
    width: W,
    height: H,
    toSource: (x, y) => toSource(x + 0.5, y + 0.5).map((t) => t - 0.5),
  }
}

/**
 * The ground both rasters of a look are read at. The reference rect is read at up to
 * `maxDim` samples; the orthophoto at the same metres per sample, given `scale`
 * reference px per orthophoto px. When that would take the orthophoto past `maxDim`
 * or past its native resolution, both are read coarser by the same factor. → { refMaxDim, localMaxDim } (samples on
 * the longer side of each read).
 */
export function lookSizes({ rect, scale, localWidth, localHeight, maxDim = 2048 }) {
  const refLong = Math.max(rect.width, rect.height),
    localLong = Math.max(localWidth, localHeight)
  let refPer = Math.max(1, refLong / maxDim) // reference native px per sample
  let localMax = (localLong * scale) / refPer
  // Neither read can go finer than its raster's native pixels.
  const cap = Math.min(maxDim, localLong)
  if (localMax > cap) {
    refPer *= localMax / cap
    localMax = cap
  }
  return {
    refMaxDim: Math.max(16, Math.min(maxDim, Math.round(refLong / refPer))),
    localMaxDim: Math.max(16, Math.round(localMax)),
  }
}

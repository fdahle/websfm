// The reconstruction REGION (Tools ▸ Model ▾ ▸ Region): an axis-aligned box in the
// sparse model's frame that bounds the dense stages. Pure, no Vue/Pinia/OPFS/DOM.
//
// What it does, per consumer:
//   - depth maps: only sparse points inside it seed each image's depth range, so
//     PatchMatch does not search the far background;
//   - fusion: a fused point outside it is never accumulated;
//   - mesh / DEM: their input points are clipped to it.
// It never moves or deletes anything already computed — it shapes what the next
// run produces.
//
// A region is model-frame data, so it is a CACHE of the model it was drawn on and
// carries that model's stamp `{ id, createdAt }` exactly like the scale fit: a new
// reconstruction (same id, new createdAt) makes it stale, and a stale region is
// IGNORED, never silently applied to a different frame.
//
// Shape: { min: [x,y,z], max: [x,y,z], sourceStamp: { id, createdAt } }

/** A usable box ({ min, max } finite, min < max on every axis), or null. */
export function normalizeRegion(r) {
  if (!r || !Array.isArray(r.min) || !Array.isArray(r.max)) return null
  const min = r.min.map(Number),
    max = r.max.map(Number)
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a]) || !(max[a] > min[a])) return null
  }
  return { min, max, ...(r.sourceStamp ? { sourceStamp: { ...r.sourceStamp } } : {}) }
}

/**
 * Is `region` usable against `model` (the main sparse cloud)?
 * @returns {{ active: boolean, reason: 'none'|'invalid'|'no-model'|'stale'|null }}
 */
export function regionStatus(region, model) {
  if (!region) return { active: false, reason: 'none' }
  if (!normalizeRegion(region)) return { active: false, reason: 'invalid' }
  if (!model) return { active: false, reason: 'no-model' }
  const s = region.sourceStamp
  if (!s || s.id !== model.id || s.createdAt !== (model.createdAt ?? null)) return { active: false, reason: 'stale' }
  return { active: true, reason: null }
}

export function regionContains(r, x, y, z) {
  return x >= r.min[0] && x <= r.max[0] && y >= r.min[1] && y <= r.max[1] && z >= r.min[2] && z <= r.max[2]
}

/**
 * Keep-mask of a flat position buffer against the region.
 * @returns {{ keep: Uint8Array, kept: number }}
 */
export function regionMask(pos, count, r) {
  const keep = new Uint8Array(count)
  let kept = 0
  for (let i = 0; i < count; i++) {
    if (regionContains(r, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])) {
      keep[i] = 1
      kept++
    }
  }
  return { keep, kept }
}

/**
 * A robust box around a set of positions: the per-axis [q, 1−q] quantiles, each side
 * then carried on over the points beyond it as long as they follow on without a gap
 * wider than `gap` × the quantile extent, and grown by `margin` × the extent. A handful
 * of stray sparse points (each behind a gap) does not set the region, the way a plain
 * min/max would; a tower or a tree line above the 98th percentile of heights (points
 * all the way up) is not cut.
 * `positions` is a flat [x,y,z,…] array or typed array.
 */
export function regionFromPositions(
  positions,
  { quantile = 0.02, margin = 0.05, gap = 0.02, maxSamples = 200_000 } = {},
) {
  const n = Math.floor(positions.length / 3)
  if (n < 2) return null
  const stride = Math.max(1, Math.floor(n / maxSamples))
  const m = Math.ceil(n / stride)
  const axes = [new Float64Array(m), new Float64Array(m), new Float64Array(m)]
  let k = 0
  for (let i = 0; i < n && k < m; i += stride, k++) {
    axes[0][k] = positions[i * 3]
    axes[1][k] = positions[i * 3 + 1]
    axes[2][k] = positions[i * 3 + 2]
  }
  const min = [],
    max = []
  for (const a of axes) {
    const v = a.subarray(0, k).sort()
    let i0 = Math.min(k - 1, Math.max(0, Math.round(quantile * (k - 1)))),
      i1 = Math.min(k - 1, Math.max(0, Math.round((1 - quantile) * (k - 1))))
    const step = Math.max((v[i1] - v[i0]) * gap, 1e-12)
    while (i1 + 1 < k && v[i1 + 1] - v[i1] <= step) i1++
    while (i0 > 0 && v[i0] - v[i0 - 1] <= step) i0--
    const lo = v[i0],
      hi = v[i1]
    const grow = Math.max((hi - lo) * margin, 1e-9)
    min.push(lo - grow)
    max.push(hi + grow)
  }
  return { min, max }
}

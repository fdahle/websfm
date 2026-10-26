// A resident cloud split into slabs for the worker pool: each worker gets the points
// of one slab plus a margin (`halo`) around it, runs a neighbourhood operation (the
// outlier filter's neighbour means, normals) on slab + margin, and keeps the results of
// its own slab's points. Every point belongs to exactly one slab. Pure.
//
// The slabs run along the longer horizontal side of the cloud's box and are cut at
// quantiles of the points' position along it, so each holds about as many points
// (a corridor or a cloud with a dense core still splits evenly).

/**
 * @param {ArrayLike<number>} pos  xyz per point
 * @param {number} n  point count
 * @param {{ slabs: number, halo: number }} opts  halo in the cloud's units
 * @returns {{ axis: number, parts: { idx: Uint32Array, own: number }[] }}  per slab the
 *   indices of its own points first (`own` of them), then the margin's
 */
export function planCloudSlabs(pos, n, { slabs, halo }) {
  const lo = [Infinity, Infinity],
    hi = [-Infinity, -Infinity]
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 2; k++) {
      const v = pos[3 * i + k]
      if (v < lo[k]) lo[k] = v
      if (v > hi[k]) hi[k] = v
    }
  const axis = hi[0] - lo[0] >= hi[1] - lo[1] ? 0 : 1
  const m = Math.max(1, Math.min(Math.floor(slabs) || 1, n))
  // Cuts at quantiles of a sample along the axis.
  const step = Math.max(1, Math.floor(n / 200_000))
  const sample = []
  for (let i = 0; i < n; i += step) sample.push(pos[3 * i + axis])
  sample.sort((a, b) => a - b)
  const cuts = []
  for (let s = 1; s < m; s++) cuts.push(sample[Math.floor((s * sample.length) / m)])
  // Slab of a coordinate: the number of cuts at or below it.
  const slabOf = (v) => {
    let a = 0,
      b = cuts.length
    while (a < b) {
      const c = (a + b) >> 1
      if (cuts[c] <= v) a = c + 1
      else b = c
    }
    return a
  }
  const own = new Uint32Array(m),
    extra = new Uint32Array(m)
  const of = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const v = pos[3 * i + axis]
    const s = slabOf(v)
    of[i] = s
    own[s]++
    // The neighbouring slabs whose margin reaches this point.
    for (let t = s - 1; t >= 0 && v - cuts[t] <= halo; t--) extra[t]++
    for (let t = s + 1; t < m && cuts[t - 1] - v <= halo; t++) extra[t]++
  }
  const parts = Array.from({ length: m }, (_, s) => ({ idx: new Uint32Array(own[s] + extra[s]), own: own[s] }))
  const fillOwn = new Uint32Array(m),
    fillExtra = Uint32Array.from(own)
  for (let i = 0; i < n; i++) {
    const s = of[i],
      v = pos[3 * i + axis]
    parts[s].idx[fillOwn[s]++] = i
    for (let t = s - 1; t >= 0 && v - cuts[t] <= halo; t--) parts[t].idx[fillExtra[t]++] = i
    for (let t = s + 1; t < m && cuts[t - 1] - v <= halo; t++) parts[t].idx[fillExtra[t]++] = i
  }
  return { axis, parts }
}

// The points `idx` of a cloud as a cloud of their own (positions, and normals when
// `withNormals`): what one worker gets. Positions keep the source's array type.
export function gatherPoints(cloud, idx, { withNormals = false } = {}) {
  const P = cloud.pos.constructor
  const pos = new P(idx.length * 3)
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j] * 3
    pos[j * 3] = cloud.pos[i]
    pos[j * 3 + 1] = cloud.pos[i + 1]
    pos[j * 3 + 2] = cloud.pos[i + 2]
  }
  let nrm = null
  if (withNormals && cloud.nrm) {
    nrm = new Float32Array(idx.length * 3)
    for (let j = 0; j < idx.length; j++) {
      const i = idx[j] * 3
      nrm[j * 3] = cloud.nrm[i]
      nrm[j * 3 + 1] = cloud.nrm[i + 1]
      nrm[j * 3 + 2] = cloud.nrm[i + 2]
    }
  }
  return { count: idx.length, pos, nrm }
}

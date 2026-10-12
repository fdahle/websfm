// The sparse model as dense Stage A reads it: packed typed arrays, transferred to
// the worker — never one { x, y, z, views: [[uuid, kp], …] } object per point
// (TODO ▸ SC-4; 2–3 GB on EACH side of the postMessage at 5 M points).
//
//   { n, pos: Float64Array(3n), vstart: Uint32Array(n + 1), vcam: Uint32Array(Σviews),
//     viewUuids: string[] }
//
// `pos` seeds the depth range (seedDepthFromSparse); point i is seen by the images
// viewUuids[vcam[k]] for k in [vstart[i], vstart[i+1]) — what source-view selection
// scores. Positions are what Stage A projects, so they stay Float64.

/** Pack sparse points ({ x, y, z, views } with views a Map / PackedViewSlice / [[uuid, kp]]). */
export function packSparseForDense(points) {
  const n = points?.length ?? 0
  const pos = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) { const p = points[i]; pos[3 * i] = p.x; pos[3 * i + 1] = p.y; pos[3 * i + 2] = p.z }
  const tracks = points?.packedTracks
  if (tracks && tracks.vcount?.length === n) {
    // A restored / freshly computed cloud already holds its tracks as CSR.
    const vstart = new Uint32Array(n + 1)
    for (let i = 0; i < n; i++) vstart[i + 1] = vstart[i] + tracks.vcount[i]
    return { n, pos, vstart, vcam: tracks.vcam.slice(0, vstart[n]), viewUuids: [...tracks.viewUuids] }
  }
  const index = new Map(), viewUuids = []
  const vstart = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) vstart[i + 1] = vstart[i] + (points[i].views?.size ?? points[i].views?.length ?? 0)
  const vcam = new Uint32Array(vstart[n])
  for (let i = 0, k = 0; i < n; i++) {
    for (const [uuid] of points[i].views ?? []) {
      let c = index.get(uuid)
      if (c === undefined) { c = viewUuids.length; index.set(uuid, c); viewUuids.push(uuid) }
      vcam[k++] = c
    }
  }
  return { n, pos, vstart, vcam, viewUuids }
}

/** The buffers to transfer. */
export const sparseInputTransfer = (s) => [s.pos.buffer, s.vstart.buffer, s.vcam.buffer]

/** uuid → ascending point indices seen by that image. Built once per run: O(observations). */
export function viewIndex(sparse) {
  const { n, vstart, vcam, viewUuids } = sparse
  const counts = new Uint32Array(viewUuids.length)
  for (let k = 0; k < vstart[n]; k++) counts[vcam[k]]++
  const lists = Array.from(counts, (c) => new Uint32Array(c))
  const fill = new Uint32Array(viewUuids.length)
  for (let i = 0; i < n; i++) {
    for (let k = vstart[i]; k < vstart[i + 1]; k++) { const c = vcam[k]; lists[c][fill[c]++] = i }
  }
  return new Map(viewUuids.map((u, c) => [u, lists[c]]))
}

/** The positions (flat xyz) inside a region box. */
export function positionsInRegion(pos, r) {
  const keep = []
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    if (x >= r.min[0] && x <= r.max[0] && y >= r.min[1] && y <= r.max[1] && z >= r.min[2] && z <= r.max[2]) keep.push(i)
  }
  const out = new Float64Array(3 * keep.length)
  keep.forEach((i, j) => { out[3 * j] = pos[i]; out[3 * j + 1] = pos[i + 1]; out[3 * j + 2] = pos[i + 2] })
  return out
}

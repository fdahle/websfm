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

/** Pack a SparsePoints cloud: copies of its positions and camera tracks (transferred). */
export function packSparseForDense(points) {
  const n = points?.length ?? 0
  if (!n) return { n: 0, pos: new Float64Array(0), vstart: new Uint32Array(1), vcam: new Uint32Array(0), viewUuids: [] }
  return { n, pos: points.pos.slice(0, 3 * n), vstart: points.vstart.slice(), vcam: points.vcam.slice(0, points.viewTotal),
    viewUuids: [...points.viewUuids] }
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

// Face adjacency of a triangle mesh. Pure, typed arrays only (a few million faces).
//
// Edge k of face f runs from corner k to corner (k + 1) % 3. adj[3f + k] is the face
// across that edge (−1 at a boundary), rev[3f + k] the slot of f in that face's own
// adjacency, so a message can be written straight into the neighbour's slot. A
// non-manifold edge (three or more faces) links only the first reciprocal pair found
// and leaves the others as boundary: view selection and chart growth need a symmetric
// graph, not every incidence.

export function faceAdjacency(idx, nVerts) {
  const F = idx.length / 3
  // Vertex → incident faces (CSR).
  const start = new Int32Array(nVerts + 1)
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++
  for (let v = 0; v < nVerts; v++) start[v + 1] += start[v]
  const fill = start.slice(0, nVerts)
  const inc = new Int32Array(idx.length)
  for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) inc[fill[idx[3 * f + k]]++] = f

  const adj = new Int32Array(3 * F).fill(-1)
  const rev = new Int8Array(3 * F).fill(-1)
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      if (adj[3 * f + k] >= 0) continue
      const a = idx[3 * f + k], b = idx[3 * f + (k + 1) % 3]
      if (a === b) continue
      for (let x = start[a]; x < start[a + 1]; x++) {
        const g = inc[x]
        if (g === f) continue
        const r = edgeSlot(idx, g, a, b)
        if (r < 0 || adj[3 * g + r] >= 0) continue
        adj[3 * f + k] = g; rev[3 * f + k] = r
        adj[3 * g + r] = f; rev[3 * g + r] = k
        break
      }
    }
  }
  return { adj, rev }
}

// The slot of edge {a, b} in face g, or −1.
function edgeSlot(idx, g, a, b) {
  for (let r = 0; r < 3; r++) {
    const p = idx[3 * g + r], q = idx[3 * g + (r + 1) % 3]
    if ((p === a && q === b) || (p === b && q === a)) return r
  }
  return -1
}

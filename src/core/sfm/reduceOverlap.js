// Reduce overlap (Tools ▸ Images ▾): the subset of the enabled photos that dense
// matching actually needs on a heavily overlapping block, the rest disabled
// (core/imageEnabled.js). The same idea as Metashape's Reduce Overlap, with the sparse
// model standing in for the surface.
//
// Visibility, not tracks: a sparse point's track lists the photos that matched it,
// often 3 of the 15 that see it, so tracks would pin every photo. A photo counts as
// seeing a point when the point lies in front of it and inside its frame, and the ray
// to it is within `maxAngle` of the point's mean viewing direction (the directions to
// the cameras of its track): the side of the surface the photos face. Occlusion is
// not tested, which on an object is what the angle is for.
//
// Then greedily: while some photo can go without any point falling below
// min(coverage, photos that see it), disable the one whose points are the most
// over-covered (the mean of cover − need over them). Cover only falls, so a photo that
// cannot go now never can, and a lazy max-heap finds the next one.

/**
 * Which of `cameras` see which sampled points.
 * @param {{pos: Float64Array, vstart: Uint32Array, vcam: Uint32Array, viewUuids: string[], length: number}} points
 *   a SparsePoints cloud (core/sfm/sparsePoints.js)
 * @param {{uuid: string, R: number[][], t: number[], K: {fx,fy,cx,cy}, width: number, height: number}[]} cameras
 * @returns {{ points: number, pstart: Uint32Array, pcam: Uint32Array }} per sampled point,
 *   the camera indices that see it
 */
export function overlapVisibility(points, cameras, { maxAngle = 60, maxPoints = 20000 } = {}) {
  const n = points?.length ?? 0
  const nc = cameras.length
  const camOfView = new Int32Array(points?.viewUuids?.length ?? 0).fill(-1)
  const index = new Map(cameras.map((c, i) => [c.uuid, i]))
  points?.viewUuids?.forEach((u, k) => (camOfView[k] = index.get(u) ?? -1))
  // Camera centres C = −Rᵀt.
  const C = new Float64Array(3 * nc)
  cameras.forEach(({ R, t }, i) => {
    for (let a = 0; a < 3; a++) C[3 * i + a] = -(R[0][a] * t[0] + R[1][a] * t[1] + R[2][a] * t[2])
  })
  const cosMax = Math.cos((Math.max(0, Math.min(90, maxAngle)) * Math.PI) / 180)
  const step = Math.max(1, Math.ceil(n / maxPoints))
  const pstart = [0]
  const pcam = []
  for (let i = 0; i < n; i += step) {
    const x = points.pos[3 * i],
      y = points.pos[3 * i + 1],
      z = points.pos[3 * i + 2]
    // Mean viewing direction over the track's cameras that are in play.
    let nx = 0,
      ny = 0,
      nz = 0,
      m = 0
    for (let k = points.vstart[i]; k < points.vstart[i + 1]; k++) {
      const c = camOfView[points.vcam[k]]
      if (c < 0) continue
      const dx = C[3 * c] - x,
        dy = C[3 * c + 1] - y,
        dz = C[3 * c + 2] - z
      const d = Math.hypot(dx, dy, dz)
      if (!(d > 0)) continue
      nx += dx / d
      ny += dy / d
      nz += dz / d
      m++
    }
    const nl = Math.hypot(nx, ny, nz)
    if (!m || !(nl > 0)) continue
    nx /= nl
    ny /= nl
    nz /= nl
    for (let c = 0; c < nc; c++) {
      const { R, t, K, width, height } = cameras[c]
      const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
      if (!(zc > 0)) continue
      const u = K.fx * ((R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]) / zc) + K.cx
      const v = K.fy * ((R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]) / zc) + K.cy
      if (!(u >= 0 && u < width && v >= 0 && v < height)) continue
      const dx = C[3 * c] - x,
        dy = C[3 * c + 1] - y,
        dz = C[3 * c + 2] - z
      const d = Math.hypot(dx, dy, dz)
      if (!((dx * nx + dy * ny + dz * nz) / d >= cosMax)) continue
      pcam.push(c)
    }
    pstart.push(pcam.length)
  }
  return { points: pstart.length - 1, pstart: Uint32Array.from(pstart), pcam: Uint32Array.from(pcam) }
}

/**
 * The photos to keep: every point keeps min(coverage, photos that see it).
 * @param {{points: number, pstart: Uint32Array, pcam: Uint32Array}} vis  overlapVisibility
 * @param {number} nCameras
 * @returns {Uint8Array} 1 = keep, per camera
 */
export function chooseOverlapSubset(vis, nCameras, { coverage = 3 } = {}) {
  const { points: np, pstart, pcam } = vis
  const keep = new Uint8Array(nCameras).fill(1)
  const cover = new Int32Array(np)
  const need = new Int32Array(np)
  for (let p = 0; p < np; p++) {
    cover[p] = pstart[p + 1] - pstart[p]
    need[p] = Math.min(Math.max(1, coverage), cover[p])
  }
  // Camera → its points.
  const cstart = new Uint32Array(nCameras + 1)
  for (let k = 0; k < pcam.length; k++) cstart[pcam[k] + 1]++
  for (let c = 0; c < nCameras; c++) cstart[c + 1] += cstart[c]
  const cpt = new Uint32Array(pcam.length)
  const fill = cstart.slice(0, nCameras)
  for (let p = 0; p < np; p++) for (let k = pstart[p]; k < pstart[p + 1]; k++) cpt[fill[pcam[k]]++] = p
  // Mean slack over the camera's points, or −1 when it cannot go (a point at its need).
  // A camera that sees no sampled point adds nothing: it goes first.
  const score = (c) => {
    let s = 0
    for (let k = cstart[c]; k < cstart[c + 1]; k++) {
      const slack = cover[cpt[k]] - need[cpt[k]]
      if (slack < 1) return -1
      s += slack
    }
    const m = cstart[c + 1] - cstart[c]
    return m ? s / m : Infinity
  }
  // Max-heap on (score, then lower index).
  const heap = []
  const above = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] < b[1])
  const push = (e) => {
    heap.push(e)
    for (let i = heap.length - 1; i > 0;) {
      const j = (i - 1) >> 1
      if (!above(heap[i], heap[j])) break
      ;[heap[i], heap[j]] = [heap[j], heap[i]]
      i = j
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      for (let i = 0; ;) {
        const l = 2 * i + 1,
          r = l + 1
        let b = i
        if (l < heap.length && above(heap[l], heap[b])) b = l
        if (r < heap.length && above(heap[r], heap[b])) b = r
        if (b === i) break
        ;[heap[i], heap[b]] = [heap[b], heap[i]]
        i = b
      }
    }
    return top
  }
  for (let c = 0; c < nCameras; c++) {
    const s = score(c)
    if (s >= 0) push([s, c])
  }
  while (heap.length) {
    const [s, c] = pop()
    const now = score(c)
    if (now < 0) continue // can no longer go, and never will
    if (now < s) {
      push([now, c]) // stale: back in at its current score
      continue
    }
    keep[c] = 0
    for (let k = cstart[c]; k < cstart[c + 1]; k++) cover[cpt[k]]--
  }
  return keep
}

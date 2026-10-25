// ── Projection-guided track extension (pure) ─────────────────────────────────
// Every South Building run discarded 46–73k two-view points that had no verified
// correspondence into a third registered image (MAT-06): matching missed those
// observations, track building did not drop them. Global matching has to decide among
// all of an image's keypoints, so a feature with a near-twin elsewhere (repetitive
// façade texture) fails the ratio test there. Once the poses exist that ambiguity is
// gone: the point can only appear within a few pixels of its projection.
//
// So, per point and per registered camera that does not observe it: project, take the
// unused keypoints within the reprojection gate, and accept the best by descriptor
// distance when it is (a) close in absolute terms — under a threshold measured from
// this run's own multi-view tracks — and (b) clearly better than the runner-up in the
// same small window. Proposals are then resolved greedily, best first, so one keypoint
// joins at most one point and one point gains at most one keypoint per camera. The
// caller's filter + bundle adjustment then treat the additions like any other
// observation. COLMAP has no equivalent; its completion only uses existing matches.
//
// Descriptors are COLMAP-style uint8 (RootSIFT × 512), 128 per keypoint.

const DIM = 128

function dist2(a, ao, b, bo) {
  let s = 0
  for (let i = 0; i < DIM; i++) {
    const d = a[ao + i] - b[bo + i]
    s += d * d
  }
  return s
}

// The largest keypoint grid one camera's search builds (guidedExtendTracks), in cells.
const GRID_MAX_CELLS = 1 << 22

// Order of two keypoints by their gate-sized cell (column, then row), then index.
function gateCellOrder(xy, a, b, gatePx) {
  return (
    Math.floor(xy[2 * a] / gatePx) - Math.floor(xy[2 * b] / gatePx) ||
    Math.floor(xy[2 * a + 1] / gatePx) - Math.floor(xy[2 * b + 1] / gatePx) ||
    a - b
  )
}

// dist2, but it stops once the sum passes `bound` and returns that partial sum (still
// above the bound). The sums are of integers, exact in any order, so a caller that
// only asks "is it below the bound, and by how much" gets the same answers.
function dist2Below(a, ao, b, bo, bound) {
  let s = 0
  for (let i = 0; i < DIM; i += 16) {
    for (let j = i; j < i + 16; j++) {
      const d = a[ao + j] - b[bo + j]
      s += d * d
    }
    if (s > bound) return s
  }
  return s
}

/**
 * The squared-distance acceptance threshold, measured: the `quantile` of distances
 * between two observations of the same point over tracks with ≥3 views (verified,
 * multi-view evidence). Deterministic sampling: every k-th point.
 * @param {object} tracks   TrackStore (trackStore.js)
 * @param {(img:number, kp:number) => {arr:Uint8Array, off:number}|null} descOf
 */
export function trackDistanceThreshold(tracks, descOf, { quantile = 0.9, maxSamples = 20000 } = {}) {
  const multi = []
  tracks.forEachPoint((p) => {
    if (tracks.viewCount(p) >= 3) multi.push(p)
  })
  if (!multi.length) return null
  const step = Math.max(1, Math.floor(multi.length / maxSamples))
  const d = []
  for (let i = 0; i < multi.length; i += step) {
    // The first two observations of the track.
    let img0 = -1,
      kp0 = -1,
      img1 = -1,
      kp1 = -1
    tracks.someView(multi[i], (img, kp) => {
      if (img0 < 0) {
        img0 = img
        kp0 = kp
        return false
      }
      img1 = img
      kp1 = kp
      return true
    })
    const a = descOf(img0, kp0),
      b = descOf(img1, kp1)
    if (a && b) d.push(dist2(a.arr, a.off, b.arr, b.off))
  }
  if (!d.length) return null
  d.sort((x, y) => x - y)
  return d[Math.min(d.length - 1, Math.floor(quantile * d.length))]
}

// The cameras (camList indices, in order) that can see a point, by a coarse grid over the
// points: for each occupied cell, the cameras with keypoints whose image the cell can
// reach. Exact: a camera is left out only when all 8 corners of the cell are in front of
// it and project past one side of its keypoint bounds (by a margin for rounding): every
// point of the cell, a convex combination of the corners, then projects past that side
// too (perspective division keeps convex combinations, with positive weights, in front
// of the camera). Returns { cellOf(x, y, z) → cell key, camsOfCell(key) → indices }.
// Quarry: 126 k points × 347 cameras.
const CULL_CELLS = 16
function frustumCells(tracks, camList) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity]
  tracks.forEachPoint((p) => {
    const v = [tracks.x(p), tracks.y(p), tracks.z(p)]
    for (let k = 0; k < 3; k++) {
      if (v[k] < lo[k]) lo[k] = v[k]
      if (v[k] > hi[k]) hi[k] = v[k]
    }
  })
  const all = camList.map((c, i) => i).filter((i) => camList[i].grid)
  if (!(hi[0] >= lo[0])) return { cellOf: () => 0, camsOfCell: () => all }
  const G = CULL_CELLS
  const size = [0, 1, 2].map((k) => Math.max((hi[k] - lo[k]) / G, 1e-9) * (1 + 1e-9))
  const cellOf = (x, y, z) => {
    const c = [x, y, z].map((v, k) => Math.min(G - 1, Math.max(0, Math.floor((v - lo[k]) / size[k]))))
    return (c[0] * G + c[1]) * G + c[2]
  }
  const occupied = new Set()
  tracks.forEachPoint((p) => occupied.add(cellOf(tracks.x(p), tracks.y(p), tracks.z(p))))
  const EPS = 1e-6 // px
  const lists = new Map()
  for (const cell of occupied) {
    const ix = Math.floor(cell / (G * G)),
      iy = Math.floor(cell / G) % G,
      iz = cell % G
    // The cell's box, grown by a hair so it surely holds its points.
    const b0 = [ix, iy, iz].map((i, k) => lo[k] + i * size[k] - size[k] * 1e-6)
    const b1 = [ix, iy, iz].map((i, k) => lo[k] + (i + 1) * size[k] + size[k] * 1e-6)
    const list = []
    for (const ci of all) {
      const { P, grid: g } = camList[ci]
      let front = true,
        left = true,
        right = true,
        top = true,
        bottom = true
      for (let c = 0; c < 8 && front; c++) {
        const x = c & 1 ? b1[0] : b0[0],
          y = c & 2 ? b1[1] : b0[1],
          z = c & 4 ? b1[2] : b0[2]
        const zc = P[6] * x + P[7] * y + P[8] * z + P[11]
        if (!(zc > 1e-9)) {
          front = false
          break
        }
        const u = P[12] * ((P[0] * x + P[1] * y + P[2] * z + P[9]) / zc) + P[14]
        const v = P[13] * ((P[3] * x + P[4] * y + P[5] * z + P[10]) / zc) + P[15]
        if (!(u < g.minX - EPS)) left = false
        if (!(u > g.maxX + EPS)) right = false
        if (!(v < g.minY - EPS)) top = false
        if (!(v > g.maxY + EPS)) bottom = false
      }
      if (!front || !(left || right || top || bottom)) list.push(ci)
    }
    lists.set(cell, list)
  }
  return { cellOf, camsOfCell: (cell) => lists.get(cell) ?? all }
}

/**
 * @param {object} o
 * @param {object} o.tracks                  TrackStore (trackStore.js); additions go here
 * @param {object} o.ids                     makeImageIds: uuid ↔ image index
 * @param {Map} o.cameras                    uuid → { R, t, K }
 * @param {(img:number) => {n:number, xy:Float64Array}|null} o.keypointsAt   the image's KeypointSet
 * @param {(img:number, kp:number) => {arr:Uint8Array, off:number}|null} o.descOf
 * @param {number} o.gatePx                  search radius = the reprojection gate
 * @param {number} [o.maxDist2]              squared descriptor threshold (else measured)
 * @param {number} [o.ratio]                 best must beat the runner-up by this ratio
 * @param {number} [o.quantile]              track-distance quantile that sets the threshold
 * @param {number} [o.refObs]                compare against at most this many observations
 * @param {(p:number, img:number, kp:number) => void} [o.onAdd]  called per accepted observation
 */
export function guidedExtendTracks({
  tracks,
  ids,
  cameras,
  keypointsAt,
  descOf,
  gatePx,
  maxDist2 = null,
  ratio = 0.8,
  quantile = 0.9,
  refObs = 3,
  onAdd = null,
}) {
  const tau2 = maxDist2 ?? trackDistanceThreshold(tracks, descOf, { quantile })
  const stats = {
    tau: tau2 == null ? null : Math.sqrt(tau2) / 512,
    projections: 0,
    windows: 0,
    proposals: 0,
    added: 0,
    lifted: 0,
    pointsExtended: 0,
  }
  // No gate, no window: a zero gate (a residual p90 of exactly 0) finds nothing to add.
  if (tau2 == null || !(gatePx > 0)) return stats
  const r2 = gatePx * gatePx
  const ratio2 = ratio * ratio

  // Per-camera keypoint bounds, in camera order (the keypoint grid is built per camera
  // in the search below).
  const camList = [] // { img, cam, P, grid: { xy, n, minX, minY, maxX, maxY } | null }
  for (const [uuid, cam] of cameras) {
    const img = ids.img(uuid)
    const kps = keypointsAt(img)
    if (!kps?.n) {
      camList.push({ img, cam, grid: null })
      continue
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    const xy = kps.xy
    for (let i = 0; i < kps.n; i++) {
      const x = xy[2 * i],
        y = xy[2 * i + 1]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    // The pose and K flat, for the projection inlined below.
    const P = Float64Array.of(
      cam.R[0][0],
      cam.R[0][1],
      cam.R[0][2],
      cam.R[1][0],
      cam.R[1][1],
      cam.R[1][2],
      cam.R[2][0],
      cam.R[2][1],
      cam.R[2][2],
      cam.t[0],
      cam.t[1],
      cam.t[2],
      cam.K.fx,
      cam.K.fy,
      cam.K.cx,
      cam.K.cy,
    )
    camList.push({ img, cam, P, grid: { xy, n: kps.n, minX, minY, maxX, maxY } })
  }

  // Every point is tried against every camera that can see it (frustumCells): project
  // first, and ask whether the camera already observes it only for a projection inside
  // the image (viewKp scans the point's views, and most of the 12.8 M point × camera pairs
  // on quarry land outside). `projections` counts the pairs tried, as before: the cameras
  // with keypoints less the point's views in them.
  const withGrid = new Uint8Array(camList.reduce((n, c) => Math.max(n, c.img + 1), 0))
  let nWithGrid = 0
  for (const c of camList)
    if (c.grid) {
      withGrid[c.img] = 1
      nWithGrid++
    }
  const cull = frustumCells(tracks, camList)
  // The points with reference descriptors, in order, grouped by cull cell.
  const ptId = [],
    ptRefs = [],
    ptPos = []
  const ptsOfCell = new Map() // cull cell → [j, …] ascending
  tracks.forEachPoint((p) => {
    const refs = []
    tracks.someView(p, (img, k) => {
      const d = descOf(img, k)
      if (d) refs.push(d)
      return refs.length >= refObs
    })
    if (!refs.length) return
    let seen = 0
    tracks.forEachView(p, (img) => {
      if (withGrid[img]) seen++
    })
    stats.projections += nWithGrid - seen
    const x = tracks.x(p),
      y = tracks.y(p),
      z = tracks.z(p)
    const cell = cull.cellOf(x, y, z)
    let list = ptsOfCell.get(cell)
    if (!list) ptsOfCell.set(cell, (list = []))
    list.push(ptId.length)
    ptId.push(p)
    ptRefs.push(refs)
    ptPos.push(x, y, z)
  })
  const cellsOfCam = camList.map(() => [])
  for (const cell of ptsOfCell.keys()) for (const ci of cull.camsOfCell(cell)) cellsOfCam[ci].push(cell)

  // Camera by camera (one keypoint grid in memory at a time, and its keypoints stay in
  // cache): the grid is dense, in cells of `gatePx` (or a whole multiple of it, so a small
  // gate on a big image stays within GRID_MAX_CELLS). A keypoint within the gate of a
  // projection lies in the 3 × 3 gate-sized cells around it; the candidates are visited
  // in that order (cell column, cell row, keypoint index), which decides between equal
  // descriptor distances, and the proposals are sorted by (distance, point, camera): the
  // same proposals in the same order as trying the cameras point by point.
  const proposals = []
  let cellStart = new Int32Array(0),
    cellKp = new Int32Array(0)
  const cand = [] // candidate keypoint indices of one window
  for (let ci = 0; ci < camList.length; ci++) {
    const { img, P, grid: g } = camList[ci]
    if (!g || !cellsOfCam[ci].length || !(g.maxX >= g.minX && g.maxY >= g.minY)) continue
    const xy = g.xy
    const gx0 = Math.floor(g.minX / gatePx),
      gy0 = Math.floor(g.minY / gatePx)
    const ngx = Math.floor(g.maxX / gatePx) - gx0 + 1,
      ngy = Math.floor(g.maxY / gatePx) - gy0 + 1
    const f = Math.max(1, Math.ceil(Math.sqrt((ngx * ngy) / GRID_MAX_CELLS)))
    const nx = Math.floor((ngx - 1) / f) + 1,
      ny = Math.floor((ngy - 1) / f) + 1
    if (cellStart.length < nx * ny + 1) cellStart = new Int32Array(nx * ny + 1)
    else cellStart.fill(0, 0, nx * ny + 1)
    if (cellKp.length < g.n) cellKp = new Int32Array(g.n)
    // Counting sort by cell: keypoints stay in index order within a cell.
    const cellOfKp = (i) => {
      const x = xy[2 * i],
        y = xy[2 * i + 1]
      // eslint-disable-next-line no-self-compare
      if (x !== x || y !== y) return -1 // a missing keypoint
      return Math.floor((Math.floor(x / gatePx) - gx0) / f) * ny + Math.floor((Math.floor(y / gatePx) - gy0) / f)
    }
    for (let i = 0; i < g.n; i++) {
      const c = cellOfKp(i)
      if (c >= 0) cellStart[c + 1]++
    }
    for (let c = 0; c < nx * ny; c++) cellStart[c + 1] += cellStart[c]
    const fillAt = cellStart.slice(0, nx * ny)
    for (let i = 0; i < g.n; i++) {
      const c = cellOfKp(i)
      if (c >= 0) cellKp[fillAt[c]++] = i
    }
    for (const cell of cellsOfCam[ci]) {
      for (const j of ptsOfCell.get(cell)) {
        const px = ptPos[3 * j],
          py = ptPos[3 * j + 1],
          pz = ptPos[3 * j + 2]
        // projectWithDepth, inlined (every point × every camera: 100 M calls at 1,600
        // cameras, and each allocated its result). Same arithmetic, same order.
        const zc = P[6] * px + P[7] * py + P[8] * pz + P[11]
        if (!(zc > 1e-9)) continue
        const u = P[12] * ((P[0] * px + P[1] * py + P[2] * pz + P[9]) / zc) + P[14]
        const v = P[13] * ((P[3] * px + P[4] * py + P[5] * pz + P[10]) / zc) + P[15]
        if (u < g.minX || u > g.maxX || v < g.minY || v > g.maxY) continue
        const p = ptId[j]
        if (tracks.viewKp(p, img) >= 0) continue
        const cx = Math.floor(u / gatePx),
          cy = Math.floor(v / gatePx)
        cand.length = 0
        const x0 = Math.max(0, Math.floor((cx - 1 - gx0) / f)),
          x1 = Math.min(nx - 1, Math.floor((cx + 1 - gx0) / f)),
          y0 = Math.max(0, Math.floor((cy - 1 - gy0) / f)),
          y1 = Math.min(ny - 1, Math.floor((cy + 1 - gy0) / f))
        for (let bx = x0; bx <= x1; bx++) {
          for (let by = y0; by <= y1; by++) {
            for (let s = cellStart[bx * ny + by], e = cellStart[bx * ny + by + 1]; s < e; s++) {
              const i = cellKp[s]
              const kx = xy[2 * i],
                ky = xy[2 * i + 1]
              const gx = Math.floor(kx / gatePx),
                gy = Math.floor(ky / gatePx)
              if (gx < cx - 1 || gx > cx + 1 || gy < cy - 1 || gy > cy + 1) continue
              if ((kx - u) ** 2 + (ky - v) ** 2 > r2) continue
              cand.push(i)
            }
          }
        }
        if (!cand.length) continue
        // A coarse cell holds several gate cells: put the candidates in gate-cell order.
        if (f > 1 && cand.length > 1) cand.sort((a, b) => gateCellOrder(xy, a, b, gatePx))
        const refs = ptRefs[j]
        let best = Infinity,
          second = Infinity,
          bestKp = -1,
          any = false
        for (const i of cand) {
          if (tracks.pointAt(img, i) >= 0) continue
          const cd = descOf(img, i)
          if (!cd) continue
          any = true
          // A candidate whose distance passes the runner-up's cannot change the best or
          // the runner-up, so each reference stops once it is past both (dist2Below):
          // `best` and `second` come out exact, and so does every proposal.
          let d = Infinity
          for (const ref of refs) d = Math.min(d, dist2Below(ref.arr, ref.off, cd.arr, cd.off, Math.min(d, second)))
          if (d < best) {
            second = best
            best = d
            bestKp = i
          } else if (d < second) second = d
        }
        if (!any) continue
        stats.windows++
        if (best <= tau2 && (second === Infinity || best <= ratio2 * second)) {
          proposals.push({ p, ci, img, kp: bestKp, d2: best })
        }
      }
    }
  }
  stats.proposals = proposals.length

  // Resolve best-first: a keypoint joins one point, a point gains one view per camera.
  proposals.sort((a, b) => a.d2 - b.d2 || a.p - b.p || a.ci - b.ci)
  const claimed = new Map() // img → Set<kp>
  const extended = new Set()
  for (const pr of proposals) {
    if (tracks.viewKp(pr.p, pr.img) >= 0) continue
    let c = claimed.get(pr.img)
    if (!c) {
      c = new Set()
      claimed.set(pr.img, c)
    }
    if (c.has(pr.kp) || tracks.pointAt(pr.img, pr.kp) >= 0) continue
    c.add(pr.kp)
    const before = tracks.viewCount(pr.p)
    tracks.addView(pr.p, pr.img, pr.kp)
    onAdd?.(pr.p, pr.img, pr.kp)
    stats.added++
    if (before === 2) stats.lifted++
    extended.add(pr.p)
  }
  stats.pointsExtended = extended.size
  return stats
}

/**
 * Were the additions right? Compare the final residuals of the guided observations that
 * survived the filter and BA with every other observation's. False additions would sit
 * anywhere inside the search gate, so their median would be far above the population's;
 * true ones look like the rest of the model. Observations are keyed by (image, keypoint):
 * a point can be merged or renumbered after the addition, its observation cannot.
 * @param {{uuid:string, kp:number}[]} additions
 * @param {(visit: (uuid:string, kp:number, residualPx:number|null) => void) => void} forEachObservation
 *   walks the model's current observations, in point then view order
 */
export function auditGuidedAdditions(additions, forEachObservation) {
  const key = (uuid, kp) => `${uuid}|${kp}`
  const added = new Set(additions.map((a) => key(a.uuid, a.kp)))
  const mine = [],
    rest = []
  forEachObservation((uuid, kp, r) => {
    if (r == null) return
    ;(added.has(key(uuid, kp)) ? mine : rest).push(r)
  })
  const q = (arr, f) => {
    if (!arr.length) return null
    // A typed array sorts numerically and natively (a comparator sort of ~1 M residuals
    // was a second on quarry), in the same order unless a residual is NaN.
    let a = Float64Array.from(arr)
    a = a.some(Number.isNaN) ? [...arr].sort((x, y) => x - y) : a.sort()
    return a[Math.min(a.length - 1, Math.floor(f * a.length))]
  }
  return {
    proposed: additions.length,
    survived: mine.length,
    medianPx: q(mine, 0.5),
    p90Px: q(mine, 0.9),
    restMedianPx: q(rest, 0.5),
    restP90Px: q(rest, 0.9),
  }
}

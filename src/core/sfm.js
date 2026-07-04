// Incremental Structure-from-Motion orchestration — pure compute, no Vue/Pinia/
// OPFS. Lifted verbatim from useReconstructionStore so it can run inside the
// compute worker (off the main thread). Side effects are injected as hooks:
//   onLog(message, level, category)   — diagnostics (mirrors the app log)
//   onProgress(done, total, label)    — progress for the modal
// The store keeps persistence (OPFS) and reactive state; this module only takes
// plain data in and returns plain data out.
//
// Input:
//   images:   [{ uuid, name, keypoints: [{x,y}, …], meta: { width, height, focalLength35 } | null }]
//   pairs:    [{ idA, idB, F: number[3][3], matches: [[ia,ib], …], inlierCount, status }]
//             (only 'done' pairs are used; the store passes those)
//   settings: tuning knobs (see destructuring below)
// Output:
//   { status: 'idle' | 'done' | 'error',
//     cameras: [{ uuid, R, t, K }],
//     points:  [{ x, y, z, views: [[uuid, kpIdx], …] }] }

import {
  resolveK, fundamentalToEssential, makeP34flat,
  recoverPose, triangulateDlt, solvePnp, bundleAdjust,
} from './reconstruction.js'
import { projectPoint, projectWithDepth, medianTriangulationAngle } from './geometry.js'
import { undistortPixel, distortionOf } from './distortion.js'

// ── Geometry helpers ────────────────────────────────────────────────────────────
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

// Depth of world point (x,y,z) along a flat 3×4 projection matrix's principal
// axis. P is row-major [r0(4), r1(4), r2(4)]; depth = r2 · [x, y, z, 1].
// Positive ⇒ the point is in front of that camera (cheirality).
function projDepth(P, x, y, z) {
  return P[8] * x + P[9] * y + P[10] * z + P[11]
}

// Summary statistics for an array of numbers (e.g. reprojection residuals, px).
// Returns { mean, median, p95, max, count }; all zero when empty.
function numStats(arr) {
  const n = arr.length
  if (n === 0) return { mean: 0, median: 0, p95: 0, max: 0, count: 0 }
  const sorted = [...arr].sort((a, b) => a - b)
  const sum = sorted.reduce((s, v) => s + v, 0)
  const at = (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]
  return { mean: sum / n, median: at(0.5), p95: at(0.95), max: sorted[n - 1], count: n }
}

// One-line formatter for a numStats result.
function fmtStats(s) {
  return `mean ${s.mean.toFixed(2)}px, median ${s.median.toFixed(2)}px, `
    + `p95 ${s.p95.toFixed(2)}px, max ${s.max.toFixed(2)}px (${s.count} obs)`
}

// Convert pixel coord to normalised (K^-1 applied).
function toNorm(px, py, K) {
  return { x: (px - K.cx) / K.fx, y: (py - K.cy) / K.fy }
}

// Eigenvalues of a symmetric 3×3 matrix, descending (analytic, Smith 1961).
function eigSym3(a) {
  const p1 = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2
  if (p1 === 0) return [a[0][0], a[1][1], a[2][2]].sort((x, y) => y - x)
  const q = (a[0][0] + a[1][1] + a[2][2]) / 3
  const p2 = (a[0][0] - q) ** 2 + (a[1][1] - q) ** 2 + (a[2][2] - q) ** 2 + 2 * p1
  const p = Math.sqrt(p2 / 6)
  const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) B[i][j] = (a[i][j] - (i === j ? q : 0)) / p
  const detB =
      B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1])
    - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0])
    + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0])
  const phi = Math.acos(Math.max(-1, Math.min(1, detB / 2))) / 3
  const e1 = q + 2 * p * Math.cos(phi)
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
  return [e1, 3 * q - e1 - e3, e3]
}

// Singular values of the essential matrix E (flat row-major, 9 elements), as
// √eig(EᵀE). A true essential matrix has σ1≈σ2 and σ3≈0; when the intrinsics
// (focal length) are wrong, F→E conversion yields σ2/σ1 well below 1 — a direct
// signal that K is off. Returns { s1, s2, s3 } descending.
function essentialSingularValues(Eflat) {
  const E = [
    [Eflat[0], Eflat[1], Eflat[2]],
    [Eflat[3], Eflat[4], Eflat[5]],
    [Eflat[6], Eflat[7], Eflat[8]],
  ]
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] // EᵀE
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0
    for (let k = 0; k < 3; k++) s += E[k][i] * E[k][j]
    M[i][j] = s
  }
  const [a, b, c] = eigSym3(M).map((v) => Math.sqrt(Math.max(0, v)))
  return { s1: a, s2: b, s3: c }
}

// Build flat P34 for a camera in *normalised* image coords (no K).
function camToP34flat(cam) {
  return makeP34flat(cam.R, cam.t)
}

// ── Retriangulation + track merging (A3, pure) ───────────────────────────────
// Standard COLMAP-style post-BA structure recovery, factored out of `reconstruct`
// so it's testable in isolation. Shared signature:
//   points3d : [{ x, y, z, views: Map<uuid,kpIdx> }]
//   cameras  : Map<uuid, { R, t, K }>
//   pairs    : verified match pairs [{ idA, idB, matches: [[iaKp, ibKp], …] }]
//   keypointOf(uuid, kpIdx) → { x, y } | null
//   maxReprojPx : reprojection gate (px)

// uuid → Map<kpIdx, point> reverse index over a track list.
function buildViewIndex(points3d) {
  const index = new Map()
  for (const pt of points3d) {
    for (const [uuid, kp] of pt.views) {
      let m = index.get(uuid)
      if (!m) { m = new Map(); index.set(uuid, m) }
      m.set(kp, pt)
    }
  }
  return index
}

const reprojErr = (cam, x, y, z, kp) => {
  const p = projectWithDepth(cam, x, y, z) // null when behind the camera
  return p ? Math.hypot(p.u - kp.x, p.v - kp.y) : Infinity
}

// Retriangulate matches whose *both* keypoints are still unassigned, using the
// current (post-BA) poses. Adds a point when it's in front of both cameras and
// reprojects ≤ gate in both. `triangulate(nA, nB, PA, PB)` is injected (WASM DLT
// in production). Mutates + returns `points3d`; returns { added }.
export async function retriangulatePairs({ points3d, cameras, pairs, keypointOf, maxReprojPx, triangulate }) {
  const index = buildViewIndex(points3d)
  const addIndexed = (pt, uuid, kp) => {
    pt.views.set(uuid, kp)
    let m = index.get(uuid); if (!m) { m = new Map(); index.set(uuid, m) }
    m.set(kp, pt)
  }
  let added = 0
  for (const e of pairs) {
    const camA = cameras.get(e.idA), camB = cameras.get(e.idB)
    if (!camA || !camB) continue // both endpoints must be registered
    const idxA = index.get(e.idA), idxB = index.get(e.idB)
    const fresh = e.matches.filter(([ia, ib]) => !idxA?.has(ia) && !idxB?.has(ib))
    if (!fresh.length) continue

    const KA = camA.K, KB = camB.K
    const PA = camToP34flat(camA), PB = camToP34flat(camB)
    const nA = [], nB = [], keep = []
    for (const [ia, ib] of fresh) {
      const kA = keypointOf(e.idA, ia), kB = keypointOf(e.idB, ib)
      if (!kA || !kB) continue
      nA.push(toNorm(kA.x, kA.y, KA)); nB.push(toNorm(kB.x, kB.y, KB)); keep.push([ia, ib])
    }
    if (!keep.length) continue

    const tri = await triangulate(nA, nB, PA, PB) // [{ x, y, z, srcIdx }]
    for (const { x, y, z, srcIdx } of tri) {
      const [ia, ib] = keep[srcIdx]
      // A point added earlier in this batch may already own one endpoint.
      if (index.get(e.idA)?.has(ia) || index.get(e.idB)?.has(ib)) continue
      const kA = keypointOf(e.idA, ia), kB = keypointOf(e.idB, ib)
      if (reprojErr(camA, x, y, z, kA) > maxReprojPx) continue
      if (reprojErr(camB, x, y, z, kB) > maxReprojPx) continue
      const pt = { x, y, z, views: new Map() }
      addIndexed(pt, e.idA, ia)
      addIndexed(pt, e.idB, ib)
      points3d.push(pt)
      added++
    }
  }
  return { added }
}

// Merge tracks split across two points: a match whose endpoints belong to two
// *different* points means the same physical feature was reconstructed twice.
// Fold the loser into the winner when the union is consistent (no image twice) and
// every added observation still reprojects ≤ gate against the winner. Returns the
// surviving array + { merged }.
export function mergeSplitTracks({ points3d, cameras, pairs, keypointOf, maxReprojPx }) {
  const index = buildViewIndex(points3d)
  let merged = 0
  for (const e of pairs) {
    if (!cameras.has(e.idA) || !cameras.has(e.idB)) continue
    const idxA = index.get(e.idA), idxB = index.get(e.idB)
    for (const [ia, ib] of e.matches) {
      const p1 = idxA?.get(ia), p2 = idxB?.get(ib)
      if (!p1 || !p2 || p1 === p2 || p1._dead || p2._dead) continue
      // No image may be observed with two different keypoints across the union.
      let conflict = false
      for (const [uuid, kp] of p2.views) {
        if (p1.views.has(uuid) && p1.views.get(uuid) !== kp) { conflict = true; break }
      }
      if (conflict) continue
      // Every added observation must still reproject within the gate against p1.
      let ok = true
      for (const [uuid, kp] of p2.views) {
        const cam = cameras.get(uuid), kpt = keypointOf(uuid, kp)
        if (!cam || !kpt || reprojErr(cam, p1.x, p1.y, p1.z, kpt) > maxReprojPx) { ok = false; break }
      }
      if (!ok) continue
      for (const [uuid, kp] of p2.views) {
        p1.views.set(uuid, kp)
        let m = index.get(uuid); if (!m) { m = new Map(); index.set(uuid, m) }
        m.set(kp, p1)
      }
      p2._dead = true
      merged++
    }
  }
  if (!merged) return { points3d, merged }
  const out = points3d.filter((p) => !p._dead)
  for (const p of out) delete p._dead
  return { points3d: out, merged }
}

export async function reconstruct(input, hooks = {}) {
  const { images, pairs, settings = {} } = input
  const log = hooks.onLog ?? (() => {})
  const onProgress = hooks.onProgress

  const imageByUuid = (uuid) => images.find((img) => img.uuid === uuid) || null

  // Local model state (was reactive refs in the store).
  const cameras = new Map()  // uuid → { R, t, K }
  let points3d = []          // [{ x, y, z, views: Map<uuid, kpIdx> }]

  // Only 'done' pairs participate (the store passes those, but keep the guard
  // so the algorithm reads identically to the original).
  const donePairs = pairs.filter((e) => e.status === 'done')

  // Reprojection-error statistics (pixels) over every observation currently in
  // the model: project each 3D point into each camera that sees it and compare
  // to the detected keypoint. The single clearest health signal for the model.
  function modelResiduals() {
    const residuals = []
    for (const pt of points3d) {
      pt.views.forEach((kpIdx, uuid) => {
        const cam = cameras.get(uuid)
        const img = imageByUuid(uuid)
        if (!cam || !cam.K || !img) return
        const kp = img.keypoints?.[kpIdx]
        if (!kp) return
        const proj = projectPoint(cam, pt.x, pt.y, pt.z)
        if (!proj) return
        residuals.push(Math.hypot(proj.u - kp.x, proj.v - kp.y))
      })
    }
    return residuals
  }
  function modelReprojStats() {
    return numStats(modelResiduals())
  }

  // Reprojection stats for one *candidate* two-view init (its own cA/cB + points),
  // before it is committed to the model. Lets us compare seeds and pick the
  // geometrically cleanest one rather than the first that clears the parallax floor.
  function initReprojStats(init) {
    const residuals = []
    const camById = new Map([[init.entry.idA, init.cA], [init.entry.idB, init.cB]])
    for (const pt of init.points) {
      pt.views.forEach((kpIdx, uuid) => {
        const cam = camById.get(uuid)
        const img = imageByUuid(uuid)
        if (!cam || !img) return
        const kp = img.keypoints?.[kpIdx]
        if (!kp) return
        const proj = projectPoint(cam, pt.x, pt.y, pt.z)
        if (!proj) return
        residuals.push(Math.hypot(proj.u - kp.x, proj.v - kp.y))
      })
    }
    return numStats(residuals)
  }

  const t0 = performance.now()
  const stageTimes = {} // label → ms
  let stageMark = t0
  const markStage = (label) => {
    const now = performance.now()
    stageTimes[label] = now - stageMark
    stageMark = now
    log(`Reconstruction: stage "${label}" took ${(stageTimes[label]).toFixed(0)}ms`, 'debug', 'Reconstruction')
  }

  // Per-track colour: median (per channel) of the source-image RGB sampled at
  // each observing keypoint. Median (not mean) is robust to a stray observation
  // landing on a different surface. Returns null when no view carries a colour.
  const pointColor = (views) => {
    const rs = [], gs = [], bs = []
    views.forEach((kpIdx, uuid) => {
      const c = imageByUuid(uuid)?.keypoints?.[kpIdx]?.color
      if (c) { rs.push(c[0]); gs.push(c[1]); bs.push(c[2]) }
    })
    if (!rs.length) return null
    const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1] }
    return [med(rs), med(gs), med(bs)]
  }

  const done = (status, summary = null) => ({
    status,
    cameras: [...cameras.entries()].map(([uuid, cam]) => ({ uuid, ...cam })),
    points: points3d.map(({ x, y, z, views }) => ({
      x, y, z, views: [...views.entries()], color: pointColor(views),
    })),
    summary,
  })

  try {
    const imgs = images.filter((img) => img.kpStatus === 'done')
    if (imgs.length < 2) {
      log('Reconstruction: need at least 2 images with keypoints', 'warn', 'Reconstruction')
      return done('idle')
    }
    log(`Reconstruction: starting with ${imgs.length} images, ${donePairs.length} match pairs`, 'info', 'Reconstruction')

    // ── Match-graph health ───────────────────────────────────────────────────
    // SfM can only grow within a connected component. If the largest component is
    // a small fraction of the images, the rest can never register no matter how
    // good PnP is — that's a matching problem, not a reconstruction one. Sparse
    // per-image connectivity (low pairs/image) also makes the chain fragile.
    {
      const parent = new Map(imgs.map((im) => [im.uuid, im.uuid]))
      const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a) } return a }
      const deg = new Map(imgs.map((im) => [im.uuid, 0]))
      for (const e of donePairs) {
        if (!parent.has(e.idA) || !parent.has(e.idB)) continue
        deg.set(e.idA, deg.get(e.idA) + 1)
        deg.set(e.idB, deg.get(e.idB) + 1)
        parent.set(find(e.idA), find(e.idB))
      }
      const comps = new Map()
      for (const im of imgs) { const r = find(im.uuid); comps.set(r, (comps.get(r) || 0) + 1) }
      const sizes = [...comps.values()].sort((a, b) => b - a)
      const med = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[arr.length >> 1] : 0)
      const isolated = [...deg.values()].filter((d) => d === 0).length
      log(`Reconstruction: match graph — ${sizes.length} component(s), largest ${sizes[0] ?? 0}/${imgs.length} images`
        + `${isolated ? `, ${isolated} isolated` : ''}; median ${med([...deg.values()])} pairs/image, `
        + `median ${med(donePairs.map((e) => e.inlierCount))} inliers/pair`,
        (sizes[0] ?? 0) < imgs.length ? 'warn' : 'info', 'Reconstruction')
    }

    // ── Build K map ────────────────────────────────────────────────────────
    const Kmap = new Map() // uuid → K
    let defaultKCount = 0
    for (const img of imgs) {
      const K = resolveK(img.meta, img.sensor)
      Kmap.set(img.uuid, K)
      if (K.source.startsWith('default')) defaultKCount++
      const implied = K.impliedFilmWidthMm != null
        ? ` [implies ${K.impliedFilmWidthMm.toFixed(0)}mm film width]` : ''
      log(`Reconstruction: K[${img.name}] fx=${K.fx.toFixed(1)} fy=${K.fy.toFixed(1)} `
        + `cx=${K.cx.toFixed(1)} cy=${K.cy.toFixed(1)} — ${K.source}${implied}`,
        'debug', 'Reconstruction')
      // The pixel-pitch path can silently produce an off-standard film width (a
      // ~9% focal error on the CA…V set). Flag it so the user checks pitch/format.
      if (K.impliedFilmWidthMm != null && K.filmWidthOk === false) {
        log(`Reconstruction: K[${img.name}] implied film width ${K.impliedFilmWidthMm.toFixed(0)}mm `
          + `is not a standard aerial format (~230/240mm) — check the scan pixel pitch, or use the `
          + `film/sensor-format (mm) field instead of pixel size.`, 'warn', 'Reconstruction')
      }
    }
    // ── Undistort keypoints at ingest ────────────────────────────────────────
    // Remove Brown–Conrady lens distortion once, up front, so every downstream
    // step (init, PnP, triangulation, BA) is pure pinhole. Keypoint indices are
    // preserved (matches reference them), only positions move. The pairwise F used
    // for the init pair is still the distorted-space fit from matching — a slight
    // approximation the global BA corrects; everything else is exact pinhole.
    let undistortedImgs = 0
    for (const img of imgs) {
      const dist = distortionOf(img.sensor)
      if (!dist || !img.keypoints?.length) continue
      const K = Kmap.get(img.uuid)
      img.keypoints = img.keypoints.map((kp) => {
        const u = undistortPixel(kp.x, kp.y, K, dist)
        return { ...kp, x: u.x, y: u.y }
      })
      undistortedImgs++
    }
    if (undistortedImgs > 0) {
      log(`Reconstruction: undistorted keypoints on ${undistortedImgs}/${imgs.length} image(s) `
        + `(lens distortion removed at ingest — pipeline stays pinhole)`, 'info', 'Reconstruction')
    }

    if (defaultKCount > 0) {
      log(`Reconstruction: ${defaultKCount}/${imgs.length} image(s) have no focal length — using a default FOV guess. `
        + `Wrong intrinsics distort the geometry and commonly prevent cameras from registering; `
        + `supply a focal length or sensor size for reliable results.`,
        defaultKCount === imgs.length ? 'warn' : 'info', 'Reconstruction')
    }

    // Two-view initialisation for one matched pair: recover pose, triangulate,
    // and measure the median parallax angle. Returns null if it cannot init.
    // Returns { ok: false, reason } when a pair cannot initialise, or
    // { ok: true, entry, iA, iB, cA, cB, points, angle, inliers, triCount,
    //   cheiralKept } on success. The extra fields feed diagnostic logging.
    async function tryInitPair(entry) {
      const iA = imageByUuid(entry.idA)
      const iB = imageByUuid(entry.idB)
      if (!iA || !iB || !entry.F) return { ok: false, reason: 'missing image or fundamental matrix' }
      const KA = Kmap.get(entry.idA)
      const KB = Kmap.get(entry.idB)
      const E = fundamentalToEssential(entry.F, KA, KB)
      const esv = essentialSingularValues(E)
      const matches = entry.matches // [[ia, ib], ...]
      const pa = matches.map(([ia]) => iA.keypoints[ia])
      const pb = matches.map(([, ib]) => iB.keypoints[ib])
      const pose = await recoverPose(pa, pb, E, KA)
      if (!pose) return { ok: false, reason: 'pose recovery (essential decomposition) failed' }

      const cA = { R: I3, t: [0, 0, 0], K: KA }
      const cB = { R: pose.R, t: pose.t, K: KB }
      const PA = camToP34flat(cA)
      const PB = camToP34flat(cB)
      const tri = await triangulateDlt(
        pa.map((p) => toNorm(p.x, p.y, KA)),
        pb.map((p) => toNorm(p.x, p.y, KB)),
        PA, PB,
      )
      const points = []
      for (const { x, y, z, srcIdx } of tri) {
        if (projDepth(PA, x, y, z) > 0 && projDepth(PB, x, y, z) > 0) {
          const [ia, ib] = matches[srcIdx]
          points.push({ x, y, z, views: new Map([[entry.idA, ia], [entry.idB, ib]]) })
        }
      }
      const angle = medianTriangulationAngle(cA, cB, points)
      return {
        ok: true, entry, iA, iB, cA, cB, points, angle, esv,
        inliers: entry.inlierCount, triCount: tri.length, cheiralKept: points.length,
      }
    }

    // ── Select initial pair: enough inliers AND a wide-enough baseline ──────
    // Picking purely by inlier count tends to choose near-identical viewpoints
    // (tiny parallax) whose triangulated points collapse onto a line. Probe the
    // top candidates and take the first with adequate parallax.
    const { minInitInliers = 15, minInitAngleDeg = 2.0, initCandidates = 8 } = settings
    const candidates = donePairs
      .filter((e) => e.inlierCount >= minInitInliers
        && Kmap.has(e.idA) && Kmap.has(e.idB) && e.F)
      .sort((a, b) => b.inlierCount - a.inlierCount)
      .slice(0, initCandidates)

    log(`Reconstruction: ${candidates.length} init candidate(s) of ${donePairs.length} done pairs `
      + `(≥${minInitInliers} inliers, need ≥${minInitAngleDeg}° parallax)`, 'info', 'Reconstruction')

    if (candidates.length === 0) {
      log('Reconstruction: no valid matched pair found — check inlier counts and metadata', 'warn', 'Reconstruction')
      return done('idle')
    }

    // Probe *every* candidate (don't stop at the first adequate one) so we can both
    // log the full table and pick the geometrically cleanest seed. A seed's init
    // reprojection is the single best predictor of how well the model will grow:
    // a wide-baseline, low-reprojection pair gives clean 3D points that PnP can
    // then register against. Picking the first pair over the parallax floor — as
    // before — often locks in a noisy seed that stalls registration.
    const viable = []
    for (const entry of candidates) {
      const init = await tryInitPair(entry)
      const nameA = imageByUuid(entry.idA)?.name ?? entry.idA
      const nameB = imageByUuid(entry.idB)?.name ?? entry.idB
      if (!init.ok) {
        log(`Reconstruction: candidate ${nameA} ↔ ${nameB} rejected — ${init.reason}`, 'debug', 'Reconstruction')
        continue
      }
      // Cheirality survival = how many triangulated points are in front of both
      // cameras. A low ratio almost always means the recovered pose is wrong.
      const kept = init.cheiralKept, tri = init.triCount
      const pct = tri ? (100 * kept / tri).toFixed(0) : '0'
      if (kept < 10) {
        log(`Reconstruction: candidate ${nameA} ↔ ${nameB} rejected — only ${kept}/${tri} pts `
          + `survived cheirality (${pct}%), need ≥10`, 'debug', 'Reconstruction')
        continue
      }
      init.reproj = initReprojStats(init)
      init.nameA = nameA
      init.nameB = nameB
      const candRatio = init.esv.s1 > 0 ? init.esv.s2 / init.esv.s1 : 0
      log(`Reconstruction: candidate ${nameA} ↔ ${nameB} — ${init.inliers} inliers, `
        + `${kept}/${tri} pts kept after cheirality (${pct}%), median parallax ${init.angle.toFixed(2)}°, `
        + `init reproj median ${init.reproj.median.toFixed(2)}px, E σ2/σ1 ${candRatio.toFixed(2)}`,
        'debug', 'Reconstruction')
      viable.push(init)
    }

    // Per-pair init reprojection (for the run summary / cross-run comparison).
    const perPairInitReproj = viable.map((v) => ({
      pair: `${v.nameA} ↔ ${v.nameB}`,
      medianPx: v.reproj.median,
      parallaxDeg: v.angle,
    }))

    // Among candidates clearing the parallax floor, take the lowest-reprojection
    // seed. If none clear it, fall back to the widest baseline available.
    const adequate = viable.filter((v) => v.angle >= minInitAngleDeg)
    let best = null
    if (adequate.length) {
      best = adequate.reduce((a, b) => (b.reproj.median < a.reproj.median ? b : a))
      log(`Reconstruction: selected seed ${best.nameA} ↔ ${best.nameB} of ${adequate.length} `
        + `pair(s) over ${minInitAngleDeg}° parallax (lowest init reproj, median ${best.reproj.median.toFixed(2)}px)`,
        'info', 'Reconstruction')
    } else if (viable.length) {
      best = viable.reduce((a, b) => (b.angle > a.angle ? b : a))
    }

    if (!best) {
      log('Reconstruction: pose recovery failed for all candidate pairs '
        + '(toggle "Detail" in the console to see per-candidate reasons)', 'error', 'Reconstruction')
      return done('error')
    }
    if (best.angle < minInitAngleDeg) {
      log(`Reconstruction: best initial parallax is only ${best.angle.toFixed(2)}° `
        + `(< ${minInitAngleDeg}°) — the sparse cloud may look flat/linear`, 'warn', 'Reconstruction')
    }

    const bestPair = best.entry
    const imgA = best.iA
    const imgB = best.iB
    cameras.set(bestPair.idA, best.cA)
    cameras.set(bestPair.idB, best.cB)
    points3d = best.points

    log(`Reconstruction: initial pair ${imgA.name} ↔ ${imgB.name} `
      + `(${best.inliers} inliers, ${best.points.length} pts, ${best.angle.toFixed(2)}° parallax)`,
      'success', 'Reconstruction')
    log(`Reconstruction: init reprojection — ${fmtStats(modelReprojStats())}`, 'debug', 'Reconstruction')
    // Essential-matrix conditioning: σ2/σ1 ≈ 1 for a valid E. A low ratio means
    // F→E used wrong intrinsics, which inflates init reprojection and typically
    // blocks PnP registration of otherwise well-connected images.
    {
      const { s1, s2, s3 } = best.esv
      const ratio = s1 > 0 ? s2 / s1 : 0
      log(`Reconstruction: essential matrix σ = [${s1.toFixed(3)}, ${s2.toFixed(3)}, ${s3.toFixed(3)}] — `
        + `σ2/σ1 ${ratio.toFixed(2)} (ideal ≈ 1.0; well below 1 points to a wrong focal length / intrinsics)`,
        ratio < 0.7 ? 'warn' : 'debug', 'Reconstruction')
    }
    markStage('init')
    onProgress?.(1, imgs.length, `Initial pair: ${imgA.name} ↔ ${imgB.name}`)

    // ── Track index ──────────────────────────────────────────────────────────
    // Reverse map keypoint → 3D point, per image: viewIndex[uuid].get(kpIdx) → pt.
    // This is what makes tracks (rather than a heap of 2-view points) possible:
    // it lets registration ask "does this keypoint already belong to a point?" in
    // O(1) and either extend that track or know to triangulate fresh structure.
    // Every observation must go through addView so the index stays consistent.
    const viewIndex = new Map() // uuid → Map<kpIdx, pt>
    const addView = (pt, uuid, kpIdx) => {
      pt.views.set(uuid, kpIdx)
      let m = viewIndex.get(uuid)
      if (!m) { m = new Map(); viewIndex.set(uuid, m) }
      m.set(kpIdx, pt)
    }
    // Seed the index from the committed initial pair.
    for (const pt of points3d) pt.views.forEach((kpIdx, uuid) => {
      let m = viewIndex.get(uuid)
      if (!m) { m = new Map(); viewIndex.set(uuid, m) }
      m.set(kpIdx, pt)
    })

    // ── Incremental registration ───────────────────────────────────────────
    // `reprjThreshold` is the *target* PnP inlier gate, but a fixed pixel gate
    // tighter than the model's own reprojection error rejects every otherwise-good
    // pose — you can't fit new observations to within 4px when the existing points
    // already sit at ~10px. So the gate adapts per pass to the current model
    // (p95 reprojection), clamped to [reprjThreshold, reprjThreshold·maxGateScale].
    // This lets registration proceed on a noisy seed; the final bundle adjust
    // tightens everything afterwards. As the seed improves the gate self-tightens.
    const { minMatchesForRegistration = 12, reprjThreshold = 4.0, maxGateScale = 8 } = settings
    const registeredUuids = new Set([bestPair.idA, bestPair.idB])

    // Total inliers linking `uuid` to the already-registered set (ordering heuristic).
    function countMatchesToRegistered(uuid) {
      let count = 0
      for (const e of donePairs) {
        const other = e.idA === uuid ? e.idB : e.idB === uuid ? e.idA : null
        if (other && registeredUuids.has(other)) count += e.inlierCount
      }
      return count
    }

    // Gather 2D-3D correspondences between an unregistered image and the model:
    // for each match to a registered image, look up (via the index) the 3D point
    // that registered keypoint already belongs to. Deduped to one observation per
    // point; if the same point is reached with conflicting keypoints (an ambiguous
    // match), it is dropped rather than risk a bad correspondence. Returns the new
    // image's keypoint index per correspondence too, so successful matches can
    // *extend* the track after PnP confirms the pose.
    function collectCorrespondences(img) {
      const byPoint = new Map()    // pt → newIdx
      const conflicted = new Set() // pts reached with inconsistent newIdx
      for (const entry of donePairs) {
        let regUuid = null
        if (entry.idA === img.uuid && registeredUuids.has(entry.idB)) regUuid = entry.idB
        else if (entry.idB === img.uuid && registeredUuids.has(entry.idA)) regUuid = entry.idA
        else continue
        const regMap = viewIndex.get(regUuid)
        if (!regMap) continue
        const imgIsA = entry.idA === img.uuid
        for (const [ia, ib] of entry.matches) {
          const newIdx = imgIsA ? ia : ib
          const regIdx = imgIsA ? ib : ia
          const pt = regMap.get(regIdx)
          if (!pt) continue
          if (byPoint.has(pt) && byPoint.get(pt) !== newIdx) conflicted.add(pt)
          else byPoint.set(pt, newIdx)
        }
      }
      for (const pt of conflicted) byPoint.delete(pt)
      const pts3 = []; const pts2 = []; const newIdx = []
      for (const [pt, idx] of byPoint) {
        const kp = img.keypoints[idx]
        if (!kp) continue
        pts3.push(pt); pts2.push({ x: kp.x, y: kp.y }); newIdx.push(idx)
      }
      return { pts3, pts2, newIdx }
    }

    // Repeatedly sweep the unregistered images; each newly-registered camera adds
    // points that may let previously-deferred images register on the next pass.
    // Stop when a full pass registers nothing new.
    const deferReasons = new Map() // uuid → last reason it failed to register
    let progressed = true
    let pass = 0
    while (progressed) {
      progressed = false
      pass++
      const remaining = imgs
        .filter((img) => !registeredUuids.has(img.uuid))
        .sort((a, b) => countMatchesToRegistered(b.uuid) - countMatchesToRegistered(a.uuid))

      // Adaptive PnP gate for this pass, driven by the current model's spread.
      const modelStats = modelReprojStats()
      const pnpThresh = Math.min(
        reprjThreshold * maxGateScale,
        Math.max(reprjThreshold, modelStats.p95 || reprjThreshold),
      )
      log(`Reconstruction: registration pass ${pass} — ${remaining.length} image(s) remaining `
        + `(PnP gate ${pnpThresh.toFixed(1)}px, model p95 ${modelStats.p95.toFixed(1)}px)`, 'debug', 'Reconstruction')

      for (const img of remaining) {
        const K = Kmap.get(img.uuid)
        const { pts3, pts2, newIdx } = collectCorrespondences(img)
        if (pts3.length < minMatchesForRegistration) {
          const reason = `too few correspondences (${pts3.length}/${minMatchesForRegistration})`
          deferReasons.set(img.uuid, reason)
          log(`Reconstruction: defer ${img.name} — ${reason}`, 'debug', 'Reconstruction')
          continue
        }

        onProgress?.(cameras.size, imgs.length, `Registering ${img.name} (${pts3.length} correspondences)`)
        const pnp = await solvePnp(pts3, pts2, K, { ransacThreshPx: pnpThresh, maxIters: 200 })
        if (!pnp) {
          // Diagnostic: the solver returns nothing when it can't gather ≥6 inliers
          // at the gate. Re-probe at looser thresholds — if a 2×/4× gate suddenly
          // finds inliers, the pose is recoverable and the model points are just
          // noisier than the gate (improve the seed / raise maxGateScale). If even
          // 4× finds nothing, the correspondences themselves are wrong.
          const probe = []
          for (const thr of [pnpThresh * 2, pnpThresh * 4]) {
            const p = await solvePnp(pts3, pts2, K, { ransacThreshPx: thr, maxIters: 200 })
            const ic = p ? p.inlierMask.filter((v) => v > 0.5).length : 0
            probe.push(`${ic}/${pts3.length}@${thr.toFixed(0)}px`)
          }
          const reason = `PnP solve failed (${pts3.length} correspondences, gate ${pnpThresh.toFixed(1)}px; `
            + `at looser gates: ${probe.join(', ')})`
          deferReasons.set(img.uuid, reason)
          log(`Reconstruction: ${reason} for ${img.name}`, 'warn', 'Reconstruction')
          continue
        }
        const inlierCount = pnp.inlierMask.filter((v) => v > 0.5).length
        if (inlierCount < 6) {
          const reason = `too few PnP inliers (${inlierCount}/${pts3.length}, gate ${pnpThresh.toFixed(1)}px)`
          deferReasons.set(img.uuid, reason)
          log(`Reconstruction: ${reason} for ${img.name}`, 'warn', 'Reconstruction')
          continue
        }

        const newCam = { R: pnp.R, t: pnp.t, K }
        cameras.set(img.uuid, newCam)
        registeredUuids.add(img.uuid)
        deferReasons.delete(img.uuid)
        progressed = true

        // Reprojection error over the PnP inliers — how well this pose fits.
        const inlierResid = []
        for (let i = 0; i < pts3.length; i++) {
          if (!(pnp.inlierMask[i] > 0.5)) continue
          const proj = projectPoint(newCam, pts3[i].x, pts3[i].y, pts3[i].z)
          if (proj) inlierResid.push(Math.hypot(proj.u - pts2[i].x, proj.v - pts2[i].y))
        }
        const rs = numStats(inlierResid)
        log(`Reconstruction: registered ${img.name} (${inlierCount}/${pts3.length} PnP inliers, `
          + `inlier reproj mean ${rs.mean.toFixed(2)}px / median ${rs.median.toFixed(2)}px)`, 'success', 'Reconstruction')

        // Extend existing tracks: every inlier correspondence is this image observing
        // a point already in the model. Recording that observation grows the track to
        // 3+ views (a far stronger constraint for BA) instead of the triangulation
        // step below spawning yet another fragile 2-view duplicate of the same point.
        let extended = 0
        const usedNewIdx = new Set()
        for (let i = 0; i < pts3.length; i++) {
          if (!(pnp.inlierMask[i] > 0.5)) continue
          const pt = pts3[i]
          if (pt.views.has(img.uuid) || usedNewIdx.has(newIdx[i])) continue
          addView(pt, img.uuid, newIdx[i])
          usedNewIdx.add(newIdx[i])
          extended++
        }

        // Triangulate fresh points between the new camera and each registered neighbour.
        const Pnew = camToP34flat(newCam)
        let added = 0
        let triTotal = 0    // triangulated before cheirality
        for (const entry of donePairs) {
          let regUuid = null
          if (entry.idA === img.uuid && registeredUuids.has(entry.idB) && entry.idB !== img.uuid) regUuid = entry.idB
          else if (entry.idB === img.uuid && registeredUuids.has(entry.idA) && entry.idA !== img.uuid) regUuid = entry.idA
          else continue

          const regCam = cameras.get(regUuid)
          const regImg = imageByUuid(regUuid)
          if (!regCam || !regImg) continue
          const Preg = camToP34flat(regCam)
          const imgIsA = entry.idA === img.uuid
          const newMap = viewIndex.get(img.uuid)
          const regMap = viewIndex.get(regUuid)

          // Only triangulate genuinely new structure: matches where *neither*
          // endpoint already belongs to a track. Matches that touch an existing
          // track were handled by the extension step above (when the pose agreed)
          // or are PnP outliers we deliberately don't fold in — re-triangulating
          // them would just create a duplicate point.
          const pairsToTri = entry.matches.filter(([ia, ib]) => {
            const newKp = imgIsA ? ia : ib
            const regKp = imgIsA ? ib : ia
            if (newMap && newMap.has(newKp)) return false
            if (regMap && regMap.has(regKp)) return false
            return true
          })
          if (pairsToTri.length === 0) continue

          // nNew ↔ Pnew (the new image), nReg ↔ Preg (the registered image).
          const nNew = pairsToTri.map(([ia, ib]) => {
            const kp = img.keypoints[imgIsA ? ia : ib]
            return toNorm(kp.x, kp.y, K)
          })
          const nReg = pairsToTri.map(([ia, ib]) => {
            const kp = regImg.keypoints[imgIsA ? ib : ia]
            return toNorm(kp.x, kp.y, regCam.K)
          })

          const newTri = await triangulateDlt(nNew, nReg, Pnew, Preg)
          triTotal += newTri.length
          for (const { x, y, z, srcIdx } of newTri) {
            if (projDepth(Pnew, x, y, z) > 0 && projDepth(Preg, x, y, z) > 0) {
              const [ia, ib] = pairsToTri[srcIdx]
              const newKp = imgIsA ? ia : ib
              const regKp = imgIsA ? ib : ia
              // A keypoint can recur across this image's pairs; guard against the
              // live index so the same observation never lands in two different
              // points within one pass (the captured maps may be stale after adds).
              if (viewIndex.get(img.uuid)?.has(newKp) || viewIndex.get(regUuid)?.has(regKp)) continue
              const pt = { x, y, z, views: new Map() }
              addView(pt, img.uuid, newKp)
              addView(pt, regUuid, regKp)
              points3d.push(pt)
              added++
            }
          }
        }
        const pct = triTotal ? (100 * added / triTotal).toFixed(0) : '0'
        log(`Reconstruction: ${img.name} — extended ${extended} track(s), `
          + `+${added} new points (${added}/${triTotal} survived cheirality, ${pct}%)`, 'debug', 'Reconstruction')
      }
    }

    // Report any images that never registered, with the reason they last failed
    // AND their verified-pair connectivity. This distinguishes the two root causes:
    //   • many verified pairs but only to OTHER unregistered images → an isolated
    //     block the chain never bootstrapped (loop-closure / seam matching gap);
    //   • few verified pairs total → genuine low overlap or matcher rejected them
    //     (loosen ratio / verification threshold / min-matches).
    const unregistered = imgs.filter((img) => !registeredUuids.has(img.uuid))
    if (unregistered.length) {
      log(`Reconstruction: ${unregistered.length} image(s) never registered:`, 'warn', 'Reconstruction')
      for (const img of unregistered) {
        let regLinks = 0, regInliers = 0, unregLinks = 0
        for (const e of donePairs) {
          const other = e.idA === img.uuid ? e.idB : e.idB === img.uuid ? e.idA : null
          if (!other || !(e.inlierCount > 0)) continue
          if (registeredUuids.has(other)) { regLinks++; regInliers += e.inlierCount }
          else unregLinks++
        }
        log(`Reconstruction:   • ${img.name} — ${deferReasons.get(img.uuid) ?? 'no link to the model'} `
          + `[verified pairs: ${regLinks} to registered (${regInliers} inliers), ${unregLinks} to unregistered]`,
          'warn', 'Reconstruction')
      }
    }

    log(`Reconstruction: ${cameras.size}/${imgs.length} cameras registered, ${points3d.length} points`, 'info', 'Reconstruction')
    const preBaStats = modelReprojStats()
    log(`Reconstruction: pre-BA reprojection — ${fmtStats(preBaStats)}`, 'info', 'Reconstruction')
    markStage('registration')

    // ── Bundle adjustment + track filtering (Phase 2 + 3) ────────────────────
    const {
      baIterations = 30,
      filterMaxReprojPx = 4.0,   // observation pruning threshold (px)
      filterMinTriAngleDeg = 1.5, // drop points whose rays are too parallel
      refineIntrinsics = 'none', // self-calibration: 'none' | 'f' | 'f,cxcy'
    } = settings

    // Map each image's sensor to a stable integer so BA can share one focal across
    // all cameras on the same sensor. Images without an assigned sensor get their
    // own group (−1 sentinel below); reconstruction still runs pinhole otherwise.
    const sensorIntByUuid = new Map()
    {
      const idToInt = new Map()
      for (const img of imgs) {
        const sid = img.sensorId ?? null
        if (sid == null) { sensorIntByUuid.set(img.uuid, -1); continue }
        if (!idToInt.has(sid)) idToInt.set(sid, idToInt.size)
        sensorIntByUuid.set(img.uuid, idToInt.get(sid))
      }
    }

    // Run one global bundle adjustment, apply it (guarded: never commit a result
    // that worsens the cost), and log RMS / convergence trace. Reused for the
    // initial solve and each post-filter re-solve.
    async function runBundleAdjust(label, iters) {
      if (!(cameras.size >= 2 && points3d.length >= 10 && iters > 0)) {
        log(`Reconstruction: ${label} skipped (cameras=${cameras.size}, `
          + `points=${points3d.length}, iters=${iters})`, 'debug', 'Reconstruction')
        return
      }
      const uuidList = [...cameras.keys()]
      const camList  = uuidList.map((u) => cameras.get(u))
      const kList    = camList.map((c) => c.K)
      const sensorOfCam = uuidList.map((u) => sensorIntByUuid.get(u) ?? -1)

      const observations = []
      points3d.forEach((pt, pi) => {
        pt.views.forEach((kpIdx, uuid) => {
          const ci = uuidList.indexOf(uuid)
          const img = imageByUuid(uuid)
          if (ci === -1 || !img) return
          const kp = img.keypoints[kpIdx]
          if (kp) observations.push({ camIdx: ci, ptIdx: pi, x: kp.x, y: kp.y })
        })
      })
      log(`Reconstruction: ${label} — ${camList.length} cameras, ${points3d.length} points, `
        + `${observations.length} observations, ${iters} iters`, 'info', 'Reconstruction')

      const result = await bundleAdjust(camList, kList, points3d, observations,
        { maxIters: iters, refineIntrinsics, sensorOfCam })
      if (!result) {
        log(`Reconstruction: ${label} returned no result (skipped)`, 'warn', 'Reconstruction')
        return
      }
      // A correct bundle adjustment can only lower the cost; reject a worsening
      // result rather than commit a diverged model. But a fully converged model
      // can tick up by a float epsilon on a no-op re-solve — that's convergence,
      // not divergence, so don't cry wolf (< 0.01px is below any real-world
      // meaning). Only warn + reject when the cost genuinely grows (≥ 0.01px).
      if (result.costBefore != null && result.costAfter != null && result.costAfter > result.costBefore) {
        const delta = result.costAfter - result.costBefore
        if (delta < 0.01) {
          log(`Reconstruction: ${label} already converged (RMS ${result.costBefore.toFixed(2)}px unchanged); `
            + `keeping the pre-BA estimate`, 'debug', 'Reconstruction')
        } else {
          log(`Reconstruction: ${label} REJECTED — RMS ${result.costBefore.toFixed(2)}px → `
            + `${result.costAfter.toFixed(2)}px would worsen the model; keeping the pre-BA estimate`,
            'warn', 'Reconstruction')
        }
        return
      }
      uuidList.forEach((uuid, ci) => {
        const old = cameras.get(uuid)
        // Merge refined intrinsics into K (keeps impliedFilmWidthMm / source meta)
        // so subsequent BA passes and reprojection stats use the calibrated focal.
        const K = refineIntrinsics !== 'none' && result.intrinsics
          ? { ...old.K, ...result.intrinsics[ci] }
          : old.K
        cameras.set(uuid, { ...old, ...result.cameras[ci], K })
      })
      points3d = result.points3d.map((pt, i) => ({ ...pt, views: points3d[i].views }))

      // Self-calibration report: one line per sensor group (before → after focal +
      // the implied film width, tying back to the Q4 sanity check). Never written
      // back to the sensor table — the user decides whether to adopt it.
      if (refineIntrinsics !== 'none' && result.intrinsics) {
        const seen = new Set()
        uuidList.forEach((uuid, ci) => {
          const g = sensorOfCam[ci]
          if (g < 0 || seen.has(g)) return
          seen.add(g)
          const fx0 = kList[ci].fx, fx1 = result.intrinsics[ci].fx
          const pct = fx0 ? (100 * (fx1 - fx0) / fx0) : 0
          let implied = ''
          const w0 = kList[ci].impliedFilmWidthMm
          if (w0 != null && fx1) implied = `, implied film width ${w0.toFixed(0)}mm → ${(w0 * fx0 / fx1).toFixed(0)}mm`
          const cxcy = refineIntrinsics === 'f,cxcy'
            ? `, cx ${kList[ci].cx.toFixed(1)}→${result.intrinsics[ci].cx.toFixed(1)}, `
              + `cy ${kList[ci].cy.toFixed(1)}→${result.intrinsics[ci].cy.toFixed(1)}` : ''
          log(`Reconstruction: ${label} self-calibration — sensor group ${g}: `
            + `fx ${fx0.toFixed(1)} → ${fx1.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)${cxcy}${implied}`,
            'info', 'Reconstruction')
        })
        log(`Reconstruction: ${label} self-calibration is weakly observed on short/single strips `
          + `(needs ≥2° tilt variation for a trustworthy focal); review before updating the sensor table.`,
          'debug', 'Reconstruction')
      }
      if (result.costBefore != null && result.costAfter != null) {
        log(`Reconstruction: ${label} RMS ${result.costBefore.toFixed(2)}px → ${result.costAfter.toFixed(2)}px `
          + `(−${Math.abs(result.costBefore - result.costAfter).toFixed(2)}px)`, 'success', 'Reconstruction')
      }
      const trace = result.costTrace ?? []
      if (trace.length >= 2) {
        const fmtTrace = trace.length <= 8
          ? trace.map((c) => c.toFixed(1))
          : [...trace.slice(0, 3), '…', ...trace.slice(-3)].map((c) => typeof c === 'number' ? c.toFixed(1) : c)
        const last = trace[trace.length - 1], prev = trace[trace.length - 2]
        const lastDrop = prev > 0 ? (prev - last) / prev : 0
        const verdict = lastDrop > 0.02
          ? `still descending (${(lastDrop * 100).toFixed(1)}% on last iter — raising baIterations may help)`
          : `plateaued (converged in ${trace.length} iter)`
        log(`Reconstruction: ${label} convergence (RMS px) — ${fmtTrace.join(' → ')}; ${verdict}`,
          'debug', 'Reconstruction')
      }
      log(`Reconstruction: ${label} reprojection — ${fmtStats(modelReprojStats())}`, 'info', 'Reconstruction')
    }

    // What fraction of observations are still gross outliers (the junk tracks BA
    // can only down-weight, not delete). Logged before/after filtering.
    const logOutlierShare = (label) => {
      const resid = modelResiduals()
      const nr = resid.length || 1
      log(`Reconstruction: ${label} — ${(100 * resid.filter((r) => r > 5).length / nr).toFixed(1)}% obs over 5px, `
        + `${(100 * resid.filter((r) => r > 20).length / nr).toFixed(1)}% over 20px`, 'info', 'Reconstruction')
    }

    // Track filtering: remove the fragile/outlier geometry that BA can only
    // down-weight. Prunes individual observations behind the camera or beyond
    // maxReprojPx, then drops points left under-supported (<2 views) or whose
    // viewing rays are too parallel to triangulate stably (< minTriAngleDeg).
    function filterTracks({ maxReprojPx, minTriAngleDeg }) {
      let obsRemoved = 0, ptsRemoved = 0
      const kept = []
      for (const pt of points3d) {
        for (const [uuid, kpIdx] of [...pt.views]) {
          const cam = cameras.get(uuid)
          const kp = imageByUuid(uuid)?.keypoints?.[kpIdx]
          if (!cam || !kp) { pt.views.delete(uuid); obsRemoved++; continue }
          // Cheirality: point must be in front of the camera.
          const zc = cam.R[2][0] * pt.x + cam.R[2][1] * pt.y + cam.R[2][2] * pt.z + cam.t[2]
          const proj = zc > 0 ? projectPoint(cam, pt.x, pt.y, pt.z) : null
          if (!proj || Math.hypot(proj.u - kp.x, proj.v - kp.y) > maxReprojPx) {
            pt.views.delete(uuid); obsRemoved++
          }
        }
        if (pt.views.size < 2) { ptsRemoved++; continue }
        // Max parallax angle between any two surviving rays.
        const cs = [...pt.views.keys()].map((u) => cameras.get(u)).filter(Boolean)
        let maxAng = 0
        for (let i = 0; i < cs.length; i++)
          for (let j = i + 1; j < cs.length; j++)
            maxAng = Math.max(maxAng, medianTriangulationAngle(cs[i], cs[j], [pt]))
        if (maxAng < minTriAngleDeg) { ptsRemoved++; continue }
        kept.push(pt)
      }
      points3d = kept
      return { obsRemoved, ptsRemoved }
    }

    // Track-length histogram { t2, t3, t4 } (2-view / 3-view / 4+-view counts).
    const trackHist = () => {
      let t2 = 0, t3 = 0, t4 = 0
      for (const pt of points3d) { const n = pt.views.size; if (n <= 2) t2++; else if (n === 3) t3++; else t4++ }
      return { t2, t3, t4 }
    }

    // Retriangulation + track merging run through the pure, unit-tested module
    // functions below (`retriangulatePairs`, `mergeSplitTracks`); the closure just
    // supplies this run's keypoint lookup + the WASM triangulator.
    const keypointOf = (uuid, kpIdx) => imageByUuid(uuid)?.keypoints?.[kpIdx] ?? null

    if (cameras.size >= 2 && points3d.length >= 10 && baIterations > 0) {
      onProgress?.(imgs.length - 1, imgs.length, 'Bundle adjustment…')

      await runBundleAdjust('bundle adjustment', baIterations)
      logOutlierShare('pre-filter residuals')

      // A3: retriangulate missed matches + merge split tracks under the improved
      // poses, then one more BA so the new/merged structure settles jointly.
      {
        const before = trackHist()
        const { added } = await retriangulatePairs({
          points3d, cameras, pairs: donePairs, keypointOf,
          maxReprojPx: filterMaxReprojPx, triangulate: triangulateDlt,
        })
        const mres = mergeSplitTracks({ points3d, cameras, pairs: donePairs, keypointOf, maxReprojPx: filterMaxReprojPx })
        points3d = mres.points3d
        const merged = mres.merged
        if (added || merged) {
          const after = trackHist()
          log(`Reconstruction: retriangulation +${added} point(s), merged ${merged} split track(s); `
            + `${points3d.length} points`, 'info', 'Reconstruction')
          log(`Reconstruction: track lengths (2/3/4+ view) ${before.t2}/${before.t3}/${before.t4} → `
            + `${after.t2}/${after.t3}/${after.t4}`, 'info', 'Reconstruction')
          await runBundleAdjust('post-retriangulation bundle adjustment', baIterations)
        } else {
          log('Reconstruction: retriangulation found no missed structure', 'debug', 'Reconstruction')
        }
      }

      // Filter → re-BA, twice: a generous pass to strip gross junk, then a tighter
      // pass once the model has settled. Each re-solve runs on the cleaned set.
      for (const [round, maxPx] of [[1, filterMaxReprojPx * 2], [2, filterMaxReprojPx]]) {
        const { obsRemoved, ptsRemoved } = filterTracks({ maxReprojPx: maxPx, minTriAngleDeg: filterMinTriAngleDeg })
        log(`Reconstruction: track filter pass ${round} (≤${maxPx.toFixed(1)}px, ≥${filterMinTriAngleDeg}° parallax) — `
          + `removed ${obsRemoved} obs + ${ptsRemoved} points; ${points3d.length} points remain`, 'info', 'Reconstruction')
        await runBundleAdjust(`post-filter bundle adjustment ${round}`, baIterations)
      }
      logOutlierShare('post-filter residuals')
      log('Reconstruction: bundle adjustment + filtering complete', 'success', 'Reconstruction')
    } else {
      log(`Reconstruction: bundle adjustment skipped (cameras=${cameras.size}, `
        + `points=${points3d.length}, iters=${baIterations})`, 'debug', 'Reconstruction')
    }
    markStage('bundleAdjust')

    // Track-length histogram: points seen by only 2 images are the fragile ones;
    // a model dominated by 2-view tracks is weakly constrained.
    const { t2: tracks2, t3: tracks3, t4: tracks4 } = trackHist()
    const totalMs = performance.now() - t0
    log(`Reconstruction: track lengths — ${tracks2} ×2-view, ${tracks3} ×3-view, ${tracks4} ×4+-view`, 'info', 'Reconstruction')
    log(`Reconstruction: total time ${(totalMs / 1000).toFixed(1)}s `
      + `(${Object.entries(stageTimes).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ')})`, 'info', 'Reconstruction')

    // Q3: persistable run summary so successive runs are honestly comparable
    // ("did it improve" becomes a number, not a feeling). Persisted next to
    // georef in reconstruction.json by the store.
    const finalStats = modelReprojStats()
    const nPoints = points3d.length
    const pct3plusViewTracks = nPoints ? (100 * (tracks3 + tracks4) / nPoints) : 0
    const summary = {
      date: new Date().toISOString(),
      nCameras: cameras.size,
      nPoints,
      pct3plusViewTracks,
      preBaP95px: preBaStats.p95,
      postBaMedianPx: finalStats.median,
      perPairInitReproj,
    }

    onProgress?.(imgs.length, imgs.length, 'Done')
    log(`Reconstruction complete: ${cameras.size} cameras, ${points3d.length} points, `
      + `final reprojection ${fmtStats(finalStats)}`, 'success', 'Reconstruction')
    log(`Reconstruction summary: ${summary.nCameras} cameras, ${summary.nPoints} points, `
      + `${pct3plusViewTracks.toFixed(1)}% ≥3-view tracks, pre-BA p95 ${preBaStats.p95.toFixed(1)}px, `
      + `post-BA median ${finalStats.median.toFixed(2)}px`, 'success', 'Reconstruction')
    return done('done', summary)
  } catch (err) {
    log(`Reconstruction error: ${err?.message ?? err}`, 'error', 'Reconstruction')
    return done('error')
  }
}

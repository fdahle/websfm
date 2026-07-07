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
  resolveK, fundamentalToEssential,
  recoverPose, triangulateDlt, solvePnp, bundleAdjust,
} from './reconstruction.js'
import { projectPoint, medianTriangulationAngle } from './geometry.js'
import { undistortPixel, distortionOf } from './distortion.js'
import { rotationCycleFilter } from './cycleFilter.js'
import { toNorm, camToP34flat, reprojErr, retriangulatePairs, mergeSplitTracks } from './tracks.js'
import { selectInitPair } from './initPair.js'

// Re-export the extracted pure modules so existing importers (sfm.test.js and any
// others that reached for these through sfm.js) keep working unchanged.
export { rotationCycleFilter, retriangulatePairs, mergeSplitTracks }

// ── Geometry helpers ────────────────────────────────────────────────────────────
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

export async function reconstruct(input, hooks = {}) {
  const { images, pairs, settings = {} } = input
  const log = hooks.onLog ?? (() => {})
  const onProgress = hooks.onProgress

  const imageByUuid = (uuid) => images.find((img) => img.uuid === uuid) || null

  // Local model state (was reactive refs in the store).
  const cameras = new Map()  // uuid → { R, t, K }
  let points3d = []          // [{ x, y, z, views: Map<uuid, kpIdx> }]

  // Only 'done' pairs participate (the store passes those, but keep the guard
  // so the algorithm reads identically to the original). Not const: the
  // rotation-cycle filter (below) prunes cycle-inconsistent pairs before SfM.
  let donePairs = pairs.filter((e) => e.status === 'done')

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

    // ── Rotation-cycle consistency filter ────────────────────────────────────
    // Drop verified-but-false pairs (spurious epipolar fits on repetitive
    // structure) that no count/ratio gate can catch: their relative rotation is
    // inconsistent with the rest of the match graph. See rotationCycleFilter.
    if (settings.rotationCycleFilter !== false && donePairs.length >= 3) {
      // Relative rotation R (idA→idB) per pair, via essential decomposition. The
      // pose args only disambiguate the cheirality branch, so post-undistort vs
      // raw keypoints barely shift R — F/K drive it. Skip pairs without an F.
      const relRot = async (e) => {
        if (!e.F) return null
        const iA = imageByUuid(e.idA), iB = imageByUuid(e.idB)
        if (!iA || !iB) return null
        const E = fundamentalToEssential(e.F, Kmap.get(e.idA), Kmap.get(e.idB))
        const pose = await recoverPose(
          e.matches.map(([ia]) => iA.keypoints[ia]),
          e.matches.map(([, ib]) => iB.keypoints[ib]),
          E, Kmap.get(e.idA),
        )
        return pose ? pose.R : null
      }
      const Rs = await Promise.all(donePairs.map(relRot))
      const { drop } = rotationCycleFilter(
        donePairs.map((e, i) => ({ idA: e.idA, idB: e.idB, R: Rs[i] })),
        {
          cycleErrorDeg: settings.cycleErrorDeg,
          minTriangles: settings.cycleMinTriangles,
          minSupport: settings.cycleMinSupport,
        },
      )
      if (drop.length) {
        const nm = (u) => imageByUuid(u)?.name ?? u
        const pk = (a, b) => (a < b ? `${a}--${b}` : `${b}--${a}`)
        const rm = new Set(drop.map((d) => pk(d.idA, d.idB)))
        const needSupport = settings.cycleMinSupport ?? 0.3
        for (const d of drop) {
          log(`Reconstruction: rotation-cycle filter dropped ${nm(d.idA)} ↔ ${nm(d.idB)} — `
            + `cycle-consistent in only ${d.good}/${d.tri} triangles `
            + `(${(100 * d.ratio).toFixed(0)}%, need ≥${(100 * needSupport).toFixed(0)}%) — `
            + `likely false match on repetitive structure`, 'warn', 'Reconstruction')
        }
        donePairs = donePairs.filter((e) => !rm.has(pk(e.idA, e.idB)))
        log(`Reconstruction: rotation-cycle filter removed ${drop.length} inconsistent pair(s); `
          + `${donePairs.length} verified pair(s) remain`, 'info', 'Reconstruction')
      } else {
        log('Reconstruction: rotation-cycle filter — all pairs cycle-consistent', 'debug', 'Reconstruction')
      }
    }

    // Two-view initialisation + seed selection lives in initPair.js. It probes
    // every candidate (pose recovery + triangulation + cheirality + init reproj)
    // and returns the geometrically cleanest seed; the reconstruct-local helpers
    // it needs are injected so it stays pure (no cycle back into this file).
    const initSel = await selectInitPair(
      { donePairs, Kmap, settings, imageByUuid, numStats, projDepth },
      { onLog: log },
    )
    if (initSel.status !== 'ok') return done(initSel.status)
    const { best, perPairInitReproj } = initSel

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

    // Rebuild the whole keypoint→point index from the current tracks. Interim
    // bundle adjustment (R3) replaces every point *object* (BA returns fresh
    // structs), so the index — which holds references to the old objects — must be
    // regenerated before registration continues against the tightened model.
    const rebuildViewIndex = () => {
      viewIndex.clear()
      for (const pt of points3d) pt.views.forEach((kpIdx, uuid) => {
        let m = viewIndex.get(uuid)
        if (!m) { m = new Map(); viewIndex.set(uuid, m) }
        m.set(kpIdx, pt)
      })
    }

    // ── Bundle-adjustment / filtering settings + helpers (hoisted for R3) ────────
    // These are needed *during* incremental registration now (interleaved BA), not
    // just after it, so their config + the sensor-group map live here. The BA and
    // track-filter functions themselves are hoisted `function` declarations below.
    const {
      baIterations = 30,
      filterMaxReprojPx = 4.0,    // observation pruning threshold (px)
      filterMinTriAngleDeg = 1.5, // drop points whose rays are too parallel
      refineIntrinsics = 'none',  // self-calibration: 'none' | 'f' | 'f,cxcy' | 'f,k1'
      interimBaEvery = 5,         // R3: run a global BA after this many new cameras
      interimBaIterations = 12,   // fewer iters for the interim solves
    } = settings

    // Map each image's sensor to a stable integer so BA can share one focal across
    // all cameras on the same sensor. Images without an assigned sensor get their
    // own group (−1 sentinel); reconstruction still runs pinhole otherwise.
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

    // R4: fold one-endpoint-assigned matches into existing tracks. Only PnP-inlier
    // correspondences extend tracks during registration, and matches touching an
    // existing track are skipped for triangulation — so an observation whose *other*
    // endpoint already belongs to a point is simply lost, leaving tracks 2-view. For
    // every verified match between two registered images where exactly one endpoint
    // is assigned, add the unassigned endpoint's observation to that point when it
    // reprojects within `gate`. Directly raises the ≥3-view share and BA conditioning.
    const foldOneEndpointMatches = (gate) => {
      let folded = 0
      for (const entry of donePairs) {
        if (!registeredUuids.has(entry.idA) || !registeredUuids.has(entry.idB)) continue
        const mapA = viewIndex.get(entry.idA)
        const mapB = viewIndex.get(entry.idB)
        for (const [ia, ib] of entry.matches) {
          const ptA = mapA?.get(ia)
          const ptB = mapB?.get(ib)
          // Only the exactly-one-assigned case: both/neither are handled elsewhere
          // (extension, triangulation, retriangulation, split-track merge).
          if (!!ptA === !!ptB) continue
          const pt = ptA || ptB
          const tgtUuid = ptA ? entry.idB : entry.idA
          const tgtKp = ptA ? ib : ia
          if (pt.views.has(tgtUuid)) continue // image already in this track → skip
          const cam = cameras.get(tgtUuid)
          const kp = imageByUuid(tgtUuid)?.keypoints?.[tgtKp]
          if (!cam || !kp) continue
          if (reprojErr(cam, pt.x, pt.y, pt.z, kp) > gate) continue
          addView(pt, tgtUuid, tgtKp) // updates viewIndex (mapA/mapB mutate in place)
          folded++
        }
      }
      return folded
    }

    // ── Incremental registration ───────────────────────────────────────────
    // R2: the PnP inlier gate is now *fixed* (reprjThreshold, capped at a small
    // multiple), not an adaptive gate that tracked the model p95. The old adaptive
    // gate escalated exactly when the model was worst — a bad seed inflated p95, the
    // gate loosened to match, and every subsequent pose was admitted at that loose
    // gate (32px on baseline B1), poisoning the model further. With R3's interleaved
    // bundle adjustment keeping the model tight between passes, images that can't
    // clear a tight gate simply wait for a later pass rather than being let in loose.
    const {
      minMatchesForRegistration = 12,
      reprjThreshold = 4.0,
      pnpGateScale = 2,          // fixed gate = reprjThreshold × min(pnpGateScale, 2)
      minPnpInliers = 15,        // R1: absolute PnP-inlier floor to accept a pose
      minPnpInlierRatio = 0.15,  // R1: …and a fraction of the correspondences
    } = settings
    // Fixed PnP gate for the whole run (never chases the model p95 upward).
    const pnpThresh = reprjThreshold * Math.max(1, Math.min(pnpGateScale, 2))
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
    // that registered keypoint already belongs to. A correspondence is only
    // trustworthy when it is *bijective* — one 3D point ↔ one new-image keypoint.
    // Two failure modes break that, and each poisons PnP if kept:
    //   • many→one: one 3D point reached via two different new keypoints (an
    //     ambiguous match);
    //   • one→many: one new keypoint mapping to two different 3D points (a split
    //     track / repetitive structure). At most one can ever be a geometric
    //     inlier, so the extras inflate the correspondence count and mechanically
    //     depress the PnP inlier ratio (the minPnpInlierRatio gate) while feeding
    //     RANSAC contradictory constraints — the classic "many correspondences,
    //     few inliers" registration stall on chain-like / repetitive datasets.
    // Detect both directions and drop the offending point/keypoint entirely.
    // Returns the new image's keypoint index per correspondence too, so successful
    // matches can *extend* the track after PnP confirms the pose.
    function collectCorrespondences(img) {
      const ptToIdx = new Map()    // pt → newIdx (first seen)
      const idxToPt = new Map()    // newIdx → pt (first seen)
      const badPts = new Set()     // pts reached with ≥2 distinct newIdx (many→one)
      const badIdx = new Set()     // newIdx reached from ≥2 distinct pts (one→many)
      for (const entry of donePairs) {
        let regUuid = null
        if (entry.idA === img.uuid && registeredUuids.has(entry.idB)) regUuid = entry.idB
        else if (entry.idB === img.uuid && registeredUuids.has(entry.idA)) regUuid = entry.idA
        else continue
        const regMap = viewIndex.get(regUuid)
        if (!regMap) continue
        const imgIsA = entry.idA === img.uuid
        for (const [ia, ib] of entry.matches) {
          const nIdx = imgIsA ? ia : ib
          const regIdx = imgIsA ? ib : ia
          const pt = regMap.get(regIdx)
          if (!pt) continue
          const prevIdx = ptToIdx.get(pt)
          if (prevIdx === undefined) ptToIdx.set(pt, nIdx)
          else if (prevIdx !== nIdx) badPts.add(pt)
          const prevPt = idxToPt.get(nIdx)
          if (prevPt === undefined) idxToPt.set(nIdx, pt)
          else if (prevPt !== pt) badIdx.add(nIdx)
        }
      }
      const pts3 = []; const pts2 = []; const newIdx = []
      for (const [pt, idx] of ptToIdx) {
        if (badPts.has(pt) || badIdx.has(idx)) continue
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
    let registeredSinceBA = 0 // R3: cameras added since the last interim bundle adjust
    while (progressed) {
      progressed = false
      pass++
      const remaining = imgs
        .filter((img) => !registeredUuids.has(img.uuid))
        .sort((a, b) => countMatchesToRegistered(b.uuid) - countMatchesToRegistered(a.uuid))

      // R2: gate is fixed (pnpThresh, set once above); log it against the model p95
      // so a diverging model is still visible without loosening the gate to match it.
      const modelStats = modelReprojStats()
      log(`Reconstruction: registration pass ${pass} — ${remaining.length} image(s) remaining `
        + `(fixed PnP gate ${pnpThresh.toFixed(1)}px, model p95 ${modelStats.p95.toFixed(1)}px)`, 'debug', 'Reconstruction')

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
          // noisier than the gate (the interim BA should tighten it on a later pass).
          // If even 4× finds nothing, the correspondences themselves are wrong.
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
        // R1: honest acceptance. The solver only needs ≥6 inliers to return a pose,
        // but a pose supported by a handful of its correspondences (IMG_4315: 6/137
        // = 4% on baseline B1) is a coincidence fit that poisons the model. Require
        // both an absolute floor AND a fraction of the correspondences; deferring is
        // cheap because the sweep loop retries this image on every later pass.
        const inlierCount = pnp.inlierMask.filter((v) => v > 0.5).length
        const minInliersNeeded = Math.max(minPnpInliers, Math.ceil(minPnpInlierRatio * pts3.length))
        if (inlierCount < minInliersNeeded) {
          const reason = `too few PnP inliers (${inlierCount}/${pts3.length} = `
            + `${(100 * inlierCount / pts3.length).toFixed(0)}%, need ≥${minInliersNeeded} `
            + `[max(${minPnpInliers}, ${(100 * minPnpInlierRatio).toFixed(0)}%)], gate ${pnpThresh.toFixed(1)}px)`
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

        // R3: interleaved bundle adjustment. Registering all cameras in one sweep
        // with zero intermediate BA lets the model drift far from the optimum before
        // the single global solve ever runs (B1: pre-BA p95 282px, then BA stuck in a
        // bad minimum). COLMAP-style, run a global BA + a track-filter pass after every
        // `interimBaEvery` new cameras, then continue the sweep against the tightened
        // model — so later PnP registers at the *tight* gate and the final BA starts
        // near the optimum. Poses/points only here (no self-calibration on the pre-
        // filter mess — that's deferred to the post-filter passes, R6).
        registeredSinceBA++
        if (baIterations > 0 && interimBaEvery > 0 && registeredSinceBA >= interimBaEvery
            && cameras.size >= 3 && points3d.length >= 10) {
          await runBundleAdjust(`interim BA (${cameras.size} cameras)`, interimBaIterations, 'none')
          const f = filterTracks({ maxReprojPx: filterMaxReprojPx * 2, minTriAngleDeg: filterMinTriAngleDeg })
          rebuildViewIndex() // BA + filter replaced/dropped point objects; refresh first
          const folded = foldOneEndpointMatches(filterMaxReprojPx)
          log(`Reconstruction: interim BA cleanup — filtered ${f.obsRemoved} obs + ${f.ptsRemoved} points, `
            + `folded ${folded} track observation(s); ${points3d.length} points`, 'debug', 'Reconstruction')
          registeredSinceBA = 0
        }
      }

      // R4: after each sweep, fold every one-endpoint-assigned match between two
      // registered images into its existing track (raises the ≥3-view share).
      const foldedPass = foldOneEndpointMatches(pnpThresh)
      if (foldedPass) log(`Reconstruction: pass ${pass} folded ${foldedPass} one-endpoint `
        + `observation(s) into existing tracks`, 'debug', 'Reconstruction')
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
    // (BA settings + the sensor-group map are hoisted above the registration loop
    // so R3's interleaved solves can reuse them.)

    // Accumulated self-calibrated radial k1 per sensor id (D2). Each self-cal BA
    // pass folds its k1 into the keypoints (D1) and adds it here; the run exports
    // the total so dense can undistort its rasters with the same calibration the
    // sparse cloud was built on (otherwise the folded distortion is lost at densify).
    const selfCalK1BySensor = new Map()

    // Run one global bundle adjustment, apply it (guarded: never commit a result
    // that worsens the cost), and log RMS / convergence trace. Reused for the interim
    // (R3) solves and each post-filter re-solve. `refineMode` overrides `refineIntrinsics`
    // per call: interim/pre-filter solves pass 'none' (self-calibration against the
    // pre-filter mess drifted cx/cy 180px on B1), only post-filter passes refine.
    async function runBundleAdjust(label, iters, refineMode = refineIntrinsics) {
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
        { maxIters: iters, refineIntrinsics: refineMode, sensorOfCam })
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
        const K = refineMode !== 'none' && result.intrinsics
          ? { ...old.K, ...result.intrinsics[ci] }
          : old.K
        cameras.set(uuid, { ...old, ...result.cameras[ci], K })
      })
      points3d = result.points3d.map((pt, i) => ({ ...pt, views: points3d[i].views }))

      // Self-calibration report: one line per sensor group (before → after focal +
      // the implied film width, tying back to the Q4 sanity check). Never written
      // back to the sensor table — the user decides whether to adopt it.
      if (refineMode !== 'none' && result.intrinsics) {
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
          const cxcy = refineMode === 'f,cxcy'
            ? `, cx ${kList[ci].cx.toFixed(1)}→${result.intrinsics[ci].cx.toFixed(1)}, `
              + `cy ${kList[ci].cy.toFixed(1)}→${result.intrinsics[ci].cy.toFixed(1)}` : ''
          // R6: report the refined shared radial coefficient (copy into the sensor table's k1).
          const kdist = refineMode === 'f,k1' && result.intrinsics[ci].k1 != null
            ? `, k1 ${result.intrinsics[ci].k1.toFixed(5)}` : ''
          log(`Reconstruction: ${label} self-calibration — sensor group ${g}: `
            + `fx ${fx0.toFixed(1)} → ${fx1.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)${cxcy}${kdist}${implied}`,
            'info', 'Reconstruction')
        })
        log(`Reconstruction: ${label} self-calibration is weakly observed on short/single strips `
          + `(needs ≥2° tilt variation for a trustworthy focal); review before updating the sensor table.`,
          'debug', 'Reconstruction')
      }

      // ── Fold self-calibrated distortion back into the keypoints (D1) ──────────
      // BA estimates a shared radial k1, but the rest of the pipeline is pure
      // pinhole (projectPoint, the track filter, reprojection stats, the dense/ortho
      // warp) — a k1 left on the model would be invisible to all of them, so the
      // pinhole stats would disagree with BA's RMS and the track filter would cut a
      // model that is actually fine. Instead we re-undistort the observations with
      // the estimated k1 (exactly what ingest does with the sensor's coefficients)
      // and reset the model k1 to 0, keeping the pinhole invariant. BA's forward
      // model (project_k1: u = fx·a·(1+k1·r²)+cx) is the inverse of undistortPixel
      // with the same {k1}, so the fold is exact to first order; the next self-cal
      // pass then estimates only the tiny residual on the already-folded keypoints.
      if (refineMode === 'f,k1' && result.intrinsics) {
        let foldedImgs = 0, foldedShift = 0, foldedN = 0
        const passSeen = new Set() // accumulate each sensor's k1 once per pass
        uuidList.forEach((uuid, ci) => {
          const cam = cameras.get(uuid)
          if (cam?.K) cam.K = { ...cam.K, k1: 0 } // keypoints will carry the distortion
          const rk = result.intrinsics[ci]
          const k1 = rk?.k1 || 0
          if (!k1) return
          const img = imageByUuid(uuid)
          if (!img?.keypoints?.length) return
          img.keypoints = img.keypoints.map((kp) => {
            const u = undistortPixel(kp.x, kp.y, rk, { k1 })
            foldedShift += Math.hypot(u.x - kp.x, u.y - kp.y); foldedN++
            return { ...kp, x: u.x, y: u.y }
          })
          foldedImgs++
          // D2: record the calibrated k1 per sensor (once per pass — all cameras in a
          // group share it) so dense reproduces the fold. k1 is a normalised-coord
          // coefficient and dense's camera K is this same refined K, so the accumulated
          // value applies directly there; passes compose ≈ additively (small residuals).
          const sid = img.sensorId ?? null
          if (sid != null && !passSeen.has(sid)) {
            passSeen.add(sid)
            selfCalK1BySensor.set(sid, (selfCalK1BySensor.get(sid) || 0) + k1)
          }
        })
        if (foldedImgs > 0) {
          log(`Reconstruction: ${label} folded self-calibrated k1 into ${foldedImgs} image(s)' keypoints `
            + `(mean shift ${(foldedShift / Math.max(1, foldedN)).toFixed(2)}px; model stays pinhole)`,
            'info', 'Reconstruction')
        }
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

      // Pre-filter solves stay pinhole ('none'): self-calibration against the
      // unfiltered outlier soup drifts cx/cy badly (R6). Intrinsics are refined only
      // in the post-filter passes below, once the gross junk is gone.
      await runBundleAdjust('bundle adjustment', baIterations, 'none')
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
          await runBundleAdjust('post-retriangulation bundle adjustment', baIterations, 'none')
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

    // Per-camera median-residual table (flags cameras > 2× the global median). The
    // global stats hide a handful of badly-placed cameras that each still triangulate
    // hundreds of points at their own bad quality (the pass-2 cameras on B1); this
    // surfaces them by name so a bad registration is diagnosable at a glance.
    {
      const perCam = new Map() // uuid → residuals[]
      for (const pt of points3d) pt.views.forEach((kpIdx, uuid) => {
        const cam = cameras.get(uuid), img = imageByUuid(uuid)
        const kp = img?.keypoints?.[kpIdx]
        if (!cam || !kp) return
        const proj = projectPoint(cam, pt.x, pt.y, pt.z)
        if (!proj) return
        if (!perCam.has(uuid)) perCam.set(uuid, [])
        perCam.get(uuid).push(Math.hypot(proj.u - kp.x, proj.v - kp.y))
      })
      const globalMed = numStats(modelResiduals()).median || 0
      const rows = [...perCam.entries()]
        .map(([uuid, rs]) => ({ uuid, name: imageByUuid(uuid)?.name ?? uuid, s: numStats(rs) }))
        .sort((a, b) => b.s.median - a.s.median)
      const flagged = rows.filter((r) => globalMed > 0 && r.s.median > 2 * globalMed)
      log(`Reconstruction: per-camera residuals — global median ${globalMed.toFixed(2)}px; `
        + `${flagged.length}/${rows.length} camera(s) over 2× (${(2 * globalMed).toFixed(2)}px)`,
        flagged.length ? 'warn' : 'info', 'Reconstruction')
      for (const r of flagged) {
        log(`Reconstruction:   ⚠ ${r.name} — median ${r.s.median.toFixed(2)}px, `
          + `p95 ${r.s.p95.toFixed(2)}px (${r.s.count} obs)`, 'warn', 'Reconstruction')
      }
    }

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
      // D2: self-calibrated radial distortion per sensor (folded into keypoints for
      // the sparse solve; the dense stage adds it to the sensor's undistortion so its
      // rasters land in the same pinhole frame). Empty when self-calibration was off.
      selfCalDistortion: [...selfCalK1BySensor]
        .filter(([, k1]) => k1)
        .map(([sensorId, k1]) => ({ sensorId, k1 })),
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

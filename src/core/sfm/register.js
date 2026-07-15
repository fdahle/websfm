// Incremental registration stage of the SfM pipeline (pure compute). Extracted
// from sfm.js (the incremental-resection sweep + its correspondence helpers) so the
// orchestrator stays readable, following the initPair.js / cycleFilter.js precedent.
//
// Grows the sparse model one camera at a time: order the unregistered images by a
// next-best-view score, register each by two-gate PnP (loose PnP inlier gate +
// tight refine-recheck), extend/triangulate tracks, and run interleaved bundle
// adjustment. All shared model state is passed in via `ctx` and mutated in place
// (Maps/Sets by reference; the reassignable `points3d` array via the live
// `getPoints3d()` getter, since injected BA/filter closures replace it). Returns
// nothing — the caller reads the updated model + `modelReprojStats()` afterwards.
//
// ctx = {
//   imgs, donePairs, Kmap, cfg, bestPair-seeded registeredUuids,
//   cameras, viewIndex,                       // Maps, mutated by reference
//   getPoints3d,                              // () => live points3d array
//   addView, rebuildViewIndex, foldOneEndpointMatches, mergeTracks,
//   runBundleAdjust, filterTracks, modelReprojStats, imageByUuid, numStats,
//   log, onProgress,
// }
import { solvePnp, triangulateDlt } from "./reconstruction.js"
import { projectPoint, triangulationAngle, cameraCenter } from "./geometry.js"
import { toNorm, camToP34flat, retriangulatePairs } from "./tracks.js"

// Depth of world point (x,y,z) along a flat 3×4 projection matrix's principal axis
// (cheirality: positive ⇒ in front of the camera). Mirrors sfm.js's helper.
function projDepth(P, x, y, z) {
  return P[8] * x + P[9] * y + P[10] * z + P[11]
}

export async function registerImages(ctx) {
  const {
    imgs, donePairs, Kmap, cfg,
    cameras, viewIndex, registeredUuids, getPoints3d,
    addView, rebuildViewIndex, foldOneEndpointMatches, mergeTracks,
    runBundleAdjust, filterTracks, modelReprojStats, imageByUuid, numStats,
    log, onProgress,
  } = ctx

  // ── Incremental registration ───────────────────────────────────────────
  // R2: the PnP inlier gate is now *fixed* (reprjThreshold, capped at a small
  // multiple), not an adaptive gate that tracked the model p95. The old adaptive
  // gate escalated exactly when the model was worst — a bad seed inflated p95, the
  // gate loosened to match, and every subsequent pose was admitted at that loose
  // gate (32px on baseline B1), poisoning the model further. With R3's interleaved
  // bundle adjustment keeping the model tight between passes, images that can't
  // clear a tight gate simply wait for a later pass rather than being let in loose.
  // Defaults + rationale in defaults.user.js (minMatchesForRegistration,
  // reprjThreshold) and tuning.js (the PnP-gate trio); `cfg` already merged them.
  const {
    minMatchesForRegistration,
    reprjThreshold,
    pnpGateScale,
    minPnpInliers,
    minPnpInlierRatio,
    minPnpRefineInlierRatio,
  } = cfg
  // BA/filter knobs shared with the interleaved (R3) solves — destructured in the
  // orchestrator too (its post-registration BA reuses them); see defaults.user.js
  // (baIterations) + tuning.js (the rest).
  const {
    filterMaxReprojPx,
    filterMinTriAngleDeg,
    baIterations,
    interimBaEvery,
    interimBaIterations,
    rescueStalled,
    rescueRefineRatio,
  } = cfg
  // Fixed PnP gate for the whole run (never chases the model p95 upward).
  const pnpThresh = reprjThreshold * Math.max(1, Math.min(pnpGateScale, 2))
  // (D3) Self-calibrate lens distortion *during* registration once the model is large
  // enough to observe it. A 2-view model absorbs radial distortion into the point
  // positions, so init reprojection looks perfect while the geometry is wrong — the
  // 3rd-view PnP is the first to expose it (a distorted consumer-camera pair fits
  // two views at <2px yet resects the next camera at ~13% inliers). Deferring the k1
  // solve to the post-filter passes (R6) is therefore too late: registration has
  // already stalled. Instead, once `distortionCalMinCams` cameras are in (enough
  // parallax for k1 to be identifiable), the interim BA refines f,k1 and runBundleAdjust
  // folds the distortion out of every image on the sensor (+ into Kmap), so subsequent
  // PnP sees pinhole geometry. Below the threshold the interim BA stays pose/points-only
  // as before — a k1 fit from 2–3 views is unreliable and the fold is destructive. When
  // self-cal is off (a calibrated model already removed distortion at ingest) this is a
  // no-op. The stalled-strip rescue keeps its focal-only solve for tiny models but adopts
  // the same f,k1 mode once past the threshold, so a stall caused by distortion escapes too.
  const selfCalOn = cfg.refineIntrinsics !== 'none'
  const distortionCalMinCams = cfg.distortionCalMinCams ?? 6
  const distortionRefine = (n) =>
    selfCalOn && n >= distortionCalMinCams ? cfg.refineIntrinsics : 'none'
  const rescueRefine = (n) =>
    !selfCalOn ? 'none' : n >= distortionCalMinCams ? cfg.refineIntrinsics : 'f'
  const keypointOf = (uuid, kpIdx) => imageByUuid(uuid)?.keypoints?.[kpIdx] ?? null

  // Total inliers linking `uuid` to the already-registered set (cheap fallback
  // heuristic — used only to break ties when the model has no points yet).
  function countMatchesToRegistered(uuid) {
    let count = 0
    for (const e of donePairs) {
      const other = e.idA === uuid ? e.idB : e.idB === uuid ? e.idA : null
      if (other && registeredUuids.has(other)) count += e.inlierCount
    }
    return count
  }

  // P4.1 next-best-view score (COLMAP-style): prefer the candidate with the most
  // correspondences to *well-triangulated* points (≥2 views), weighted by how
  // spatially spread those observations are (a pose constrained by a tight cluster
  // is ill-conditioned). Grid-bucket the 2D observations (like inlierSpread) and
  // multiply the well-tri count by the occupied-bucket fraction of a GRID×GRID mesh.
  const NBV_GRID = 4
  // Takes the image's correspondences precomputed by the caller (they're cached per
  // pass and reused for the PnP attempt — see the sweep loop) so scoring doesn't
  // re-sweep every donePair a second time.
  function nextViewScore(corr, img) {
    const { pts3, pts2 } = corr
    const w = img.meta?.width ?? img.width ?? 1
    const h = img.meta?.height ?? img.height ?? 1
    const buckets = new Set()
    let wellTri = 0
    for (let i = 0; i < pts3.length; i++) {
      if ((pts3[i].views?.size ?? 0) < 2) continue
      wellTri++
      const bx = Math.min(NBV_GRID - 1, Math.max(0, Math.floor((pts2[i].x / w) * NBV_GRID)))
      const by = Math.min(NBV_GRID - 1, Math.max(0, Math.floor((pts2[i].y / h) * NBV_GRID)))
      buckets.add(by * NBV_GRID + bx)
    }
    // Spread in [1/G², 1]; a single-bucket cluster is heavily discounted.
    const spread = buckets.size / (NBV_GRID * NBV_GRID)
    return wellTri * spread
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
  // P1: correspondences depend only on the model state (registered cameras +
  // viewIndex + points). `modelVersion` bumps whenever a registration mutates that,
  // so a per-pass cache built during scoring can be reused for the PnP attempt as
  // long as nothing has registered since — halving the correspondence sweeps in
  // stall passes (nothing registers → whole pass reuses the cache) and for the
  // leading run of images before the first registration.
  let modelVersion = 0
  // (3) Stalled-strip rescue: `relaxed` loosens the refine-recheck on the one retry
  // sweep the rescue triggers; `rescued` makes it a single shot.
  let relaxed = false
  let rescued = false
  while (progressed) {
    progressed = false
    pass++
    // `relaxed` is armed by the rescue block for the *next* sweep only; consume it
    // here so exactly one retry runs loose and everything after reverts to strict.
    const passRelaxed = relaxed
    relaxed = false
    // P4.1: order by next-best-view score (correspondences to well-triangulated,
    // spatially-spread points). Fall back to raw inlier connectivity as a tie-break
    // (and for candidates that have no well-tri correspondences yet). Correspondences
    // computed here are cached (corrCache) and reused in the attempt loop below.
    const corrCache = new Map()
    const remaining = imgs
      .filter((img) => !registeredUuids.has(img.uuid))
      .map((img) => {
        const corr = collectCorrespondences(img)
        corrCache.set(img.uuid, corr)
        return { img, score: nextViewScore(corr, img), links: countMatchesToRegistered(img.uuid) }
      })
      .sort((a, b) => (b.score - a.score) || (b.links - a.links))
      .map((r) => r.img)
    const cacheVersion = modelVersion // cache is valid while no camera has registered

    // R2: gate is fixed (pnpThresh, set once above); log it against the model p95
    // so a diverging model is still visible without loosening the gate to match it.
    const modelStats = modelReprojStats()
    log(`Reconstruction: registration pass ${pass} — ${remaining.length} image(s) remaining `
      + `(fixed PnP gate ${pnpThresh.toFixed(1)}px, model p95 ${modelStats.p95.toFixed(1)}px)`, 'debug', 'Reconstruction')

    for (const img of remaining) {
      const K = Kmap.get(img.uuid)
      // Reuse the scoring-time correspondences while the model is unchanged; once a
      // camera has registered this pass (modelVersion moved), recompute against the
      // grown model.
      const { pts3, pts2, newIdx } = modelVersion === cacheVersion
        ? corrCache.get(img.uuid)
        : collectCorrespondences(img)
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

      // P4.3 refine-then-recheck: solvePnp already Gauss-Newton-polishes the pose,
      // so recount how many correspondences fit at the *tight* reprjThreshold (not
      // the looser PnP gate) and require the ratio again. A pose that only holds up
      // at the loose gate is a weak fit; defer it — a later pass with more/tighter
      // structure may let it register cleanly.
      const newCam = { R: pnp.R, t: pnp.t, K }
      // On the rescue retry (relaxed), recheck at the looser PnP gate + a lower ratio
      // rather than the tight reprjThreshold — a strip-end pose that holds at the gate
      // but not at 4px is admitted as a last resort (post-BA + track filter clean it).
      const recheckPx = passRelaxed ? pnpThresh : reprjThreshold
      const recheckRatio = passRelaxed ? rescueRefineRatio : minPnpRefineInlierRatio
      let refineInliers = 0
      for (let i = 0; i < pts3.length; i++) {
        const proj = projectPoint(newCam, pts3[i].x, pts3[i].y, pts3[i].z)
        if (proj && Math.hypot(proj.u - pts2[i].x, proj.v - pts2[i].y) <= recheckPx) refineInliers++
      }
      const refineNeeded = Math.max(minPnpInliers, Math.ceil(recheckRatio * pts3.length))
      if (refineInliers < refineNeeded) {
        const reason = `pose fits loosely — only ${refineInliers}/${pts3.length} correspondences `
          + `within ${recheckPx.toFixed(1)}px after polish (need ≥${refineNeeded} `
          + `[${(100 * recheckRatio).toFixed(0)}%]); ${inlierCount} held at the `
          + `${pnpThresh.toFixed(1)}px gate`
        deferReasons.set(img.uuid, reason)
        log(`Reconstruction: defer ${img.name} — ${reason}`, 'warn', 'Reconstruction')
        continue
      }
      cameras.set(img.uuid, newCam)
      registeredUuids.add(img.uuid)
      deferReasons.delete(img.uuid)
      progressed = true
      modelVersion++ // model changed → invalidate the per-pass correspondence cache

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
      const Cnew = cameraCenter(newCam)
      let added = 0
      let triTotal = 0    // triangulated before cheirality
      let lowParallax = 0 // rejected for too-parallel rays (P4.4)
      for (const entry of donePairs) {
        let regUuid = null
        if (entry.idA === img.uuid && registeredUuids.has(entry.idB) && entry.idB !== img.uuid) regUuid = entry.idB
        else if (entry.idB === img.uuid && registeredUuids.has(entry.idA) && entry.idA !== img.uuid) regUuid = entry.idA
        else continue

        const regCam = cameras.get(regUuid)
        const regImg = imageByUuid(regUuid)
        if (!regCam || !regImg) continue
        const Preg = camToP34flat(regCam)
        const Creg = cameraCenter(regCam)
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
            // P4.4: cheirality alone admits near-parallel-ray points whose depth is
            // wildly uncertain — those bursts poisoned interim BA (max residual
            // >1000px on the building run). Require a real baseline angle, same
            // floor the track filter later enforces.
            if (triangulationAngle(Cnew, Creg, { x, y, z }) < filterMinTriAngleDeg) { lowParallax++; continue }
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
            getPoints3d().push(pt)
            added++
          }
        }
      }
      const pct = triTotal ? (100 * added / triTotal).toFixed(0) : '0'
      log(`Reconstruction: ${img.name} — extended ${extended} track(s), `
        + `+${added} new points (${added}/${triTotal} survived cheirality + parallax, ${pct}%; `
        + `${lowParallax} dropped for <${filterMinTriAngleDeg}° parallax)`, 'debug', 'Reconstruction')

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
          && cameras.size >= 3 && getPoints3d().length >= 10) {
        onProgress?.(cameras.size, imgs.length, `Bundle adjustment (${cameras.size} cameras)…`)
        await runBundleAdjust(`interim BA (${cameras.size} cameras)`, interimBaIterations,
          distortionRefine(cameras.size))
        const f = filterTracks({ maxReprojPx: filterMaxReprojPx * 2, minTriAngleDeg: filterMinTriAngleDeg })
        const mergedTr = mergeTracks(filterMaxReprojPx) // fold split tracks (both-endpoint case)
        rebuildViewIndex() // BA + filter + merge replaced/dropped point objects; refresh first
        const folded = foldOneEndpointMatches(filterMaxReprojPx)
        log(`Reconstruction: interim BA cleanup — filtered ${f.obsRemoved} obs + ${f.ptsRemoved} points, `
          + `merged ${mergedTr} split track(s), folded ${folded} track observation(s); `
          + `${getPoints3d().length} points`, 'debug', 'Reconstruction')
        registeredSinceBA = 0
      }
    }

    // R4: after each sweep, fold every one-endpoint-assigned match between two
    // registered images into its existing track (raises the ≥3-view share).
    const foldedPass = foldOneEndpointMatches(pnpThresh)
    if (foldedPass) log(`Reconstruction: pass ${pass} folded ${foldedPass} one-endpoint `
      + `observation(s) into existing tracks`, 'debug', 'Reconstruction')

    // (2)+(3) Stalled-strip rescue (one shot). A full sweep registered nothing, but
    // images still link to the model — typically a short film strip whose end frames
    // fail on a slightly-wrong focal + a structure gap in their overlap. Correct the
    // focal (focal-only BA, safe pre-filter), retriangulate to grow structure into
    // the stalled overlaps, then force ONE more sweep with a relaxed refine-recheck.
    if (!progressed && !rescued && rescueStalled && cameras.size >= 3) {
      const stalledLinked = imgs.filter((img) =>
        !registeredUuids.has(img.uuid) && countMatchesToRegistered(img.uuid) > 0)
      if (stalledLinked.length) {
        rescued = true
        log(`Reconstruction: registration stalled — ${stalledLinked.length} linked image(s) still `
          + `unregistered; rescue (focal solve + retriangulation, then a relaxed retry)`, 'info', 'Reconstruction')
        const rescueMode = rescueRefine(cameras.size)
        if (baIterations > 0 && rescueMode !== 'none' && cameras.size >= 3 && getPoints3d().length >= 10) {
          onProgress?.(cameras.size, imgs.length, 'Rescue: focal solve…')
          await runBundleAdjust('rescue focal solve', interimBaIterations, rescueMode)
          rebuildViewIndex()
        }
        onProgress?.(cameras.size, imgs.length, 'Rescue: retriangulating…')
        const { added } = await retriangulatePairs({
          points3d: getPoints3d(), cameras, pairs: donePairs,
          keypointOf, maxReprojPx: filterMaxReprojPx, triangulate: triangulateDlt,
        })
        rebuildViewIndex()
        log(`Reconstruction: rescue retriangulation +${added} point(s); retrying with a relaxed `
          + `recheck (${pnpThresh.toFixed(1)}px, ${(100 * rescueRefineRatio).toFixed(0)}%)`, 'info', 'Reconstruction')
        relaxed = true
        modelVersion++    // model changed → invalidate the per-pass correspondence cache
        progressed = true // force one more sweep
      }
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

  log(`Reconstruction: ${cameras.size}/${imgs.length} cameras registered, ${getPoints3d().length} points`, 'info', 'Reconstruction')
}

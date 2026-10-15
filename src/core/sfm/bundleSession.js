// Every bundle adjustment one single-model run performs, over that run's shared model
// state: the local window solve, the guarded global solve (acceptance, self-cal
// validation before commit, the self-cal report and the distortion fold via
// selfCalFold.js), the camera-prior and GCP-anchored solves, and the summed solver
// statistics for the run record. Solves read and write `cameras` and the track store
// in place; point ids are held only within one solve (the caller's refreshTracks
// renumbers them between solves).
//
// createBundleSession(ctx) — ctx = {
//   cfg, cameras, tracks, ids, keypointsAt, imageByUuid, sensorIntByUuid,
//   intrinsicsRecord, selfCalRecord, selfCal (createSelfCalFold), cameraPriors, gcps,
//   modelReprojStats, log,
// }
// Created before registration: register.js runs the interleaved (R3) and local
// solves through it. `cfg` must already carry the resolved gates and refineIntrinsics.

import { bundleAdjust } from './reconstruction.js'
import { validateSelfCalUpdate } from './selfCalGuard.js'
import { distortPixel } from './distortion.js'
import { buildCameraPriorConstraints as buildSurveyPriorConstraints, qualifyingGcps, buildGcpAnchors } from './surveyConstraints.js'
import { compareRobustCost, projectFullXYZ } from './baAcceptance.js'
import { buildBaObservations, appendObservations, trackPositions, mapObservations } from './baObservations.js'
import { fmtStats } from './modelStats.js'

export function createBundleSession(ctx) {
  const {
    cfg, cameras, tracks, ids, keypointsAt, imageByUuid, sensorIntByUuid,
    intrinsicsRecord, selfCalRecord, selfCal, cameraPriors, gcps, modelReprojStats, log,
  } = ctx
  // Defaults + rationale for these live in defaults.user.js (baIterations,
  // refineIntrinsics); `cfg` already merged them.
  const { baIterations, refineIntrinsics } = cfg

  // A BA's camera index by image index (−1 = not in the solve), from its uuid → index map.
  const camIdxOfImg = (camIdxOf) => (img) => camIdxOf.get(ids.uuid(img)) ?? -1
  // Write a solve's refined positions back: solve point r is point ptIds[r].
  const setTrackPositions = (ptIds, pos) => {
    for (let r = 0; r < ptIds.length; r++) tracks.setPosition(ptIds[r], pos[3 * r], pos[3 * r + 1], pos[3 * r + 2])
  }

  // What every bundle adjustment's linear solves did (bundle.rs SolveStats), summed for
  // the run record: the PCG-vs-Cholesky decision (TODO ▸ MEM ▸ PCG) is made from these.
  const baSolverTotals = { calls: 0, ms: 0, maxN: 0, solves: 0, cholesky: 0, pcgConverged: 0,
    pcgPartial: 0, pcgFallback: 0, pcgNotPd: 0, pcgIters: 0, pcgItersMax: 0 }
  const noteBaSolver = (label, result) => {
    const s = result?.solver
    if (!s) return
    const T = baSolverTotals
    T.calls++; T.ms += result.ms ?? 0; T.maxN = Math.max(T.maxN, s.n)
    for (const k of ['solves', 'cholesky', 'pcgConverged', 'pcgPartial', 'pcgFallback', 'pcgNotPd', 'pcgIters']) T[k] += s[k]
    T.pcgItersMax = Math.max(T.pcgItersMax, s.pcgItersMax)
    const pcg = s.pcgConverged + s.pcgPartial + s.pcgFallback + s.pcgNotPd
    log(`${label} solver — n ${s.n}, ${s.solves} solve(s): `
      + (pcg ? `PCG ${s.pcgConverged} converged / ${s.pcgPartial} partial / ${s.pcgFallback} → Cholesky / `
        + `${s.pcgNotPd} not PD, ${s.pcgIters} CG it (max ${s.pcgItersMax})` : `${s.cholesky} Cholesky`)
      + `; ${((result.ms ?? 0) / 1000).toFixed(1)}s`, 'debug', 'Reconstruction')
  }

  // The frame a solve runs in. A pinhole camera's observations are its (undistorted)
  // keypoints. A FISHEYE camera's go to the crate in the pixels its lens recorded —
  // re-distorted with the K and lens they were undistorted about, which recovers them
  // exactly — with that lens on its K, so bundle.rs fits Kannala–Brandt residuals: an
  // honest pixel error at any field angle (the pinhole frame stretches the rim by
  // 1/cos²θ) and a lens self-calibration can refine. Returns the solve's kList and
  // observations; with no fisheye camera, the inputs unchanged.
  function lensFrame(uuidList, kList, observations) {
    const lenses = uuidList.map((u) => selfCal.lensOf(u))
    if (!lenses.some(Boolean)) return { kList, observations }
    return {
      kList: kList.map((K, ci) => (lenses[ci]
        ? { ...K, fisheye: true, fisheyeTerms: lenses[ci].terms,
            k1: lenses[ci].k1, k2: lenses[ci].k2, k3: lenses[ci].k3, k4: lenses[ci].k4 }
        : K)),
      observations: mapObservations(observations, (ci) => {
        const lens = lenses[ci], K = kList[ci]
        return lens ? (x, y) => distortPixel(x, y, K, lens) : null
      }),
    }
  }

  // Local bundle adjustment (COLMAP's, between the geometric global solves): the newly
  // registered camera and the `window − 1` registered cameras sharing the most points
  // with it are free, with every point the new camera observes; the other cameras
  // observing those points stay fixed (bundle.rs `fixed_cam`), so their observations
  // constrain the window without moving the rest of the model. Poses and points only —
  // self-calibration stays with the global solves. Off unless cfg.localBaWindow > 0.
  async function runLocalBundleAdjust(uuid, window, iters) {
    const img = ids.img(uuid)
    const set = keypointsAt(img)
    if (!(window > 1) || !(iters > 0) || !set || !cameras.has(uuid) || cameras.size <= 2) return
    const ptSet = new Set()
    for (let kp = 0, n = set.xy.length / 2; kp < n; kp++) {
      const p = tracks.pointAt(img, kp)
      if (p >= 0) ptSet.add(p)
    }
    if (ptSet.size < 10) return
    const shared = new Map() // camera uuid → points shared with the new camera
    for (const p of ptSet) tracks.forEachView(p, (vi) => {
      const u = ids.uuid(vi)
      if (u !== uuid && cameras.has(u)) shared.set(u, (shared.get(u) ?? 0) + 1)
    })
    const free = [uuid, ...[...shared].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, window - 1).map(([u]) => u)]
    const freeSet = new Set(free)
    const fixed = [...shared.keys()].filter((u) => !freeSet.has(u))
    const uuidList = [...free, ...fixed]
    const camList = uuidList.map((u) => cameras.get(u))
    const camIdxOf = new Map(uuidList.map((u, i) => [u, i]))
    const ptIds = [...ptSet]
    const { kList, observations } = lensFrame(uuidList, camList.map((c) => c.K),
      buildBaObservations(tracks, ptIds, (vi) => camIdxOf.get(ids.uuid(vi)) ?? -1, keypointsAt))
    const posBefore = trackPositions(tracks, ptIds)
    const result = await bundleAdjust(camList, kList, posBefore, observations, {
      maxIters: iters, refineIntrinsics: 'none', solver: cfg.baSolver, flatPoints: true,
      fixedCams: fixed.map((_, k) => free.length + k),
    })
    noteBaSolver('local BA', result)
    if (!result) return
    if (result.costAfter > result.costBefore) {
      const robust = compareRobustCost({
        before: { cams: camList, Ks: kList, points: posBefore },
        after: { cams: result.cameras, Ks: kList, points: result.pos }, observations,
      })
      if (!robust.improved) return
    }
    free.forEach((u, ci) => { const old = cameras.get(u); cameras.set(u, { ...old, ...result.cameras[ci], K: old.K }) })
    setTrackPositions(ptIds, result.pos)
    log(`local BA (${imageByUuid(uuid)?.name ?? uuid}) — ${free.length} free + ${fixed.length} fixed cameras, `
      + `${ptIds.length} points: RMS ${result.costBefore.toFixed(2)} → ${result.costAfter.toFixed(2)}px`, 'debug', 'Reconstruction')
  }

  // Convert project-CRS camera poses into targets in the current arbitrary SfM
  // frame. The best-fit position similarity removes the global gauge; imported
  // orientations are then composed through its rotation into the same frame.
  // Constraint construction lives in surveyConstraints.js (shared with gradual
  // selection, so a refinement can never drop what this solve was held to).
  const buildCameraPriorConstraints = (uuidList, reference = null) => buildSurveyPriorConstraints({
    cameras, cameraPriors, uuidList, minCameras: cfg.cameraPriorBaMinCameras, reference })

  const cameraPriorReprojectionAccepts = (result) => {
    const allowance = Math.max(cfg.cameraPriorMaxReprojIncreasePx,
      result.costBefore * cfg.cameraPriorMaxReprojIncreaseFrac)
    return result.costAfter <= result.costBefore + allowance
  }

  // Run one global bundle adjustment, apply it (guarded: never commit a result
  // that worsens the cost), and log RMS / convergence trace. Reused for the interim
  // (R3) solves and each post-filter re-solve. `refineMode` overrides `refineIntrinsics`
  // per call: interim/pre-filter solves pass 'none' (self-calibration against the
  // pre-filter mess drifted cx/cy 180px on B1), only post-filter passes refine.
  // `cameraPriors` (optional) adds GNSS/pose centre constraints. A prior-constrained
  // solve is SUPPOSED to trade some image residual for geometry, so it is judged by
  // the bounded-increase rule (cameraPriorReprojectionAccepts), not "cost must fall".
  //
  // `refineOnly(uuid)` (optional) limits which cameras' refined intrinsics are kept:
  // the others keep their K, as if their group had been held fixed (the crate cannot
  // hold one group fixed while refining another). Their poses still come from the
  // joint solve, so a caller re-settles with a 'none' solve afterwards.
  // `gcp` (optional, from buildGcpAnchors): GCP anchor points appended after the real
  // tracks, their mark observations and the anchor residuals — so a GCP-anchored solve
  // can refine intrinsics through the same validation + fold path as every other pass.
  async function runBundleAdjust(label, iters, refineMode = refineIntrinsics, { cameraPriors = null, refineOnly = null, gcp = null } = {}) {
    if (!(cameras.size >= 2 && tracks.liveCount() >= 10 && iters > 0)) {
      log(`${label} skipped (cameras=${cameras.size}, `
        + `points=${tracks.liveCount()}, iters=${iters})`, 'debug', 'Reconstruction')
      return
    }
    const uuidList = [...cameras.keys()]
    const camList  = uuidList.map((u) => cameras.get(u))
    const sensorOfCam = uuidList.map((u) => sensorIntByUuid.get(u) ?? -1)
    const camIdxOf = new Map(uuidList.map((u, i) => [u, i]))
    // Point rank in this solve → point id; the solve's point i is ptIds[i].
    const ptIds = tracks.liveIds()
    const tieObs = buildBaObservations(tracks, ptIds, camIdxOfImg(camIdxOf), keypointsAt)
    // kList / observations in the solve's frame: a fisheye camera's in recorded pixels
    // with its lens on K (lensFrame). Everything below — the diagnostic, the robust
    // acceptance, the validation — judges the solve in that same frame.
    const { kList, observations } = lensFrame(uuidList, camList.map((c) => c.K),
      gcp ? appendObservations(tieObs, gcp.observations) : tieObs)
    const posBefore = gcp ? trackPositions(tracks, ptIds, gcp.anchorPts) : trackPositions(tracks, ptIds)
    // A survey-constrained solve (camera priors or GCP anchors) is judged by the
    // bounded-increase rule, not "cost must fall".
    const constrained = !!(cameraPriors || gcp)
    log(`${label} — ${camList.length} cameras, ${ptIds.length} points, `
      + `${observations.n} observations, ${iters} iters`, 'info', 'Reconstruction')
    // Diagnostic: where do the gross pre-solve residuals sit? Grouped by camera, split
    // by the observed point's track length (2 = freshly triangulated, ≥3 = extended).
    {
      const { cam: oCam, pt: oPt, x: oX, y: oY } = observations
      const errs = new Array(observations.n)
      for (let i = 0; i < observations.n; i++) {
        const j = oPt[i]
        const q = projectFullXYZ(camList[oCam[i]], kList[oCam[i]], posBefore[3 * j], posBefore[3 * j + 1], posBefore[3 * j + 2])
        errs[i] = q ? Math.hypot(q.x - oX[i], q.y - oY[i]) : Infinity
      }
      const sorted = errs.filter(Number.isFinite).sort((a, b) => a - b)
      const med = sorted[Math.floor(sorted.length / 2)] ?? 0
      const gross = Math.max(50, 20 * med)
      const byCam = new Map()
      errs.forEach((e, i) => {
        if (!(e > gross)) return
        const ci = oCam[i]
        const rec = byCam.get(ci) ?? { n: 0, fresh: 0, max: 0 }
        const pid = ptIds[oPt[i]]
        rec.n++; if (pid != null && tracks.viewCount(pid) <= 2) rec.fresh++
        rec.max = Math.max(rec.max, e)
        byCam.set(ci, rec)
      })
      if (byCam.size) {
        const top = [...byCam].sort((a, b) => b[1].n - a[1].n).slice(0, 6)
          .map(([ci, r]) => `${imageByUuid(uuidList[ci])?.name ?? ci} ${r.n} (${r.fresh} on 2-view pts, max ${r.max.toFixed(0)}px)`)
        const total = [...byCam.values()].reduce((s, r) => s + r.n, 0)
        log(`${label} pre-solve gross residuals (>${gross.toFixed(0)}px): ${total} obs on ${byCam.size} camera(s); `
          + `top: ${top.join('; ')}`, 'debug', 'Reconstruction')
      }
    }

    const result = await bundleAdjust(camList, kList, posBefore, observations,
      { maxIters: iters, refineIntrinsics: refineMode, sensorOfCam, solver: cfg.baSolver, flatPoints: true,
        ...(cameraPriors ? { cameraPriors } : {}), ...(gcp ? { gcpAnchors: gcp.anchors } : {}) })
    noteBaSolver(label, result)
    if (!result) {
      log(`${label} returned no result (skipped)`, 'warn', 'Reconstruction')
      return
    }
    if (constrained && result.costAfter > result.costBefore + 0.01 && !cameraPriorReprojectionAccepts(result)) {
      log(`${label} REJECTED — reprojection RMS ${result.costBefore.toFixed(2)}px → `
        + `${result.costAfter.toFixed(2)}px exceeds the survey-constraint safety bound`, 'warn', 'Reconstruction')
      return
    }
    // A correct bundle adjustment can only lower the cost; reject a worsening
    // result rather than commit a diverged model. But a fully converged model
    // can tick up by a float epsilon on a no-op re-solve — that's convergence,
    // not divergence, so don't cry wolf (< 0.01px is below any real-world
    // meaning). Only warn + reject when the cost genuinely grows (≥ 0.01px).
    // The guard judges the solve by the cost it minimised. The crate descends a
    // Huber-robust cost but reports plain RMS, and a correct robust solve can raise
    // plain RMS by letting down-weighted outliers drift. Rejecting those kept newly
    // registered cameras unrefined and seeded the later RMS 185–902 px interim
    // starts (baAcceptance.js). So a plain-RMS rise is only a rejection when the
    // robust cost rose too.
    if (!constrained && result.costBefore != null && result.costAfter != null && result.costAfter > result.costBefore) {
      const delta = result.costAfter - result.costBefore
      const afterKs = refineMode !== 'none' && result.intrinsics
        ? kList.map((k, ci) => ({ ...k, ...result.intrinsics[ci] })) : kList
      const robust = compareRobustCost({
        before: { cams: camList, Ks: kList, points: posBefore },
        after: { cams: result.cameras, Ks: afterKs, points: result.pos },
        observations,
      })
      if (delta < 0.01) {
        log(`${label} already converged (RMS ${result.costBefore.toFixed(2)}px unchanged); `
          + `keeping the pre-BA estimate`, 'debug', 'Reconstruction')
        return
      }
      if (!robust.improved) {
        log(`${label} REJECTED — RMS ${result.costBefore.toFixed(2)}px → `
          + `${result.costAfter.toFixed(2)}px and robust cost ${robust.before.toFixed(2)} → `
          + `${robust.after.toFixed(2)}px (Huber δ ${robust.delta.toFixed(1)}px) would worsen the model; `
          + 'keeping the pre-BA estimate', 'warn', 'Reconstruction')
        return
      }
      log(`${label} accepted — plain RMS ${result.costBefore.toFixed(2)}px → ${result.costAfter.toFixed(2)}px rose, `
        + `but the robust cost it minimises fell ${robust.before.toFixed(2)} → ${robust.after.toFixed(2)}px `
        + `(Huber δ ${robust.delta.toFixed(1)}px): outliers were down-weighted, not the fit worsened`,
      'info', 'Reconstruction')
    }

    // The refined intrinsics this solve proposes, per camera; null where none are
    // kept (no self-calibration, or a camera `refineOnly` excludes).
    const refined = refineMode !== 'none' && result.intrinsics
      ? result.intrinsics.map((rk, ci) => (!refineOnly || refineOnly(uuidList[ci]) ? rk : null))
      : null

    // Self-calibration is destructive only after this point: accepted radial terms
    // are folded into every image's keypoints. Validate the detached BA result first,
    // and reject the whole update transaction if any shared sensor is implausible.
    // Reprojection cost alone cannot catch focal/distortion overfit on thin blocks.
    if (refined) {
      const checkedGroups = new Set()
      const proposals = []
      let rejected = null
      for (let ci = 0; ci < uuidList.length; ci++) {
        if (!refined[ci]) continue
        const groupKey = selfCal.groupOf(uuidList[ci])
        if (checkedGroups.has(groupKey)) continue
        checkedGroups.add(groupKey)
        const uuid = uuidList[ci]
        const img = imageByUuid(uuid)
        const sid = img?.sensorId ?? `image:${uuid}`
        const rec = intrinsicsRecord.get(sid)
        const nominalFx = rec?.fxNominal ?? kList[ci]?.fx
        // A default-FOV focal is a guess, not a measurement: wide bounds (selfCalGuard.js).
        const focalIsGuess = !!rec?.source?.startsWith('default')
        const { width, height } = selfCal.kFrameDims(img)
        const proposed = refined[ci]
        const verdict = validateSelfCalUpdate({
          before: kList[ci], proposed, nominalFx, width, height, focalIsGuess,
        }, {
          maxFocalStepFrac: cfg.selfCalMaxFocalStepFrac,
          maxFocalNominalFrac: cfg.selfCalMaxFocalNominalFrac,
          maxGuessFocalStepFrac: cfg.selfCalGuessFocalStepFrac,
          maxGuessFocalNominalFrac: cfg.selfCalGuessFocalNominalFrac,
          maxPrincipalOffsetFrac: cfg.selfCalMaxPrincipalOffsetFrac,
          maxCornerShiftFrac: cfg.selfCalMaxCornerShiftFrac,
        })
        proposals.push({
          sensorId: img?.sensorId ?? null,
          fxBefore: kList[ci]?.fx ?? null,
          fxProposed: proposed?.fx ?? null,
          k1: proposed?.k1 ?? 0, k2: proposed?.k2 ?? 0, k3: proposed?.k3 ?? 0,
          accepted: verdict.ok, rejectionCode: verdict.code, rejectionReason: verdict.reason,
        })
        if (!verdict.ok && !rejected) rejected = verdict
      }
      selfCalRecord.adjustments.push({ label, mode: refineMode, accepted: !rejected, sensors: proposals })
      if (rejected) {
        log(`${label} self-calibration REJECTED before commit — ${rejected.reason}; `
          + 'keeping cameras, points, intrinsics, and keypoints unchanged', 'warn', 'Reconstruction')
        return
      }
    }
    uuidList.forEach((uuid, ci) => {
      const old = cameras.get(uuid)
      // Merge refined intrinsics into K (keeps impliedFilmWidthMm / source meta)
      // so subsequent BA passes and reprojection stats use the calibrated focal. The
      // radial terms are zeroed: the fold below moves them into the keypoints.
      const rk = refined?.[ci]
      // Only the pinhole K lands on the camera; a fisheye's lens lives in the
      // self-cal state (selfCalFold.js lensOf) and Brown terms fold into the keypoints.
      const K = rk ? { ...old.K, fx: rk.fx, fy: rk.fy, cx: rk.cx, cy: rk.cy, k1: 0, k2: 0, k3: 0 } : old.K
      cameras.set(uuid, { ...old, ...result.cameras[ci], K })
    })
    setTrackPositions(ptIds, result.pos)

    // Each self-cal group this solve refined → the index of its first camera here.
    const solvedGroups = new Map()
    if (refined) {
      uuidList.forEach((uuid, ci) => {
        const key = selfCal.groupOf(uuid)
        if (refined[ci] && !solvedGroups.has(key)) solvedGroups.set(key, ci)
      })
    }

    // Self-calibration report: one line per group (before → after focal, the refined
    // principal-point offset + radial coeffs, and the implied film width). Never
    // written back to the sensor table — the user decides whether to adopt it.
    const wantsCxcy = refineMode.includes('cxcy')
    if (solvedGroups.size) {
      for (const [key, ci] of solvedGroups) {
        const g = sensorOfCam[ci]
        const rk = refined[ci]
        const fx0 = kList[ci].fx, fx1 = rk.fx
        const pct = fx0 ? (100 * (fx1 - fx0) / fx0) : 0
        let implied = ''
        const w0 = kList[ci].impliedFilmWidthMm
        if (w0 != null && fx1) implied = `, implied film width ${w0.toFixed(0)}mm → ${(w0 * fx0 / fx1).toFixed(0)}mm`
        const cxcy = wantsCxcy
          ? `, cx ${kList[ci].cx.toFixed(1)}→${rk.cx.toFixed(1)}, cy ${kList[ci].cy.toFixed(1)}→${rk.cy.toFixed(1)}` : ''
        // Refined shared radial coeffs (copy the non-zero ones into the sensor table);
        // a fisheye's are its whole Kannala–Brandt lens, before → after.
        const kterms = rk.fisheye
          ? ['k1', 'k2', 'k3', 'k4'].slice(0, rk.fisheyeTerms || 4)
            .map((k) => `${k} ${(kList[ci][k] ?? 0).toFixed(5)}→${(rk[k] ?? 0).toFixed(5)}`)
          : ['k1', 'k2', 'k3'].filter((k) => rk[k]).map((k) => `${k} ${rk[k].toFixed(5)}`)
        const kdist = kterms.length ? `, ${rk.fisheye ? 'fisheye ' : ''}${kterms.join(', ')}` : ''
        // A sensorless camera is a group of its own: one line each, so debug-level
        // (a sensorless set would otherwise print a line per image per pass).
        const who = g >= 0 ? `sensor group ${g}` : `camera ${imageByUuid(uuidList[ci])?.name ?? key} (no sensor)`
        log(`${label} self-calibration — ${who}: `
          + `fx ${fx0.toFixed(1)} → ${fx1.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)${cxcy}${kdist}${implied}`,
          g >= 0 ? 'info' : 'debug', 'Reconstruction')
      }
      log(`${label} self-calibration is weakly observed on short/single strips `
        + `(needs ≥2° tilt variation for a trustworthy focal); review before updating the sensor table.`,
        'debug', 'Reconstruction')
    }

    // Propagate the refined calibration to every image of each solved group and fold
    // the radial terms into the keypoints (selfCalFold.js ▸ fold).
    if (solvedGroups.size) selfCal.fold({ label, refineMode, solvedGroups, refined, kList, camIdxOf })

    if (result.costBefore != null && result.costAfter != null) {
      log(`${label} RMS ${result.costBefore.toFixed(2)}px → ${result.costAfter.toFixed(2)}px `
        + `(${result.costAfter <= result.costBefore ? '−' : '+'}${Math.abs(result.costBefore - result.costAfter).toFixed(2)}px)`, 'success', 'Reconstruction')
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
        // Saying "converged" at the cap hid that every BA ran all its iterations
        // (St Nazaire: 30 × ~4 s each after the first had already converged).
        : trace.length >= iters
          ? `plateaued, but ran all ${trace.length} iterations (no stopping rule fired)`
          : `converged in ${trace.length} iter`
      log(`${label} convergence (RMS px) — ${fmtTrace.join(' → ')}; ${verdict}`,
        'debug', 'Reconstruction')
    }
    log(`${label} reprojection — ${fmtStats(modelReprojStats())}`, 'info', 'Reconstruction')
    return result
  }

  async function runCameraPriorBundleAdjust() {
    if (!(cameraPriors.length >= cfg.cameraPriorBaMinCameras
        && cameras.size >= cfg.cameraPriorBaMinCameras
        && tracks.liveCount() >= 10 && baIterations > 0)) return
    for (let round = 0; round < cfg.cameraPriorBaRounds; round++) {
      const uuidList = [...cameras.keys()]
      const constrained = buildCameraPriorConstraints(uuidList)
      if (!constrained) {
        log(`camera-prior bundle adjustment skipped — fewer than ${cfg.cameraPriorBaMinCameras} `
          + 'registered, non-collinear 3D camera positions', 'debug', 'Reconstruction')
        return
      }
      const camList = uuidList.map((u) => cameras.get(u))
      const camIdxOf = new Map(uuidList.map((u, i) => [u, i]))
      log(`camera-prior bundle adjustment (round ${round + 1}/${cfg.cameraPriorBaRounds}) — `
        + `${constrained.priors.length} camera(s), seed RMS ${constrained.fit.rms.toPrecision(3)} project units`,
      'info', 'Reconstruction')
      // Experiment (cameraPriorRefineIntrinsics): let the GNSS-constrained solve re-estimate
      // focal / principal point / distortion. With fixed K a self-calibration that is
      // slightly wrong (the nadir focal–height correlation that domes a block) cannot be
      // corrected by the priors: the quarry stalled at 0.43 m centre residual against
      // ±3 cm RTK. Routed through runBundleAdjust so the distortion fold, the composed
      // self-cal record and the self-cal validation all apply exactly as elsewhere.
      // 'auto' takes the mode of the last post-filter pass (refinePipeline.js records it).
      if (cfg.cameraPriorRefineIntrinsics && cfg.cameraPriorRefineIntrinsics !== 'none') {
        const mode = cfg.cameraPriorRefineIntrinsics === 'auto'
          ? (selfCalRecord.passes.at(-1)?.mode ?? refineIntrinsics) : cfg.cameraPriorRefineIntrinsics
        const r = await runBundleAdjust(`camera-prior bundle adjustment (round ${round + 1}, intrinsics '${mode}')`,
          baIterations, mode, { cameraPriors: constrained.priors })
        if (!r) return
        log(`camera-prior bundle adjustment centre residual → `
          + `${(r.cameraPriorRmsAfter * constrained.fit.scale).toPrecision(3)} project units`, 'success', 'Reconstruction')
        continue
      }
      const ptIds = tracks.liveIds()
      const lf = lensFrame(uuidList, camList.map((c) => c.K),
        buildBaObservations(tracks, ptIds, camIdxOfImg(camIdxOf), keypointsAt))
      const result = await bundleAdjust(camList, lf.kList, trackPositions(tracks, ptIds), lf.observations, {
        maxIters: baIterations, refineIntrinsics: 'none', flatPoints: true,
        sensorOfCam: uuidList.map((u) => sensorIntByUuid.get(u) ?? -1),
        cameraPriors: constrained.priors, solver: cfg.baSolver,
      })
      noteBaSolver(`camera-prior bundle adjustment (round ${round + 1})`, result)
      if (!result) return
      if (!cameraPriorReprojectionAccepts(result)) {
        log(`camera-prior bundle adjustment REJECTED — reprojection RMS `
          + `${result.costBefore.toFixed(2)}px → ${result.costAfter.toFixed(2)}px exceeds the safety bound`,
        'warn', 'Reconstruction')
        return
      }
      uuidList.forEach((uuid, ci) => cameras.set(uuid, { ...cameras.get(uuid), ...result.cameras[ci] }))
      setTrackPositions(ptIds, result.pos)
      log(`camera-prior bundle adjustment RMS ${result.costBefore.toFixed(2)}px → `
        + `${result.costAfter.toFixed(2)}px; centre residual → `
        + `${(result.cameraPriorRmsAfter * constrained.fit.scale).toPrecision(3)} project units`,
      'success', 'Reconstruction')
    }
  }

  // GCP-in-BA (F2, deferred half): once the pipeline has settled, pull the
  // triangulated position of each GCP toward its surveyed position via
  // bundle.rs's anchor residual — GCPs constrain the reconstruction directly
  // rather than only fitting a post-hoc similarity. `gcps[].observations` are
  // pre-resolved to `{ uuid, px, py, accuracyX, accuracyY }` (the store maps imageId → uuid before
  // crossing into the worker).
  //
  // Runs (triangulate → fit → anchored BA) twice — hard-coded, not a user
  // setting — as cheap insurance against a poor seed similarity on the first
  // pass; the *actual* georeference used for products is a fresh post-hoc fit
  // (useReconstructionStore.georeference()) run on demand against whatever
  // cameras this leaves in the sparse cloud, so this step only needs to be
  // "good enough to help the poses converge", not final.
  async function runGcpAnchoredBundleAdjust() {
    const qualifying = qualifyingGcps(gcps, cameras)
    if (qualifying.length < 3) {
      if (gcps.length) {
        log(`GCP anchoring skipped (${qualifying.length}/3 GCPs `
          + `with ≥2 registered views)`, 'debug', 'Reconstruction')
      }
      return
    }

    for (let round = 0; round < 2; round++) {
      const uuidList = [...cameras.keys()]
      const camList = uuidList.map((u) => cameras.get(u))
      const kList = camList.map((c) => c.K)
      const sensorOfCam = uuidList.map((u) => sensorIntByUuid.get(u) ?? -1)
      const camIdxOf = new Map(uuidList.map((u, i) => [u, i]))
      const ptIds = tracks.liveIds()
      const setup = await buildGcpAnchors({ cameras, qualifying, camIdxOf, firstPointIndex: ptIds.length })
      if (setup.error) {
        log(`GCP anchoring stopped (${setup.error})`, 'warn', 'Reconstruction')
        return
      }
      const { fit, frame, anchorPts, anchors } = setup
      // GCPs define the one project↔SfM similarity for all survey constraints
      // in this joint pass, keeping point and camera targets in the same gauge.
      const constrainedCameras = buildCameraPriorConstraints(uuidList, { fit, frame })

      log(`GCP-anchored bundle adjustment (round ${round + 1}/2) — `
        + `${anchors.length} GCP(s), seed scale ${fit.scale.toPrecision(4)}, `
        + `seed RMS ${fit.rms.toPrecision(3)}`, 'info', 'Reconstruction')

      // With enough control, let the anchored solve re-estimate the intrinsics, as
      // Metashape's GCP optimisation does. Fixed K cannot undo a focal error: over a
      // nadir block f and flying height trade off, so the free network's relief scales
      // with it and only control at different heights pins it down. Casa Grande 1978
      // (certificate 152.9 mm, self-cal 5687 px, Metashape with GCPs ≈ 133 mm): fixed K
      // left checkpoints at 8.6 m vertical RMS. Routed through runBundleAdjust, so the
      // self-cal validation, the distortion fold (GCP marks move with it) and the
      // composed self-cal record apply exactly as in every other pass.
      const gcpMode = cfg.gcpRefineIntrinsics === 'auto'
        ? (selfCalRecord.passes.at(-1)?.mode ?? refineIntrinsics) : (cfg.gcpRefineIntrinsics ?? 'none')
      if (gcpMode && gcpMode !== 'none' && anchors.length >= (cfg.gcpRefineIntrinsicsMinGcps ?? 5)) {
        const r = await runBundleAdjust(`GCP-anchored bundle adjustment (round ${round + 1}, intrinsics '${gcpMode}')`,
          baIterations, gcpMode, { cameraPriors: constrainedCameras?.priors ?? null, gcp: setup })
        if (!r) return
        log(`GCP-anchored bundle adjustment anchor residual → ${(r.anchorRmsAfter * fit.scale).toPrecision(3)} project units`,
          'success', 'Reconstruction')
        continue
      }

      const lf = lensFrame(uuidList, kList, appendObservations(
        buildBaObservations(tracks, ptIds, camIdxOfImg(camIdxOf), keypointsAt), setup.observations))

      const result = await bundleAdjust(camList, lf.kList, trackPositions(tracks, ptIds, anchorPts), lf.observations,
        { maxIters: baIterations, refineIntrinsics: 'none', sensorOfCam, gcpAnchors: anchors, flatPoints: true,
          cameraPriors: constrainedCameras?.priors ?? [], solver: cfg.baSolver })
      noteBaSolver(`GCP-anchored bundle adjustment (round ${round + 1})`, result)
      if (!result) {
        log('GCP-anchored bundle adjustment returned no result (skipped)', 'warn', 'Reconstruction')
        return
      }
      // Like a camera-prior solve, an anchored solve is SUPPOSED to trade some image
      // residual for geometry: pulling a domed or bent free network onto its control
      // costs reprojection by construction. So it is judged by the same bounded-increase
      // rule, not "cost must fall". The old 0.01 px gate rejected Casa Grande's 1978
      // block at 1.69 → 1.71 px and left its checkpoints at 10.6 m vertical RMS.
      if (result.costAfter > result.costBefore + 0.01 && !cameraPriorReprojectionAccepts(result)) {
        log(`GCP-anchored bundle adjustment REJECTED — reprojection RMS `
          + `${result.costBefore.toFixed(2)}px → ${result.costAfter.toFixed(2)}px exceeds the survey-constraint safety bound`,
        'warn', 'Reconstruction')
        return
      }
      uuidList.forEach((uuid, ci) => {
        cameras.set(uuid, { ...cameras.get(uuid), ...result.cameras[ci] })
      })
      // Only the original (non-anchor) points are kept — the synthetic anchor
      // points were scratch space for this BA pass, not real SIFT tracks.
      setTrackPositions(ptIds, result.pos)
      log(`GCP-anchored bundle adjustment RMS ${result.costBefore.toFixed(2)}px → `
        + `${result.costAfter.toFixed(2)}px, anchor residual → ${(result.anchorRmsAfter * fit.scale).toPrecision(3)} project units`
        + (constrainedCameras ? `, camera-centre residual → `
          + `${(result.cameraPriorRmsAfter * fit.scale).toPrecision(3)} project units` : ''),
        'success', 'Reconstruction')
    }
  }

  return {
    runBundleAdjust, runLocalBundleAdjust, runCameraPriorBundleAdjust, runGcpAnchoredBundleAdjust,
    solverTotals: baSolverTotals,
  }
}

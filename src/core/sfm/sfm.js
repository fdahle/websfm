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

import { triangulateDlt, bundleAdjust } from './reconstruction.js'
import { projectPoint, medianTriangulationAngle, triangulationAngle } from './geometry.js'
import { undistortPixel } from './distortion.js'
import { markToCentrePx } from './displayFrame.js'
import {
  applyFiducialFrames, resolveIntrinsics, gcpObservationMover, undistortAtIngest, refitMovedPairs,
} from './ingest.js'
import { makeProgressReporter, scopeProgress, RUN_BUDGET, sliceRange } from './progressPlan.js'
import {
  toNorm, camToP34flat, reprojErr, retriangulatePairs, mergeSplitTracks,
  pruneFinalTwoViewTracks, completeTracks,
} from './tracks.js'
import { selectInitPair } from './initPair.js'
import { registerImages } from './register.js'
import {
  stagedSelfCalTerms, stagedSelfCalDeferred, SELF_CAL_BASE_TERMS,
  distortionIdentifiable, withoutDistortionTerms,
} from './selfCalSchedule.js'
import { fitComposedRadial, radialCurveOk } from './selfCalCompose.js'
import { validateSelfCalUpdate } from './selfCalGuard.js'
import { adaptiveReprojThreshold, CLEANUP_THRESHOLD_DEFAULTS } from './cleanupThreshold.js'
import { buildCameraPriorConstraints as buildSurveyPriorConstraints, qualifyingGcps, buildGcpAnchors } from './surveyConstraints.js'
import { graphHealth } from '../eval/matchGraph.js'
import { RECONSTRUCT_DEFAULTS } from '../defaults.user.js'
import { SFM_TUNING } from '../tuning.js'
import { buildScaleContext, describeScaleContext, resolveScaledPx } from '../scaleContext.js'
import { secondaryJobs, alignSecondary, mergeAligned } from './multiModel.js'
import { compactPointRecords } from './resultCodec.js'
import { wrapPackedMatches } from './matchCodec.js'
import { compareRobustCost, projectFull } from './baAcceptance.js'
import { guidedExtendTracks, auditGuidedAdditions } from './guidedExtension.js'
import { buildBaObservations, appendObservations } from './baObservations.js'

// Re-export the extracted pure modules so existing importers (sfm.test.js and any
// others that reached for these through sfm.js) keep working unchanged.
export { retriangulatePairs, mergeSplitTracks, pruneFinalTwoViewTracks, completeTracks }

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

async function reconstructSingleModel(input, hooks = {}) {
  const { images, pairs, settings = {}, gcps = [], cameraPriors = [] } = input
  // GCP marks arrive in the viewer's pixel-edge convention; keypoints, K and every
  // projection use pixel centres (displayFrame.js markToCentrePx). Convert once, before
  // the film remap and the distortion moves below treat them exactly like keypoints.
  // `input` is this sub-run's own copy (cloneSfmInput), so this never compounds.
  for (const g of gcps) {
    for (const o of g.observations || []) {
      if (Number.isFinite(o.px)) o.px = markToCentrePx(o.px)
      if (Number.isFinite(o.py)) o.py = markToCentrePx(o.py)
    }
  }
  // Resolve knobs from the single-source-of-truth constants, letting caller-supplied
  // `settings` (from the modal / a dev experiment override) win. User-facing defaults
  // live in defaults.user.js (mirrored by ReconstructModal); internal ones in tuning.js.
  const cfg = { ...RECONSTRUCT_DEFAULTS, ...SFM_TUNING, ...settings }
  const log = hooks.onLog ?? (() => {})

  // ── Run record (baseline bookkeeping) ────────────────────────────────────────
  // Everything below feeds `summary` so the Debug ▸ Project Summary digest can state
  // WHAT was run, not just how it scored — a measured number without its settings is
  // not a baseline. Captured HERE, before the 'auto' resolutions and the detect-px →
  // native-px gate scaling below mutate `cfg`, so these are the knobs as *requested*.
  const runConfig = {
    minMatchesForRegistration: cfg.minMatchesForRegistration,
    reprjThresholdDetectPx: cfg.reprjThreshold,
    filterMaxReprojDetectPx: cfg.filterMaxReprojPx,
    baIterations: cfg.baIterations,
    refineIntrinsics: cfg.refineIntrinsics,
    secondaryModels: settings.secondaryModels !== false,
    selfCalMaxFocalStepFrac: cfg.selfCalMaxFocalStepFrac,
    selfCalMaxFocalNominalFrac: cfg.selfCalMaxFocalNominalFrac,
    selfCalGuessFocalStepFrac: cfg.selfCalGuessFocalStepFrac,
    selfCalGuessFocalNominalFrac: cfg.selfCalGuessFocalNominalFrac,
    selfCalMaxPrincipalOffsetFrac: cfg.selfCalMaxPrincipalOffsetFrac,
    selfCalMaxCornerShiftFrac: cfg.selfCalMaxCornerShiftFrac,
    cameraPositionPriors: cameraPriors.length,
    cameraOrientationPriors: cameraPriors.filter((p) =>
      [p.omega, p.phi, p.kappa].every(Number.isFinite)).length,
  }
  // Filled in below as each stage runs; every field stays null when its stage
  // didn't run, so a missing number is never confused with a zero.
  let gateRecord = null       // resolved reprojection gates + the detection-scale factor
  let guidedRecord = null     // projection-guided track extension (guidedExtension.js)
  const guidedAdds = []       // its accepted observations, audited after the final pass
  const selfCalRecord = { requested: cfg.refineIntrinsics, resolved: null, staged: false, passes: [], adjustments: [] }
  const intrinsicsRecord = new Map() // sensorId → { fxNominal, fxFinal, cx, cy, source, label }
  // Final-stage track completion, one row per pass (completeTracksFinal below).
  const trackCompletionRecord = []

  // Reprojection gates are configured in DETECTION pixels but applied to keypoints
  // in NATIVE pixels, so resolve them against this set's detection scale before
  // anything reads them. Done here, on `cfg`, because both consumers (this
  // orchestrator's BA/filter passes and register.js's PnP gates) destructure from
  // it — there is no second place to keep in sync. A set detected at full
  // resolution has factor 1 and every value resolves to itself.
  //
  // A nested run (seed retry / secondary model) receives the already-resolved
  // factor through `settings` so it cannot re-derive a different one from its
  // camera subset — the gates must mean the same thing in every sub-run.
  {
    // `reconstruct()` resolves the factor once from the FULL image set and injects
    // it, so a secondary model built from a stranded subset cannot derive a
    // different one — a gate that means different things in the primary and
    // secondary frames would make the merge gates incomparable. The fallback
    // covers direct callers (tests, a dev harness) that skip that entry point.
    const injected = Number.isFinite(settings.detectScaleFactor)
    const scaleCtx = injected
      ? { n: images.length, factor: settings.detectScaleFactor }
      : buildScaleContext(images)
    cfg.detectScaleFactor = scaleCtx.factor

    if (scaleCtx.factor !== 1 || scaleCtx.mixed) {
      // Only the deriving run reports the inputs behind the factor; an inheriting
      // sub-run has no set of its own to describe and would be fabricating them.
      if (!injected) log(describeScaleContext(scaleCtx, 'Reprojection gates'),
        scaleCtx.clamped ? 'warn' : 'info', 'SfM')
      log(`Gates resolved (detect-px → native px, ×${scaleCtx.factor.toFixed(2)}): `
        + `PnP/BA ${cfg.reprjThreshold} → ${resolveScaledPx(cfg.reprjThreshold, scaleCtx).toFixed(2)}px, `
        + `track filter ${cfg.filterMaxReprojPx} → ${resolveScaledPx(cfg.filterMaxReprojPx, scaleCtx).toFixed(2)}px`,
      'info', 'SfM')
    }
    cfg.reprjThreshold    = resolveScaledPx(cfg.reprjThreshold, scaleCtx)
    cfg.filterMaxReprojPx = resolveScaledPx(cfg.filterMaxReprojPx, scaleCtx)
    // Recorded even when the factor is 1: "no correction applied" is itself the
    // measurement the data-relative-gates work needs from a full-resolution set.
    gateRecord = {
      detectScaleFactor: scaleCtx.factor,
      inherited: injected,
      medianScale: injected ? null : scaleCtx.medianScale,
      minScale: injected ? null : scaleCtx.minScale,
      maxScale: injected ? null : scaleCtx.maxScale,
      clamped: injected ? false : !!scaleCtx.clamped,
      mixed: injected ? false : !!scaleCtx.mixed,
      reprjThresholdPx: cfg.reprjThreshold,
      filterMaxReprojPx: cfg.filterMaxReprojPx,
    }
  }
  // Progress is phase-weighted (core/sfm/progressPlan.js), not a camera count: the
  // count reaches its maximum at the end of registration, which is roughly halfway
  // through the run. `hooks.progressRange` lets a nested sub-run (seed retry /
  // secondary model) report an honest local 0..1 into a slice of the parent's bar.
  const onProgress = hooks.onProgress
  const report = makeProgressReporter(onProgress, hooks.progressRange ?? {})

  // uuid → image, built once: it was a linear `images.find` per call, and it is called
  // per observation (BA, residuals) and per candidate keypoint (guided extension). The
  // image list never changes within a run; folds replace `img.keypoints` on the same
  // object, so the map stays valid. First occurrence wins, as `find` did.
  const imageMap = new Map()
  for (const img of images) if (!imageMap.has(img.uuid)) imageMap.set(img.uuid, img)
  const imageByUuid = (uuid) => imageMap.get(uuid) || null
  // An image's keypoint by index (null when either is missing). Shared by the BA
  // observation builders, the track functions and guided extension.
  const keypointOf = (uuid, kpIdx) => imageByUuid(uuid)?.keypoints?.[kpIdx] ?? null

  // Local model state (was reactive refs in the store).
  const cameras = new Map()  // uuid → { R, t, K }
  let points3d = []          // [{ x, y, z, views: Map<uuid, kpIdx> }]

  // Only 'done' pairs participate (the store passes those, but keep the guard
  // so the algorithm reads identically to the original).
  //
  // WS1 — strong vs weak split. A WEAK pair (valid F, enough inliers, but below the
  // match accept gate) is a registration-only bridge: it must NEVER drive
  // init-pair selection or fresh triangulation (its geometry isn't trusted
  // enough to seed structure). It only contributes 2D-3D correspondences to PnP. So
  // `donePairs` (everything the strong path reads) excludes weak pairs; `weakPairs` is
  // merged back in solely for register.js's correspondence collection (`corrPairs`).
  // A REJECTED pair also carries status 'done' (with inlierCount 0 / no matches / no F),
  // so both filters must gate on inlierCount — otherwise rejects ride into donePairs and
  // the graph-health union-find fuses the whole set into one phantom component.
  const donePairs = pairs.filter((e) => e.status === 'done' && !e.weak && e.inlierCount > 0)
  const weakPairs = pairs.filter((e) => e.status === 'done' && e.weak && e.inlierCount > 0)

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
  let stageMark = t0
  const markStage = (label) => {
    const now = performance.now()
    stageTimes[label] = now - stageMark
    stageMark = now
    log(`stage "${label}" took ${(stageTimes[label]).toFixed(0)}ms`, 'debug', 'Reconstruction')
  }
  // A finer boundary than markStage for memory measurement only: the bench samples the
  // worker heap and attributes each peak to the segment the next mark closes
  // (scripts/bench/workerHeap.mjs). Debug level; not part of the run record.
  const memoryMark = (label) => log(`memory mark "${label}"`, 'debug', 'Reconstruction')

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
    // Fold the solver's Map tracks directly into shared CSR buffers. Creating an
    // intermediate [uuid,kp,x,y] array for each observation made finalisation's
    // peak proportional to millions of JS objects and could kill the worker after
    // it had already logged success. The slices remain iterable/Map-compatible for
    // secondary-model alignment and callers of this pure module.
    points: compactPointRecords(points3d, {
      colorOf: ({ views }) => pointColor(views),
      pixelOf: (uuid, kpIdx) => {
        const kp = imageByUuid(uuid)?.keypoints?.[kpIdx]
        return kp ? [kp.x, kp.y] : null
      },
      // `done()` is terminal for this solver instance. Releasing each mutable
      // Map-backed point as it is packed keeps finalisation below the solve peak.
      consume: true,
    }),
    summary,
  })

  try {
    const imgs = images.filter((img) => img.kpStatus === 'done')
    if (imgs.length < 2) {
      log('need at least 2 images with keypoints', 'warn', 'Reconstruction')
      return done('idle')
    }
    log(`starting with ${imgs.length} images, ${donePairs.length} match pairs`
      + `${weakPairs.length ? ` (+${weakPairs.length} weak PnP bridge${weakPairs.length === 1 ? '' : 's'})` : ''}`,
      'info', 'Reconstruction')

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
      log(`match graph — ${sizes.length} component(s), largest ${sizes[0] ?? 0}/${imgs.length} images`
        + `${isolated ? `, ${isolated} isolated` : ''}; median ${med([...deg.values()])} pairs/image, `
        + `median ${med(donePairs.map((e) => e.inlierCount))} inliers/pair`,
        (sizes[0] ?? 0) < imgs.length ? 'warn' : 'info', 'Reconstruction')
    }

    // ── Ingest: film frames, K, ingest undistortion, F refit (ingest.js) ─────
    const fiducialTransforms = applyFiducialFrames({ imgs, gcps, log })
    const { Kmap, defaultKCount } = resolveIntrinsics({ imgs, intrinsicsRecord, log })
    const moveGcpObs = gcpObservationMover(gcps)
    const { anyCalibratedDistortion, undistortedUuids } = undistortAtIngest({ imgs, Kmap, moveGcpObs, log })
    refitMovedPairs({
      donePairs, imageByUuid, log,
      movedUuids: new Set([...undistortedUuids, ...fiducialTransforms.keys()]),
    })

    // ── Resolve 'auto' self-calibration ──────────────────────────────────────
    // A guessed pinhole (EXIF-only cameras, film scans) is the single biggest
    // source of downstream error: a 24 mm lens has tens of px of uncorrected
    // radial distortion, and a wrong film pitch skews focal ~10%. When no sensor
    // carries a *calibrated* distortion model, solve one shared focal + radial k1
    // in BA (folded back into keypoints after each pass — see CLAUDE.md). When a
    // calibrated Brown model already removed distortion at ingest, leave it off so
    // we don't double-correct.
    if (cfg.refineIntrinsics === 'auto') {
      if (anyCalibratedDistortion) {
        cfg.refineIntrinsics = 'none'
        log(`refineIntrinsics 'auto' → 'none' `
          + '(a calibrated distortion model exists — self-cal off to avoid double-correcting)',
          'info', 'Reconstruction')
      } else {
        // Staged self-cal (WS2): registration + rescue solve the base 'f,k1'; the
        // post-filter passes escalate to k2 / principal-point / k3 as the camera and
        // observation counts allow (selfCalSchedule.js). `selfCalStaged` flags that the
        // post-filter refineMode is computed per pass rather than fixed.
        cfg.refineIntrinsics = SELF_CAL_BASE_TERMS
        cfg.selfCalStaged = true
        log(`refineIntrinsics 'auto' → staged (base '${SELF_CAL_BASE_TERMS}', `
          + 'escalating to cx,cy / k2 / k3 in post-filter passes as the model grows)',
          'info', 'Reconstruction')
      }
    }
    selfCalRecord.resolved = cfg.refineIntrinsics
    selfCalRecord.staged = !!cfg.selfCalStaged

    if (defaultKCount > 0) {
      log(`${defaultKCount}/${imgs.length} image(s) have no focal length — using a default FOV guess. `
        + `Wrong intrinsics distort the geometry and commonly prevent cameras from registering; `
        + `supply a focal length or sensor size for reliable results.`,
        defaultKCount === imgs.length ? 'warn' : 'info', 'Reconstruction')
    }

    // Two-view initialisation + seed selection lives in initPair.js. It probes
    // every candidate (pose recovery + triangulation + cheirality + init reproj)
    // and returns a sound seed with strong one-step growth support; the local helpers
    // it needs are injected so it stays pure (no cycle back into this file).
    const initSel = await selectInitPair(
      { donePairs, Kmap, settings: cfg, imageByUuid, numStats, projDepth },
      {
        onLog: log,
        onProgress: onProgress
          ? (k, m) => report('initPair', m > 0 ? (k + 1) / m : 0,
            `Scoring initial pairs ${k + 1}/${m}…`, { done: k + 1, total: m })
          : undefined,
      },
    )
    if (initSel.status !== 'ok') return done(initSel.status)
    const { best, perPairInitReproj } = initSel

    const bestPair = best.entry
    const imgA = best.iA
    const imgB = best.iB
    cameras.set(bestPair.idA, best.cA)
    cameras.set(bestPair.idB, best.cB)
    points3d = best.points
    // `points3d` initially aliases best.points and registration appends to it until
    // the first BA replaces the array. Snapshot now; otherwise diagnostics.seed.points
    // accidentally reports the model size at first BA rather than the seed size.
    const seedPointCount = best.points.length

    log(`initial pair ${imgA.name} ↔ ${imgB.name} `
      + `(${best.inliers} inliers, ${best.points.length} pts, ${best.angle.toFixed(2)}° parallax)`,
      'success', 'Reconstruction')
    log(`init reprojection — ${fmtStats(modelReprojStats())}`, 'debug', 'Reconstruction')
    // Essential-matrix conditioning: σ2/σ1 ≈ 1 for a valid E. A low ratio means
    // F→E used wrong intrinsics, which inflates init reprojection and typically
    // blocks PnP registration of otherwise well-connected images.
    {
      const { s1, s2, s3 } = best.esv
      const ratio = s1 > 0 ? s2 / s1 : 0
      // Only flag intrinsics when the ratio is genuinely low. A healthy E sits at
      // ~0.95–1.0, so the old unconditional "well below 1 → wrong focal" note fired on
      // every init (0.98 is fine) and read as an alarm — append it only below 0.9.
      const conditioning = ratio < 0.9
        ? ' — well below 1 points to wrong intrinsics (focal / principal point), which '
          + 'inflates init reprojection and typically blocks PnP registration'
        : ''
      log(`essential matrix σ = [${s1.toFixed(3)}, ${s2.toFixed(3)}, ${s3.toFixed(3)}] — `
        + `σ2/σ1 ${ratio.toFixed(2)} (ideal ≈ 1.0)${conditioning}`,
        ratio < 0.7 ? 'warn' : 'debug', 'Reconstruction')
    }
    markStage('init')
    report('initPair', 1, `Initial pair: ${imgA.name} ↔ ${imgB.name}`, { done: 2, total: imgs.length })

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
    // Defaults + rationale for these live in defaults.user.js (baIterations,
    // refineIntrinsics) and tuning.js (the rest); `cfg` already merged them.
    const {
      baIterations,
      filterMaxReprojPx,
      filterMinTriAngleDeg,
      finalMinTrackViews,
      finalTrackPruneMinCount,
      finalTrackPruneMinShare,
      refineIntrinsics,
      interimBaEvery,
      interimBaIterations,
    } = cfg

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
    // endpoint already belongs to a point is simply lost, leaving tracks 2-view. One
    // round of tracks.js `completeTracks` over the live index (`cameras` holds exactly
    // the registered images): for every verified match between two registered images
    // where exactly one endpoint is assigned, add the other endpoint when it reprojects
    // within `gate`. Directly raises the ≥3-view share and BA conditioning. The final
    // stage runs the same function to a fixpoint (completeTracksFinal below).
    const foldOneEndpointMatches = (gate) => completeTracks({
      points3d, cameras, pairs: donePairs,
      keypointOf,
      maxReprojPx: gate, index: viewIndex, addView,
    }).added

    // Consolidate split tracks: the *both*-endpoints-assigned case foldOneEndpointMatches
    // skips (line above) — a verified match whose two ends already belong to two DIFFERENT
    // points means one physical feature was reconstructed twice. mergeSplitTracks folds the
    // loser into the winner (conflict- + reproj-gated). It ran only once post-BA before, so
    // the model grew mostly 2-view during registration (the building run finished at 15%
    // ≥3-view tracks); running it in the interim cleanup as the model builds raises track
    // multiplicity early, which both conditions BA better and gives later PnP longer, more
    // stable points. Reassigns points3d (the module `let`) like filterTracks; callers
    // rebuildViewIndex afterwards. Same maxReprojPx gate as the post-BA merge.
    const mergeTracks = (gate) => {
      const res = mergeSplitTracks({
        points3d, cameras, pairs: donePairs,
        keypointOf,
        maxReprojPx: gate,
      })
      points3d = res.points3d
      return res.merged
    }

    // Self-calibrated distortion bookkeeping (WS2). The sparse pipeline folds the
    // distortion out of the keypoints each self-cal pass (exact, in place); dense and
    // the run summary need ONE composed {k1,k2,k3} bag per sensor to reproduce that
    // fold on the rasters. `pristineKpByUuid` snapshots each eligible image's keypoints
    // *before the first fold* (post-ingest = pristine), and `selfCalDistBySensor` holds
    // the composed bag fitted from pristine→folded after each pass (selfCalCompose.js) —
    // replacing the old additive-k1 sum, which was wrong beyond first order. Declared
    // *before* registerImages: the interim BA self-calibrates f,k1 mid-registration
    // (D3), so runBundleAdjust's fold reads these during the registration call.
    const pristineKpByUuid = new Map()      // uuid → keypoints snapshot (pre-fold)
    const foldedTermsBySensor = new Map()   // sensorInt → { k2, k3 } ever folded into its keypoints
    const selfCalDistBySensor = new Map()   // sensorId → { k1, k2, k3, fitRmsPx }

    // ── Incremental registration ───────────────────────────────────────────
    // Grow the sparse model one camera at a time — next-best-view ordering,
    // two-gate PnP, track extension/triangulation, interleaved BA. Extracted to
    // register.js (see there). registeredUuids is created HERE because the hoisted
    // foldOneEndpointMatches closure (above) reads it; points3d is a `let` the
    // injected BA/filter closures reassign, so register.js accesses it through the
    // live getPoints3d() getter rather than a captured reference.
    const registeredUuids = new Set([bestPair.idA, bestPair.idB])
    await registerImages({
      imgs, donePairs, Kmap, cfg,
      // corrPairs = strong + weak bridges. register.js draws PnP
      // correspondences from this superset but triangulates fresh structure only from
      // donePairs — weak pairs extend registration reach without seeding geometry.
      corrPairs: [...donePairs, ...weakPairs],
      cameras, viewIndex, registeredUuids,
      getPoints3d: () => points3d,
      addView, rebuildViewIndex, foldOneEndpointMatches, mergeTracks,
      runBundleAdjust, filterTracks, modelReprojStats, imageByUuid, numStats,
      log, onProgress,
      reportPhase: (local, label, counts) => report('register', local, label, counts),
    })
    const preBaStats = modelReprojStats()
    log(`pre-BA reprojection — ${fmtStats(preBaStats)}`, 'info', 'Reconstruction')
    markStage('registration')

    // ── Bundle adjustment + track filtering (Phase 2 + 3) ────────────────────
    // (BA settings + the sensor-group map are hoisted above the registration loop
    // so R3's interleaved solves can reuse them.)

    // Run one global bundle adjustment, apply it (guarded: never commit a result
    // that worsens the cost), and log RMS / convergence trace. Reused for the interim
    // (R3) solves and each post-filter re-solve. `refineMode` overrides `refineIntrinsics`
    // per call: interim/pre-filter solves pass 'none' (self-calibration against the
    // pre-filter mess drifted cx/cy 180px on B1), only post-filter passes refine.
    // `cameraPriors` (optional) adds GNSS/pose centre constraints. A prior-constrained
    // solve is SUPPOSED to trade some image residual for geometry, so it is judged by
    // the bounded-increase rule (cameraPriorReprojectionAccepts), not "cost must fall".
    async function runBundleAdjust(label, iters, refineMode = refineIntrinsics, { cameraPriors = null } = {}) {
      if (!(cameras.size >= 2 && points3d.length >= 10 && iters > 0)) {
        log(`${label} skipped (cameras=${cameras.size}, `
          + `points=${points3d.length}, iters=${iters})`, 'debug', 'Reconstruction')
        return
      }
      const uuidList = [...cameras.keys()]
      const camList  = uuidList.map((u) => cameras.get(u))
      const kList    = camList.map((c) => c.K)
      const sensorOfCam = uuidList.map((u) => sensorIntByUuid.get(u) ?? -1)
      const camIdxOf = new Map(uuidList.map((u, i) => [u, i]))

      const observations = buildBaObservations(points3d, (u) => camIdxOf.get(u), keypointOf)
      log(`${label} — ${camList.length} cameras, ${points3d.length} points, `
        + `${observations.n} observations, ${iters} iters`, 'info', 'Reconstruction')
      // Diagnostic: where do the gross pre-solve residuals sit? Grouped by camera, split
      // by the observed point's track length (2 = freshly triangulated, ≥3 = extended).
      {
        const { cam: oCam, pt: oPt, x: oX, y: oY } = observations
        const errs = new Array(observations.n)
        for (let i = 0; i < observations.n; i++) {
          const q = projectFull(camList[oCam[i]], kList[oCam[i]], points3d[oPt[i]])
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
          rec.n++; if (points3d[oPt[i]].views.size <= 2) rec.fresh++
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

      const result = await bundleAdjust(camList, kList, points3d, observations,
        { maxIters: iters, refineIntrinsics: refineMode, sensorOfCam, solver: cfg.baSolver,
          ...(cameraPriors ? { cameraPriors } : {}) })
      noteBaSolver(label, result)
      if (!result) {
        log(`${label} returned no result (skipped)`, 'warn', 'Reconstruction')
        return
      }
      if (cameraPriors && !cameraPriorReprojectionAccepts(result)) {
        log(`${label} REJECTED — reprojection RMS ${result.costBefore.toFixed(2)}px → `
          + `${result.costAfter.toFixed(2)}px exceeds the camera-prior safety bound`, 'warn', 'Reconstruction')
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
      if (!cameraPriors && result.costBefore != null && result.costAfter != null && result.costAfter > result.costBefore) {
        const delta = result.costAfter - result.costBefore
        const afterKs = refineMode !== 'none' && result.intrinsics
          ? kList.map((k, ci) => ({ ...k, ...result.intrinsics[ci] })) : kList
        const robust = compareRobustCost({
          before: { cams: camList, Ks: kList, points: points3d },
          after: { cams: result.cameras, Ks: afterKs, points: result.points3d },
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

      // Self-calibration is destructive only after this point: accepted radial terms
      // are folded into every image's keypoints. Validate the detached BA result first,
      // and reject the whole update transaction if any shared sensor is implausible.
      // Reprojection cost alone cannot catch focal/distortion overfit on thin blocks.
      if (refineMode !== 'none' && result.intrinsics) {
        const checkedGroups = new Set()
        const proposals = []
        let rejected = null
        for (let ci = 0; ci < uuidList.length; ci++) {
          const group = sensorOfCam[ci]
          const groupKey = group >= 0 ? `sensor:${group}` : `camera:${ci}`
          if (checkedGroups.has(groupKey)) continue
          checkedGroups.add(groupKey)
          const uuid = uuidList[ci]
          const img = imageByUuid(uuid)
          const sid = img?.sensorId ?? `image:${uuid}`
          const rec = intrinsicsRecord.get(sid)
          const nominalFx = rec?.fxNominal ?? kList[ci]?.fx
          // A default-FOV focal is a guess, not a measurement: wide bounds (selfCalGuard.js).
          const focalIsGuess = !!rec?.source?.startsWith('default')
          const width = img?.meta?.width ?? img?.width ?? 0
          const height = img?.meta?.height ?? img?.height ?? 0
          const proposed = result.intrinsics[ci]
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
        // so subsequent BA passes and reprojection stats use the calibrated focal.
        const K = refineMode !== 'none' && result.intrinsics
          ? { ...old.K, ...result.intrinsics[ci] }
          : old.K
        cameras.set(uuid, { ...old, ...result.cameras[ci], K })
      })
      points3d = result.points3d.map((pt, i) => ({ ...pt, views: points3d[i].views }))

      // Self-calibration report: one line per sensor group (before → after focal, the
      // refined principal-point offset + radial coeffs, and the implied film width).
      // Never written back to the sensor table — the user decides whether to adopt it.
      const wantsCxcy = refineMode.includes('cxcy')
      if (refineMode !== 'none' && result.intrinsics) {
        const seen = new Set()
        uuidList.forEach((uuid, ci) => {
          const g = sensorOfCam[ci]
          if (g < 0 || seen.has(g)) return
          seen.add(g)
          const rk = result.intrinsics[ci]
          const fx0 = kList[ci].fx, fx1 = rk.fx
          const pct = fx0 ? (100 * (fx1 - fx0) / fx0) : 0
          let implied = ''
          const w0 = kList[ci].impliedFilmWidthMm
          if (w0 != null && fx1) implied = `, implied film width ${w0.toFixed(0)}mm → ${(w0 * fx0 / fx1).toFixed(0)}mm`
          const cxcy = wantsCxcy
            ? `, cx ${kList[ci].cx.toFixed(1)}→${rk.cx.toFixed(1)}, cy ${kList[ci].cy.toFixed(1)}→${rk.cy.toFixed(1)}` : ''
          // Refined shared radial coeffs (copy the non-zero ones into the sensor table).
          const kterms = ['k1', 'k2', 'k3']
            .filter((k) => rk[k])
            .map((k) => `${k} ${rk[k].toFixed(5)}`)
          const kdist = kterms.length ? `, ${kterms.join(', ')}` : ''
          log(`${label} self-calibration — sensor group ${g}: `
            + `fx ${fx0.toFixed(1)} → ${fx1.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)${cxcy}${kdist}${implied}`,
            'info', 'Reconstruction')
        })
        log(`${label} self-calibration is weakly observed on short/single strips `
          + `(needs ≥2° tilt variation for a trustworthy focal); review before updating the sensor table.`,
          'debug', 'Reconstruction')
      }

      // ── Fold self-calibrated distortion back into the keypoints (WS2) ─────────
      // BA estimates shared radial coeffs (k1,k2,k3), but the rest of the pipeline is
      // pure pinhole (projectPoint, the track filter, reprojection stats, the
      // dense/ortho warp) — coeffs left on the model would be invisible to all of them.
      // So we re-undistort the observations with the full estimated bag (exactly what
      // ingest does with the sensor's coefficients) and reset the model radial coeffs
      // to 0, keeping the pinhole invariant. BA's forward model is the inverse of
      // undistortPixel with the same bag, so the in-place fold is exact; the next
      // self-cal pass estimates only the residual on the already-folded keypoints.
      //
      // cx/cy stay ON K (not folded) — projectPoint reads them; only the radial terms
      // move into the keypoints. For dense + the summary we need ONE composed {k1,k2,k3}
      // bag per sensor, so after folding we fit it from the pristine (pre-fold) keypoints
      // to their folded positions (selfCalCompose.js) — correct across multiple passes,
      // unlike the old additive-k1 sum.
      if (refineMode.includes('k1') && result.intrinsics) {
        // Refined intrinsics per sensor group (BA shares them across a group).
        const groupCal = new Map() // sensorInt → rk (with fx/fy/cx/cy/k1/k2/k3)
        uuidList.forEach((uuid, ci) => {
          const cam = cameras.get(uuid)
          if (cam?.K) cam.K = { ...cam.K, k1: 0, k2: 0, k3: 0 } // keypoints carry the distortion
          const g = sensorOfCam[ci]
          if (g < 0 || groupCal.has(g)) return
          const rk = result.intrinsics[ci]
          if (rk && (rk.k1 || rk.k2 || rk.k3)) groupCal.set(g, rk)
        })
        if (groupCal.size) {
          // Terms already baked into the keypoints by an EARLIER pass stay in the
          // composed bag even when this pass refines fewer (the staged schedule and
          // the identifiability guard can drop k2/k3 later): fitting only the current
          // pass's terms would silently erase them from what dense reproduces.
          const passTerms = { k2: refineMode.includes('k2'), k3: refineMode.includes('k3') }
          // Group the images so the composed fit can pool all keypoints of a sensor.
          const groupImgs = new Map() // sensorInt → [img,…]
          for (const img of imgs) {
            const g = sensorIntByUuid.get(img.uuid) ?? -1
            if (!groupCal.has(g) || !img.keypoints?.length) continue
            if (!groupImgs.has(g)) groupImgs.set(g, [])
            groupImgs.get(g).push(img)
          }
          let foldedImgs = 0, foldedShift = 0, foldedN = 0
          for (const [g, gimgs] of groupImgs) {
            const rk = groupCal.get(g)
            const bag = { k1: rk.k1 || 0, k2: rk.k2 || 0, k3: rk.k3 || 0 }
            for (const img of gimgs) {
              // Snapshot the pristine (post-ingest, pre-first-fold) keypoints once, so
              // the composed fit below always maps pristine → fully-folded.
              if (!pristineKpByUuid.has(img.uuid)) {
                pristineKpByUuid.set(img.uuid, img.keypoints.map((kp) => ({ ...kp })))
              }
              // Fold EVERY image on a solved group — not just the registered ones. When
              // this runs during registration, the next candidate to resect must already
              // have undistorted keypoints + a pinhole Kmap or its PnP re-applies the
              // now-removed distortion. Kmap is the source of truth every PnP reads.
              img.keypoints = img.keypoints.map((kp) => {
                const u = undistortPixel(kp.x, kp.y, rk, bag)
                foldedShift += Math.hypot(u.x - kp.x, u.y - kp.y); foldedN++
                return { ...kp, x: u.x, y: u.y }
              })
              moveGcpObs(img.uuid, (x, y) => undistortPixel(x, y, rk, bag))
              const k = Kmap.get(img.uuid)
              if (k) Kmap.set(img.uuid,
                { ...k, fx: rk.fx, fy: rk.fy, cx: rk.cx, cy: rk.cy, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 })
              foldedImgs++
            }
            // Compose the net distortion (pristine → folded) into one bag for dense +
            // the summary. Pool all group keypoints for a well-constrained radial fit.
            const sid = gimgs[0].sensorId ?? null
            if (sid != null) {
              const pris = [], fold = []
              for (const img of gimgs) {
                const p = pristineKpByUuid.get(img.uuid)
                if (!p) continue
                for (let i = 0; i < img.keypoints.length; i++) { pris.push(p[i]); fold.push(img.keypoints[i]) }
              }
              const ever = foldedTermsBySensor.get(g) ?? { k2: false, k3: false }
              const active = { k2: ever.k2 || (passTerms.k2 && !!rk.k2), k3: ever.k3 || (passTerms.k3 && !!rk.k3) }
              foldedTermsBySensor.set(g, active)
              const composed = fitComposedRadial(pris, fold, rk, active)
              // Guard: sample the composed radial map to the image corner; a non-monotonic
              // curve or a runaway corner shift means the higher-order fit overfit. Warn
              // (staged gating makes this rare) so a bad calibration is visible in the log.
              const im0 = gimgs[0]
              const w = im0.meta?.width ?? im0.width ?? 2 * rk.cx
              const h = im0.meta?.height ?? im0.height ?? 2 * rk.cy
              const maxNormR = Math.hypot(Math.max(rk.cx, w - rk.cx) / rk.fx, Math.max(rk.cy, h - rk.cy) / rk.fy)
              const guard = radialCurveOk(composed, maxNormR, rk.fx)
              if (!guard.ok) {
                log(`${label} self-cal composed radial fit looks unreliable — ${guard.reason}; `
                  + `dense will use it as-is but review the calibration`, 'warn', 'Reconstruction')
              }
              selfCalDistBySensor.set(sid, {
                k1: composed.k1, k2: composed.k2, k3: composed.k3, fitRmsPx: composed.fitRmsPx,
              })
            }
          }
          if (foldedImgs > 0) {
            log(`${label} folded self-calibrated distortion into ${foldedImgs} image(s)' `
              + `keypoints (mean shift ${(foldedShift / Math.max(1, foldedN)).toFixed(2)}px; model stays pinhole)`,
              'info', 'Reconstruction')
          }
        }
      }

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
          : `plateaued (converged in ${trace.length} iter)`
        log(`${label} convergence (RMS px) — ${fmtTrace.join(' → ')}; ${verdict}`,
          'debug', 'Reconstruction')
      }
      log(`${label} reprojection — ${fmtStats(modelReprojStats())}`, 'info', 'Reconstruction')
      return result
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

    async function runCameraPriorBundleAdjust() {
      if (!(cameraPriors.length >= cfg.cameraPriorBaMinCameras
          && cameras.size >= cfg.cameraPriorBaMinCameras
          && points3d.length >= 10 && baIterations > 0)) return
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
        const observations = buildBaObservations(points3d, (u) => camIdxOf.get(u), keypointOf)
        const result = await bundleAdjust(camList, camList.map((c) => c.K), points3d, observations, {
          maxIters: baIterations, refineIntrinsics: 'none',
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
        points3d = result.points3d.map((pt, i) => ({ ...pt, views: points3d[i].views }))
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
        const setup = await buildGcpAnchors({ cameras, qualifying, camIdxOf, firstPointIndex: points3d.length })
        if (setup.error) {
          log(`GCP anchoring stopped (${setup.error})`, 'warn', 'Reconstruction')
          return
        }
        const { fit, frame, anchorPts, anchors } = setup
        // GCPs define the one project↔SfM similarity for all survey constraints
        // in this joint pass, keeping point and camera targets in the same gauge.
        const constrainedCameras = buildCameraPriorConstraints(uuidList, { fit, frame })

        const observations = appendObservations(
          buildBaObservations(points3d, (u) => camIdxOf.get(u), keypointOf), setup.observations)

        log(`GCP-anchored bundle adjustment (round ${round + 1}/2) — `
          + `${anchors.length} GCP(s), seed scale ${fit.scale.toPrecision(4)}, `
          + `seed RMS ${fit.rms.toPrecision(3)}`, 'info', 'Reconstruction')

        const result = await bundleAdjust(camList, kList, [...points3d, ...anchorPts], observations,
          { maxIters: baIterations, refineIntrinsics: 'none', sensorOfCam, gcpAnchors: anchors,
            cameraPriors: constrainedCameras?.priors ?? [], solver: cfg.baSolver })
        noteBaSolver(`GCP-anchored bundle adjustment (round ${round + 1})`, result)
        if (!result) {
          log('GCP-anchored bundle adjustment returned no result (skipped)', 'warn', 'Reconstruction')
          return
        }
        if (result.costAfter > result.costBefore + 0.01
            && !(constrainedCameras && cameraPriorReprojectionAccepts(result))) {
          log(`GCP-anchored bundle adjustment REJECTED — would worsen reprojection RMS `
            + `${result.costBefore.toFixed(2)}px → ${result.costAfter.toFixed(2)}px`, 'warn', 'Reconstruction')
          return
        }
        uuidList.forEach((uuid, ci) => {
          cameras.set(uuid, { ...cameras.get(uuid), ...result.cameras[ci] })
        })
        // Only the original (non-anchor) points are kept — the synthetic anchor
        // points were scratch space for this BA pass, not real SIFT tracks.
        points3d = points3d.map((pt, i) => ({ ...pt, x: result.points3d[i].x, y: result.points3d[i].y, z: result.points3d[i].z }))
        log(`GCP-anchored bundle adjustment RMS ${result.costBefore.toFixed(2)}px → `
          + `${result.costAfter.toFixed(2)}px, anchor residual (SfM units) → ${result.anchorRmsAfter.toFixed(4)}`
          + (constrainedCameras ? `, camera-centre residual → `
            + `${(result.cameraPriorRmsAfter * fit.scale).toPrecision(3)} project units` : ''),
          'success', 'Reconstruction')
      }
    }

    // What fraction of observations are still gross outliers (the junk tracks BA
    // can only down-weight, not delete). Logged before/after filtering.
    const logOutlierShare = (label) => {
      const resid = modelResiduals()
      const nr = resid.length || 1
      log(`${label} — ${(100 * resid.filter((r) => r > 5).length / nr).toFixed(1)}% obs over 5px, `
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


    // Track completion to a fixpoint (tracks.js `completeTracks`, COLMAP's
    // CompleteTracks) against the CURRENT poses. Registration's fold judged
    // observations against rough poses and pre-self-cal keypoints; retriangulation
    // creates only 2-view points. Runs after
    // the retriangulation/merge below and before each post-filter pass, so every added
    // observation is then filtered and bundle-adjusted like any other. Gate = the
    // tight track-filter threshold, whichever pass it precedes.
    const completeTracksFinal = (label) => {
      rebuildViewIndex()
      const before = trackHist()
      const res = completeTracks({
        points3d, cameras, pairs: donePairs, keypointOf,
        maxReprojPx: filterMaxReprojPx, maxRounds: cfg.completeTracksMaxRounds,
        index: viewIndex, addView,
      })
      const after = trackHist()
      trackCompletionRecord.push({
        stage: label, added: res.added,
        rounds: res.rounds, lifted: res.lifted, gatePx: filterMaxReprojPx, before, after,
      })
      const total = res.added
      if (total) {
        log(`${label} track completion +${total} observation(s) (`
          + `${res.rounds} round(s), ≤${filterMaxReprojPx.toFixed(1)}px) — ${res.lifted} point(s) lifted to ≥3 views; `
          + `track lengths (2/3/4+ view) ${before.t2}/${before.t3}/${before.t4} → ${after.t2}/${after.t3}/${after.t4}`,
        'info', 'Reconstruction')
      } else {
        log(`${label} track completion found nothing to add`, 'debug', 'Reconstruction')
      }
      return total
    }

    if (cameras.size >= 2 && points3d.length >= 10 && baIterations > 0) {
      report('bundle', 1, 'Bundle adjustment…', { done: cameras.size, total: imgs.length })

      // With no focal length anywhere, resolveK fell back to `fx = max(w,h)` — a
      // guess that can be ~50% off on a scanned aerial frame, shifting EVERY
      // residual above the cleanup gate below. Solve focal only first (cx/cy and
      // the radial terms stay fixed; the R6 concern is principal-point drift, not
      // f) so the gate judges tracks rather than the intrinsics guess. Gated on
      // `defaultKCount` so a project with real calibration is untouched.
      if (defaultKCount > 0) {
        await runBundleAdjust('focal pre-solve (default-FOV intrinsics)', baIterations, 'f')
      }

      // Registration can leave a tiny tail of catastrophic observations (the South
      // Building baseline had a 180px maximum). Running global BA on that known
      // outlier soup was both wasted work and capable of producing two guarded
      // rejections before the existing filter finally cleaned it. Strip only gross
      // residuals here using the same generous first-pass gate used below; the tighter
      // pass and all parallax checks remain unchanged.
      //
      // The gate is floored at a residual quantile so this pass can never remove
      // more than a tenth of the observations: an absolute threshold applied to a
      // model whose intrinsics are still wrong deletes the model, not its tail
      // (cleanupThreshold.js). No-op whenever the model is healthy.
      const preThr = adaptiveReprojThreshold(modelResiduals(), filterMaxReprojPx * 2,
        { maxRemovedFrac: CLEANUP_THRESHOLD_DEFAULTS.preBaMaxRemovedFrac })
      if (preThr.adaptive) {
        log(`pre-BA gross cleanup relaxed ${preThr.absolutePx.toFixed(1)}px → `
          + `${preThr.px.toFixed(1)}px — the absolute gate would have removed over `
          + `${(100 * CLEANUP_THRESHOLD_DEFAULTS.preBaMaxRemovedFrac).toFixed(0)}% of observations. `
          + `The residual distribution is shifted as a whole, which points at the intrinsics `
          + `(focal length / principal point), not at bad tracks.`, 'warn', 'Reconstruction')
      }
      const preClean = filterTracks({
        maxReprojPx: preThr.px,
        minTriAngleDeg: filterMinTriAngleDeg,
      })
      log(`pre-BA gross cleanup (≤${preThr.px.toFixed(1)}px, `
        + `≥${filterMinTriAngleDeg}° parallax) — removed ${preClean.obsRemoved} obs + `
        + `${preClean.ptsRemoved} points; ${points3d.length} points remain`,
      preClean.obsRemoved || preClean.ptsRemoved ? 'info' : 'debug', 'Reconstruction')
      rebuildViewIndex()

      // Pre-filter solve stays pinhole ('none'): self-calibration before the tighter
      // cleanup can drift cx/cy badly (R6). Intrinsics are refined only below.
      await runBundleAdjust('bundle adjustment', baIterations, 'none')
      logOutlierShare('pre-filter residuals')

      // A3: retriangulate missed matches + merge split tracks under the improved
      // poses, then one more BA so the new/merged structure settles jointly.
      {
        report('retriangulate', 1, 'Retriangulating + merging tracks…', { done: cameras.size, total: imgs.length })
        const before = trackHist()
        const { added, lowParallax } = await retriangulatePairs({
          points3d, cameras, pairs: donePairs, keypointOf,
          maxReprojPx: filterMaxReprojPx, minTriAngleDeg: filterMinTriAngleDeg,
          triangulate: triangulateDlt,
        })
        const mres = mergeSplitTracks({ points3d, cameras, pairs: donePairs, keypointOf, maxReprojPx: filterMaxReprojPx })
        points3d = mres.points3d
        const merged = mres.merged
        const completed = completeTracksFinal('post-BA')
        if (added || merged || completed) {
          const after = trackHist()
          log(`retriangulation +${added} point(s), merged ${merged} split track(s)`
            + `${lowParallax ? `, rejected ${lowParallax} low-parallax candidate(s)` : ''}; `
            + `${points3d.length} points`, 'info', 'Reconstruction')
          log(`track lengths (2/3/4+ view) ${before.t2}/${before.t3}/${before.t4} → `
            + `${after.t2}/${after.t3}/${after.t4}`, 'info', 'Reconstruction')
          await runBundleAdjust('post-retriangulation bundle adjustment', baIterations, 'none')
        } else if (lowParallax) {
          log(`retriangulation found no stable missed structure — rejected ${lowParallax} `
            + `candidate point(s) below ${filterMinTriAngleDeg}° parallax`, 'info', 'Reconstruction')
        } else {
          log('retriangulation found no missed structure', 'debug', 'Reconstruction')
        }
        memoryMark('first BA + retriangulation')
      }

      // Filter → re-BA, twice: a generous pass to strip gross junk, then a tighter
      // pass once the model has settled. Each re-solve runs on the cleaned set.
      for (const [round, maxPx] of [[1, filterMaxReprojPx * 2], [2, filterMaxReprojPx]]) {
        report('trackFilter', round / 2,
          `Track filter + bundle adjustment (pass ${round})…`, { done: cameras.size, total: imgs.length })
        // Complete first (against the poses + folded keypoints the previous BA left),
        // so the threshold, filter and BA below treat the added observations like any
        // other.
        completeTracksFinal(`pre-filter pass ${round}`)
        memoryMark(`track completion ${round}`)
        // Guided extension runs once, before the tight pass: by then the first
        // self-calibrated BA has folded the distortion, so projections and keypoints
        // share the final pinhole frame, and the pass-2 filter + BA below treat the
        // additions like any other observation (guidedExtension.js).
        if (round === 2 && cfg.guidedTrackExtension && imgs.some((im) => im.descU8)) {
          rebuildViewIndex()
          const before = trackHist()
          // Search radius: the filter gate, capped at a multiple of the model's own p90
          // residual (a coarse detection scale makes the native-px gate far wider than
          // what the model actually resolves — tuning.js guidedRadiusP90Mult).
          let gatePx = filterMaxReprojPx
          if (cfg.guidedRadiusP90Mult > 0) {
            const res = modelResiduals().sort((a, b) => a - b)
            const p90 = res.length ? res[Math.floor(0.9 * (res.length - 1))] : Infinity
            gatePx = Math.min(filterMaxReprojPx, cfg.guidedRadiusP90Mult * p90)
          }
          const g = guidedExtendTracks({
            points3d, cameras, imageOf: imageByUuid, viewIndex, addView, gatePx,
            ratio: cfg.guidedRatio ?? 0.8, quantile: cfg.guidedQuantile ?? 0.9,
            onAdd: (pt, uuid, kp) => guidedAdds.push({ uuid, kp }),
            descOf: (uuid, k) => { const d = imageByUuid(uuid)?.descU8; return d && (k + 1) * 128 <= d.length ? { arr: d, off: k * 128 } : null },
          })
          const after = trackHist()
          guidedRecord = [...(guidedRecord ?? []), { pass: round, ...g, gatePx, before, after }]
          log(`guided track extension (pass ${round}) +${g.added} observation(s) on ${g.pointsExtended} point(s) — `
            + `${g.lifted} lifted from 2 to ≥3 views (≤${gatePx.toFixed(1)}px, descriptor ≤ `
            + `${g.tau?.toFixed(3) ?? '–'} measured from ≥3-view tracks, ratio ${cfg.guidedRatio ?? 0.8}; ${g.windows} search window(s), `
            + `${g.proposals} proposal(s)); track lengths (2/3/4+ view) ${before.t2}/${before.t3}/${before.t4} → `
            + `${after.t2}/${after.t3}/${after.t4}`, 'info', 'Reconstruction')
          memoryMark('guided extension')
        }
        // Same quantile floor as the pre-BA pass, but a deliberately loose bound: these
        // passes ARE the real filter and a hard block can legitimately lose a lot, so it
        // guards only against annihilating the model (cleanupThreshold.js).
        const thr = adaptiveReprojThreshold(modelResiduals(), maxPx,
          { maxRemovedFrac: CLEANUP_THRESHOLD_DEFAULTS.filterMaxRemovedFrac })
        if (thr.adaptive) {
          log(`track filter pass ${round} relaxed ${maxPx.toFixed(1)}px → ${thr.px.toFixed(1)}px — `
            + `the absolute gate would have removed over half the observations; check the intrinsics`,
            'warn', 'Reconstruction')
        }
        const { obsRemoved, ptsRemoved } = filterTracks({ maxReprojPx: thr.px, minTriAngleDeg: filterMinTriAngleDeg })
        log(`track filter pass ${round} (≤${thr.px.toFixed(1)}px, ≥${filterMinTriAngleDeg}° parallax) — `
          + `removed ${obsRemoved} obs + ${ptsRemoved} points; ${points3d.length} points remain`, 'info', 'Reconstruction')
        // Staged self-cal (WS2): under 'auto' the post-filter passes escalate the refined
        // terms (k2 / cx,cy / k3) as the camera + observation counts clear each gate; an
        // explicit user refine string is used verbatim (selfCalStaged is false).
        let refineMode = refineIntrinsics
        let reducedReason = null
        if (cfg.selfCalStaged) {
          const nObs = points3d.reduce((s, p) => s + p.views.size, 0)
          const counts = { nCams: cameras.size, nObs }
          refineMode = stagedSelfCalTerms(counts)
          const deferred = stagedSelfCalDeferred(counts)
          log(`post-filter pass ${round} self-cal terms '${refineMode}'`
            + `${deferred.length ? ` — deferred ${deferred.join('; ')}` : ' — all terms unlocked'}`,
            'info', 'Reconstruction')
        }
        // WS-C1: radial distortion is identifiable only from multi-view track redundancy,
        // NOT from camera count — see selfCalSchedule.js ▸ distortionIdentifiable. Too few
        // cameras ⇒ refine nothing; enough cameras but 2-view-dominated tracks ⇒ drop the
        // radial terms and keep solving focal (still observable from camera geometry).
        if (refineMode !== 'none') {
          const hist = trackHist()
          const ident = distortionIdentifiable({
            nCams: cameras.size,
            nTracks: points3d.length,
            nMultiViewTracks: hist.t3 + hist.t4,
          })
          if (!ident.ok) {
            const next = ident.scope === 'all' ? 'none' : withoutDistortionTerms(refineMode)
            if (next !== refineMode) {
              log(`post-filter pass ${round} self-cal ${next === 'none' ? 'skipped' : `reduced to '${next}'`} — `
                + `${ident.reason}`, 'info', 'Reconstruction')
            }
            refineMode = next
            reducedReason = ident.reason
          }
        }
        // One row per post-filter pass: what was actually refined, and why it was cut
        // back if it was. The escalation schedule is invisible in the final numbers.
        selfCalRecord.passes.push({ pass: round, mode: refineMode, reducedReason })
        await runBundleAdjust(`post-filter bundle adjustment ${round}`, baIterations, refineMode)
        memoryMark(`filter + BA ${round}`)
      }
      logOutlierShare('post-filter residuals')
      if (guidedAdds.length) {
        const audit = auditGuidedAdditions(guidedAdds, points3d, (pt, uuid, kp) => {
          const cam = cameras.get(uuid), k = imageByUuid(uuid)?.keypoints?.[kp]
          const pr = cam?.K && k ? projectPoint(cam, pt.x, pt.y, pt.z) : null
          return pr ? Math.hypot(pr.u - k.x, pr.v - k.y) : null
        })
        guidedRecord.at(-1).audit = audit
        const f = (v) => (v == null ? '–' : v.toFixed(2))
        log(`guided track extension audit — ${audit.survived}/${audit.proposed} added observation(s) survived the `
          + `filter and BA; their residuals median ${f(audit.medianPx)}px, p90 ${f(audit.p90Px)}px vs every other `
          + `observation's ${f(audit.restMedianPx)}px / ${f(audit.restP90Px)}px`, 'info', 'Reconstruction')
      }

      log('bundle adjustment + filtering complete', 'success', 'Reconstruction')
    } else {
      log(`bundle adjustment skipped (cameras=${cameras.size}, `
        + `points=${points3d.length}, iters=${baIterations})`, 'debug', 'Reconstruction')
    }
    if (cameraPriors.length && cameras.size >= 2 && points3d.length >= 10) {
      report('gcpBundle', 1, 'Camera-position constrained bundle adjustment…', { done: cameras.size, total: imgs.length })
      await runCameraPriorBundleAdjust()
    }
    if (gcps.length && cameras.size >= 2 && points3d.length >= 10) {
      report('gcpBundle', 1, 'GCP-anchored bundle adjustment…', { done: cameras.size, total: imgs.length })
      await runGcpAnchoredBundleAdjust()
    }
    markStage('bundleAdjust')

    // The incremental solver needs 2-view points to bootstrap and register cameras,
    // but final products do not need to expose them when a strong multi-view core is
    // available. This removes the one class of point for which a wrong match along an
    // epipolar line can retain low reprojection error with no independent witness.
    const finalTrackPrune = pruneFinalTwoViewTracks(points3d, {
      minViews: finalMinTrackViews,
      minSupportedTracks: finalTrackPruneMinCount,
      minSupportedShare: finalTrackPruneMinShare,
    })
    if (finalTrackPrune.applied) {
      points3d = finalTrackPrune.points3d
      rebuildViewIndex()
      log(`final track-quality cleanup — removed ${finalTrackPrune.removed} uncorroborated `
        + `2-view point(s); ${finalTrackPrune.supported} point(s) with ≥${finalMinTrackViews} views remain`,
      finalTrackPrune.removed ? 'info' : 'debug', 'Reconstruction')
    } else if (finalTrackPrune.total > 0 && finalMinTrackViews > 2) {
      log(`final track-quality cleanup kept 2-view points — only ${finalTrackPrune.supported}/`
        + `${finalTrackPrune.total} (${(100 * finalTrackPrune.supportedShare).toFixed(1)}%) have `
        + `≥${finalMinTrackViews} views, below the safe automatic-pruning floor`,
      'warn', 'Reconstruction')
    }

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
      log(`per-camera residuals — global median ${globalMed.toFixed(2)}px; `
        + `${flagged.length}/${rows.length} camera(s) over 2× (${(2 * globalMed).toFixed(2)}px)`,
        flagged.length ? 'warn' : 'info', 'Reconstruction')
      for (const r of flagged) {
        log(`  ⚠ ${r.name} — median ${r.s.median.toFixed(2)}px, `
          + `p95 ${r.s.p95.toFixed(2)}px (${r.s.count} obs)`, 'warn', 'Reconstruction')
      }
    }

    // Track-length histogram: points seen by only 2 images are the fragile ones;
    // a model dominated by 2-view tracks is weakly constrained.
    const { t2: tracks2, t3: tracks3, t4: tracks4 } = trackHist()
    const totalMs = performance.now() - t0
    log(`track lengths — ${tracks2} ×2-view, ${tracks3} ×3-view, ${tracks4} ×4+-view`, 'info', 'Reconstruction')
    log(`total time ${(totalMs / 1000).toFixed(1)}s `
      + `(${Object.entries(stageTimes).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ')})`, 'info', 'Reconstruction')
    if (baSolverTotals.calls) {
      const T = baSolverTotals
      log(`bundle adjustment solver — ${T.calls} BA call(s), ${(T.ms / 1000).toFixed(1)}s, largest n ${T.maxN}; `
        + `${T.solves} solves: ${T.cholesky} Cholesky, PCG ${T.pcgConverged} converged / ${T.pcgPartial} partial / `
        + `${T.pcgFallback} → Cholesky / ${T.pcgNotPd} not PD (${T.pcgIters} CG it, max ${T.pcgItersMax}); `
        + `policy ${JSON.stringify(cfg.baSolver ?? {})}`, 'info', 'Reconstruction')
    }

    // Q3: persistable run summary so successive runs are honestly comparable
    // ("did it improve" becomes a number, not a feeling). Persisted next to
    // georef in reconstruction.json by the store.
    const finalStats = modelReprojStats()
    const nPoints = points3d.length
    const pct3plusViewTracks = nPoints ? (100 * (tracks3 + tracks4) / nPoints) : 0
    // Diagnose coherent blocks left outside the chosen incremental model. This is
    // materially different from isolated failures: a sizeable remaining component
    // has enough internal geometry to seed a second model and should be routed to a
    // future multi-model/merge pass, not described as "too few keypoints".
    const unregisteredIds = imgs.filter((im) => !cameras.has(im.uuid)).map((im) => im.uuid)
    const unregisteredSet = new Set(unregisteredIds)
    const remainingGraph = graphHealth(
      donePairs.filter((e) => unregisteredSet.has(e.idA) && unregisteredSet.has(e.idB)),
      unregisteredIds,
    )
    const remainingComponents = remainingGraph.components
      .filter((c) => c.length >= 2)
      .map((c) => ({
        size: c.length,
        imageUuids: c,
        imageNames: c.map((u) => imageByUuid(u)?.name ?? u),
      }))
    if (remainingComponents.length) {
      // Say which components the secondary pass will actually take: it skips any
      // below `secondaryMinImages` (multiModel.js secondaryJobs), so "routing" them
      // all promised a recovery that never ran (eagle: 6, 4, 4 images vs a floor of 8).
      const floor = cfg.secondaryMinImages ?? 8
      const viable = remainingComponents.filter((c) => c.size >= floor).length
      const routing = cfg.secondaryModels === false ? 'secondary-model recovery is off'
        : viable === remainingComponents.length ? 'all go to secondary-model recovery'
          : viable ? `${viable} reach the ${floor}-image floor for secondary-model recovery; the rest stay unregistered`
            : `none reaches the ${floor}-image floor for secondary-model recovery, so they stay unregistered`
      log(`${remainingComponents.length} unregistered component(s) remain `
        + `(${remainingComponents.map((c) => c.size).join(', ')} images); largest starts `
        + `${remainingComponents[0].imageNames.slice(0, 4).join(', ')}`
        + `${remainingComponents[0].size > 4 ? ', …' : ''}. ${routing[0].toUpperCase()}${routing.slice(1)}; `
        + `looser global PnP gates are not used.`, 'warn', 'Reconstruction')
    }
    // Final focal per sensor, from the registered cameras' K (BA writes refined
    // intrinsics back onto it) and falling back to Kmap for an unregistered sensor.
    // Prefer an actually registered camera for each sensor. The previous image-order
    // loop could see an unregistered first image, mark the shared sensor false, and
    // then suppress every later registered image because fxFinal was already filled.
    const finalIntrinsicsImages = [
      ...imgs.filter((img) => cameras.has(img.uuid)),
      ...imgs.filter((img) => !cameras.has(img.uuid)),
    ]
    for (const img of finalIntrinsicsImages) {
      const sid = img.sensorId ?? `image:${img.uuid}`
      const rec = intrinsicsRecord.get(sid)
      if (!rec || rec.fxFinal != null) continue
      const K = cameras.get(img.uuid)?.K ?? Kmap.get(img.uuid)
      if (!K) continue
      rec.fxFinal = K.fx
      rec.cx = K.cx
      rec.cy = K.cy
      rec.registered = cameras.has(img.uuid)
    }
    const summary = {
      date: new Date().toISOString(),
      nCameras: cameras.size,
      nPoints,
      pct3plusViewTracks,
      preBaP95px: preBaStats.p95,
      postBaMedianPx: finalStats.median,
      initPair: {
        idA: bestPair.idA, idB: bestPair.idB, nameA: imgA.name, nameB: imgB.name,
        // The seed record IS the SB acceptance test (TODO ▸ SB): which pair won, on
        // what evidence, and how close the runner-up was.
        angleDeg: best.angle, inliers: best.inliers, points: seedPointCount,
        score: best.score ?? null,
        // Graph degree + PnP-ready third views come from the candidate table (the
        // scorer computes them there); they are the two signals the 2026-07-22
        // heuristic changes turn on, so a run is not reviewable without them.
        ...(() => {
          const rows = perPairInitReproj || []
          const sel = rows.find((p) => p.selected)
          const others = rows.filter((p) => !p.selected && p.score != null)
          const up = others.length ? others.reduce((a, b) => (b.score > a.score ? b : a)) : null
          return {
            degree: sel?.degree ?? null,
            readyViews: sel?.growthViews ?? null,
            candidatesScored: rows.length,
            runnerUp: up ? { pair: up.pair, score: up.score, parallaxDeg: up.parallaxDeg } : null,
          }
        })(),
      },
      // Run record (baseline bookkeeping) — see the runConfig comment at the top.
      config: runConfig,
      gates: gateRecord,
      guidedExtension: guidedRecord,
      selfCal: selfCalRecord,
      trackCompletion: trackCompletionRecord,
      intrinsics: [...intrinsicsRecord.values()].map((r) => ({
        ...r,
        deltaPct: r.fxNominal && r.fxFinal != null ? (100 * (r.fxFinal - r.fxNominal) / r.fxNominal) : null,
      })),
      // Per-stage wall clock. Already measured for the debug log; persisted because
      // "is Stage X negligible?" is a question several TODO items ask of real runs.
      timings: { ...stageTimes, totalMs: performance.now() - t0 },
      baSolver: { ...baSolverTotals, policy: { ...(cfg.baSolver ?? {}) } },
      finalTrackCleanup: {
        applied: finalTrackPrune.applied,
        removedTwoView: finalTrackPrune.removed,
        supportedBefore: finalTrackPrune.supported,
        totalBefore: finalTrackPrune.total,
        minViews: finalMinTrackViews,
      },
      unregisteredComponents: remainingComponents,
      perPairInitReproj,
      // WS2: composed self-calibrated radial distortion per sensor {k1,k2,k3} (folded
      // into keypoints for the sparse solve; the dense stage applies it to the sensor's
      // undistortion so its rasters land in the same pinhole frame). Empty when
      // self-calibration was off. `fitRmsPx` is the composed-fit residual (a health
      // signal — warn if it drifts above ~0.05px).
      selfCalDistortion: [...selfCalDistBySensor]
        .filter(([, d]) => d.k1 || d.k2 || d.k3)
        .map(([sensorId, d]) => ({ sensorId, k1: d.k1, k2: d.k2, k3: d.k3, fitRmsPx: d.fitRmsPx })),
      // F4: per-image scan→canonical transform for each film image, so the dense
      // stage reproduces the exact same frame (it must NOT re-fit — the sparse run
      // defines the frame). Empty for all-digital projects.
      fiducialTransforms: [...fiducialTransforms].map(([uuid, t]) => ({ uuid, A: t.A, transform: t.transform, frame: t.frame })),
    }

    memoryMark('final cleanup + summary')
    report('finalize', 1, 'Finalising model…', { done: cameras.size, total: imgs.length })
    // A run that finishes with no points (or a single camera) is a failed
    // reconstruction, not a success — log it red so it doesn't read as green.
    const degenerate = points3d.length === 0 || cameras.size < 2
    log(`Reconstruction complete: ${cameras.size} cameras, ${points3d.length} points, `
      + `final reprojection ${fmtStats(finalStats)}`,
      degenerate ? 'error' : 'success', 'Reconstruction')
    log(`Reconstruction summary: ${summary.nCameras} cameras, ${summary.nPoints} points, `
      + `${pct3plusViewTracks.toFixed(1)}% ≥3-view tracks, pre-BA p95 ${preBaStats.p95.toFixed(1)}px, `
      + `post-BA median ${finalStats.median.toFixed(2)}px`, 'success', 'Reconstruction')
    const output = done('done', summary)
    memoryMark('compact result')
    log(`compact model ready: ${summary.nCameras} cameras, ${summary.nPoints} points`,
      'info', 'Reconstruction')
    return output
  } catch (err) {
    log(`Reconstruction error: ${err?.message ?? err}`, 'error', 'Reconstruction')
    return done('error')
  }
}

// A working copy of the SfM input (or of an image / pair list) for one sub-run. The
// caller keeps the original as the pristine input for seed retries and secondary
// models, because a run mutates its keypoints (ingest undistortion, the self-cal
// fold) and pairs (refitted F). `descU8`, the guided-extension descriptors, is never
// written, so every copy SHARES it: structuredClone doubled it, 128 B per keypoint —
// 576 MB on the 4.5 M-keypoint Monster set, enough to fail the worker preflight.
export function cloneSfmInput(value) {
  const isList = Array.isArray(value)
  const list = isList ? value : value?.images
  const desc = list ? list.map((im) => im?.descU8 ?? null) : null
  const strip = (im) => (im?.descU8 ? { ...im, descU8: null } : im)
  const src = isList ? value.map(strip) : list ? { ...value, images: list.map(strip) } : value
  const copy = structuredClone(src)
  const out = isList ? copy : copy?.images
  if (desc && out) out.forEach((im, i) => { if (desc[i] && im) im.descU8 = desc[i] })
  // structuredClone drops the Uint32PairList prototype; re-wrap — including when the
  // value IS a pair list (secondary jobs clone `job.pairs` directly), which the old
  // helper skipped. A no-op for image lists (no `matches`).
  wrapPackedMatches(isList ? copy : copy?.pairs)
  return copy
}

// Public orchestration: build the normal primary model first, then independently
// reconstruct each sizeable coherent block it stranded. Each secondary gets a halo
// of registered boundary images. A similarity merge is accepted only when >=3 halo
// cameras independently agree in position, orientation and leave-one-out scale;
// otherwise the valid model is returned separately for the store to preserve.
export async function reconstruct(input, hooks = {}) {
  // Resolve the detection-scale factor ONCE, from the full image set, and pin it
  // into `settings`. Every sub-run below spreads `input.settings`, so the primary,
  // each seed retry and each secondary model all apply identical reprojection
  // gates — a secondary built from a stranded subset must not re-derive its own
  // factor, or its residuals would not be comparable with the primary's at merge
  // time. See core/scaleContext.js for why the gates need scaling at all.
  const runScale = buildScaleContext(input.images || [])
  input = { ...input, settings: { ...(input.settings || {}), detectScaleFactor: runScale.factor } }
  if (runScale.factor !== 1 || runScale.mixed) {
    // The one place the factor's *inputs* are reported; sub-runs only echo the
    // resolved gates. Emitted here rather than in the primary sub-run so it
    // appears once per reconstruction, not once per retry.
    (hooks.onLog ?? (() => {}))(describeScaleContext(runScale, 'Reprojection gates'),
      runScale.clamped ? 'warn' : 'info', 'SfM')
  }

  const cfg = { ...SFM_TUNING, ...(input.settings || {}) }
  const clone = (value) => cloneSfmInput(value)
  // Which attempt produced the model we return. The alternate-seed guard turned a
  // 19-camera primary into 122 on B4, and the run's own metrics did NOT flag the bad
  // one — so "was a retry needed?" is part of the result, not an aside in the log.
  const attempts = { retryCap: Math.max(0, cfg.seedRetryMax ?? 0), retriesRun: 0, winner: 0, seeds: [] }
  const withRunRecord = (model) => {
    if (model?.summary) {
      model.summary.attempts = { ...attempts, seeds: [...attempts.seeds] }
    }
    return model
  }
  // Each sub-run reports an honest local 0..1; the orchestration maps those into
  // consecutive slices of one overall bar. Without this, seed retries and secondary
  // models each drove the bar 0→100% again — the "finishes several times" bug.
  const [primaryStart, primaryEnd] = RUN_BUDGET.primary
  let primary = await reconstructSingleModel(clone(input), {
    ...hooks,
    progressRange: { start: primaryStart, end: primaryEnd },
  })
  if (primary.status !== 'done' || cfg.secondaryModels === false) return withRunRecord(primary)

  // Seed choice is noisy on difficult wide-angle sets because each pair's F/RANSAC
  // estimate can move its recovered parallax enough to reorder otherwise plausible
  // seeds. A tiny completed model is not a result to build secondary recovery around:
  // retry alternate seeds and retain the largest valid primary. This directly guards
  // the South Building regression where a 3-camera seed replaced the prior 86-camera
  // solution and the secondary pass merely repeated the same seed.
  const log = hooks.onLog ?? (() => {})
  const excluded = new Set()
  const pairKey = (p) => p ? (p.idA < p.idB ? `${p.idA}--${p.idB}` : `${p.idB}--${p.idA}`) : null
  const nInputImages = (input.images || []).filter((im) => im.kpStatus === 'done').length
  const maxRetries = Math.max(0, cfg.seedRetryMax ?? 0)
  // Recovery budget: seed retries take the first half, secondary models the second.
  // Both counts are discovered mid-run, so each is subdivided against its own cap.
  const [recStart, recEnd] = RUN_BUDGET.recovery
  const recMid = recStart + (recEnd - recStart) / 2
  const retryRange = (attempt) => {
    const [start, end] = sliceRange([recStart, recMid], Math.max(1, maxRetries), attempt)
    return { start, end }
  }
  const initialKey = pairKey(primary.summary?.initPair)
  if (initialKey) excluded.add(initialKey)
  attempts.seeds.push({
    attempt: 0,
    pair: primary.summary?.initPair
      ? `${primary.summary.initPair.nameA} ↔ ${primary.summary.initPair.nameB}` : null,
    cameras: primary.cameras.length,
    points: primary.points.length,
    kept: true,
  })
  for (let attempt = 0; attempt < maxRetries && primary.cameras.length < cfg.seedRetryMinFraction * nInputImages; attempt++) {
    log(`primary registered only ${primary.cameras.length}/${nInputImages}; `
      + `retrying with alternate seed (${attempt + 1}/${maxRetries}, ${excluded.size} prior seed(s) excluded)`,
    'warn', 'Reconstruction')
    const candidate = await reconstructSingleModel({
      ...clone(input),
      settings: { ...(input.settings || {}), secondaryModels: false, excludedInitPairs: [...excluded] },
    }, {
      onLog: (message, level, category) => log(`Seed retry ${attempt + 1}: ${message}`, level, category),
      // Retries share the first half of the recovery budget, subdivided by the retry
      // cap (the actual count isn't known in advance — the loop exits early on a good
      // primary, which simply means the bar jumps ahead to the secondary phase).
      progressRange: retryRange(attempt),
      onProgress: scopeProgress(hooks.onProgress, {
        ...retryRange(attempt),
        decorate: (label) => `Seed retry ${attempt + 1}: ${label}`,
      }),
    })
    attempts.retriesRun = attempt + 1
    if (candidate.status !== 'done') {
      attempts.seeds.push({ attempt: attempt + 1, pair: null, cameras: 0, points: 0, kept: false })
      continue
    }
    const improved = candidate.cameras.length > primary.cameras.length
      || (candidate.cameras.length === primary.cameras.length && candidate.points.length > primary.points.length)
    attempts.seeds.push({
      attempt: attempt + 1,
      pair: candidate.summary?.initPair
        ? `${candidate.summary.initPair.nameA} ↔ ${candidate.summary.initPair.nameB}` : null,
      cameras: candidate.cameras.length,
      points: candidate.points.length,
      kept: improved,
    })
    if (improved) {
      attempts.winner = attempt + 1
      for (const s of attempts.seeds) if (s.attempt !== attempts.winner) s.kept = false
    }
    if (candidate.cameras.length > primary.cameras.length
      || (candidate.cameras.length === primary.cameras.length && candidate.points.length > primary.points.length)) {
      log(`alternate seed improved primary ${primary.cameras.length} → ${candidate.cameras.length} cameras; keeping it`,
        'success', 'Reconstruction')
      primary = candidate
    } else {
      log(`alternate seed reached ${candidate.cameras.length} cameras; keeping ${primary.cameras.length}-camera primary`,
        'info', 'Reconstruction')
    }
    const candidateKey = pairKey(candidate.summary?.initPair)
    if (candidateKey) excluded.add(candidateKey)
  }
  if (primary.cameras.length < 0.25 * nInputImages) {
    log(`primary remains too small after alternate-seed retries `
      + `(${primary.cameras.length}/${nInputImages}); secondary recovery suppressed because it cannot `
      + `reliably align against a tiny primary`, 'error', 'Reconstruction')
    primary.secondaryModels = []
    primary.summary = { ...(primary.summary || {}), secondaryMerges: [] }
    return withRunRecord(primary)
  }

  const jobs = secondaryJobs(input, primary, {
    minImages: cfg.secondaryMinImages,
    maxBoundary: cfg.secondaryBoundaryImages,
  })
  if (!jobs.length) {
    primary.summary = { ...(primary.summary || {}), secondaryRecovery: { jobs: 0, merged: [], separate: [] } }
    return withRunRecord(primary)
  }
  // Declared after `jobs` on purpose — it closes over it, and a const read from an
  // arrow hoisted above its declaration is a TDZ waiting to happen.
  const secondaryRange = (ji) => {
    const [start, end] = sliceRange([recMid, recEnd], Math.max(1, jobs.length), ji)
    return { start, end }
  }

  const secondaryModels = []
  const mergeReports = []
  log(`secondary-model recovery — ${jobs.length} viable stranded component(s)`,
    'info', 'Reconstruction')
  for (let ji = 0; ji < jobs.length; ji++) {
    const job = jobs[ji]
    log(`secondary ${ji + 1}/${jobs.length} — ${job.componentIds.length} stranded + `
      + `${job.boundaryIds.length} primary boundary image(s), ${job.pairs.length} pair(s)`,
    'info', 'Reconstruction')
    // Clone only this job's subset: cloning the whole input and then overriding its
    // images and pairs briefly held a second copy of every keypoint and match.
    const secondary = await reconstructSingleModel({
      ...clone({
        ...input, images: job.images, pairs: job.pairs,
        gcps: [], // GCP anchoring belongs to the merged/final project model, not a local frame
      }),
      settings: { ...(input.settings || {}), secondaryModels: false },
    }, {
      onLog: (message, level, category) => log(`Secondary ${ji + 1}: ${message}`, level, category),
      progressRange: secondaryRange(ji),
      onProgress: scopeProgress(hooks.onProgress, {
        ...secondaryRange(ji),
        decorate: (label) => `Secondary ${ji + 1}: ${label}`,
      }),
    })
    if (secondary.status !== 'done' || secondary.cameras.length < 2 || !secondary.points.length) {
      log(`secondary ${ji + 1} failed to form a usable model`, 'warn', 'Reconstruction')
      continue
    }
    const aligned = alignSecondary(primary, secondary, job.componentIds)
    if (!aligned.accepted) {
      log(`secondary ${ji + 1} kept separate — ${aligned.reason}`, 'warn', 'Reconstruction')
      secondaryModels.push({
        ...secondary,
        name: `Secondary sparse ${ji + 1}`,
        componentImageUuids: job.componentIds,
        alignment: { accepted: false, reason: aligned.reason, sharedCameras: aligned.common?.length ?? 0 },
      })
      continue
    }
    primary = mergeAligned(primary, aligned)
    primary.summary.unregisteredComponents = (primary.summary.unregisteredComponents || [])
      .filter((c) => !c.imageUuids?.some((u) => job.componentIds.includes(u)))
    const report = {
      componentImages: job.componentIds.length,
      addedCameras: primary.summary.secondaryMerge.addedCameras,
      addedPoints: primary.summary.secondaryMerge.addedPoints,
      sharedCameras: aligned.common.length,
      alignmentRmsFrac: aligned.rmsFrac,
      medianRotationDeg: aligned.medianRotationDeg,
      scaleSpread: aligned.scaleSpread,
    }
    mergeReports.push(report)
    log(`secondary ${ji + 1} merged — +${report.addedCameras} cameras, `
      + `+${report.addedPoints} points; ${report.sharedCameras} shared cameras, `
      + `position RMS ${(100 * report.alignmentRmsFrac).toFixed(2)}% of span, `
      + `rotation median ${report.medianRotationDeg.toFixed(2)}°, scale spread `
      + `${(100 * report.scaleSpread).toFixed(2)}%`, 'success', 'Reconstruction')
  }
  primary.secondaryModels = secondaryModels
  primary.summary = {
    ...(primary.summary || {}),
    secondaryMerges: mergeReports,
    secondaryRecovery: {
      jobs: jobs.length,
      merged: mergeReports,
      separate: secondaryModels.map((m) => ({
        name: m.name,
        componentImages: m.componentImageUuids?.length ?? 0,
        cameras: m.cameras?.length ?? 0,
        points: m.points?.length ?? 0,
        sharedCameras: m.alignment?.sharedCameras ?? 0,
        reason: m.alignment?.reason ?? 'alignment rejected',
      })),
    },
  }
  return withRunRecord(primary)
}

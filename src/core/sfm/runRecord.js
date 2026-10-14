// The run record of one single-model run: what it was asked to do and what it measured.
// Up front — the requested knobs (captured before anything mutates `cfg`), the
// detect-px → native-px gate resolution and the 'auto' self-calibration resolution
// (both of which DO mutate `cfg`, in that order), and the match-graph health line.
// At the end — the per-camera residual table, the totals lines, the unregistered
// components, the final intrinsics and the persisted `summary`. Each function is a
// function of its arguments (plus `log`); none holds state between calls.

import { SELF_CAL_BASE_TERMS } from './selfCalSchedule.js'
import { projectPoint } from './geometry.js'
import { hasKp, kpX, kpY } from './keypointSet.js'
import { graphHealth } from '../eval/matchGraph.js'
import { buildScaleContext, describeScaleContext, resolveScaledPx } from '../scaleContext.js'
import { numStats } from './modelStats.js'

// ── Run record (baseline bookkeeping) ────────────────────────────────────────
// Everything below feeds `summary` so the Debug ▸ Project Summary digest can state
// WHAT was run, not just how it scored — a measured number without its settings is
// not a baseline. Captured before the 'auto' resolutions and the detect-px →
// native-px gate scaling (resolveGates / resolveRefineIntrinsics) mutate `cfg`, so
// these are the knobs as *requested*.
export function captureRunConfig({ cfg, settings, cameraPriors }) {
  return {
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
}

// Reprojection gates are configured in DETECTION pixels but applied to keypoints
// in NATIVE pixels, so resolve them against this set's detection scale before
// anything reads them. Done here, on `cfg`, because both consumers (the
// orchestrator's BA/filter passes and register.js's PnP gates) destructure from
// it — there is no second place to keep in sync. A set detected at full
// resolution has factor 1 and every value resolves to itself.
//
// A nested run (seed retry / secondary model) receives the already-resolved
// factor through `settings` so it cannot re-derive a different one from its
// camera subset — the gates must mean the same thing in every sub-run.
//
// Mutates cfg.detectScaleFactor / reprjThreshold / filterMaxReprojPx; returns the
// gate record (resolved reprojection gates + the detection-scale factor).
export function resolveGates({ cfg, settings, images, log }) {
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
  return {
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

// ── Resolve 'auto' self-calibration ──────────────────────────────────────
// A guessed pinhole (EXIF-only cameras, film scans) is the single biggest
// source of downstream error: a 24 mm lens has tens of px of uncorrected
// radial distortion, and a wrong film pitch skews focal ~10%. When no sensor
// carries a *calibrated* distortion model, solve one shared focal + radial k1
// in BA (folded back into keypoints after each pass — see CLAUDE.md). When a
// calibrated Brown model already removed distortion at ingest, leave it off so
// we don't double-correct.
//
// Mutates cfg.refineIntrinsics / cfg.selfCalStaged and records the resolution on
// `selfCalRecord`. Runs after ingest (it needs `anyCalibratedDistortion`).
export function resolveRefineIntrinsics({ cfg, anyCalibratedDistortion, selfCalRecord, log }) {
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
}

// ── Match-graph health ───────────────────────────────────────────────────
// SfM can only grow within a connected component. If the largest component is
// a small fraction of the images, the rest can never register no matter how
// good PnP is — that's a matching problem, not a reconstruction one. Sparse
// per-image connectivity (low pairs/image) also makes the chain fragile.
export function logMatchGraphHealth({ imgs, donePairs, log }) {
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

// Per-camera median-residual table (flags cameras > 2× the global median). The
// global stats hide a handful of badly-placed cameras that each still triangulate
// hundreds of points at their own bad quality (the pass-2 cameras on B1); this
// surfaces them by name so a bad registration is diagnosable at a glance.
export function logPerCameraResiduals({ tracks, ids, cameras, keypointsAt, imageByUuid, modelResiduals, log }) {
  const perCam = new Map() // uuid → residuals[]
  tracks.forEachPoint((p) => tracks.forEachView(p, (img, kpIdx) => {
    const uuid = ids.uuid(img)
    const cam = cameras.get(uuid), set = keypointsAt(img)
    if (!cam || !hasKp(set, kpIdx)) return
    const proj = projectPoint(cam, tracks.x(p), tracks.y(p), tracks.z(p))
    if (!proj) return
    if (!perCam.has(uuid)) perCam.set(uuid, [])
    perCam.get(uuid).push(Math.hypot(proj.u - kpX(set, kpIdx), proj.v - kpY(set, kpIdx)))
  }))
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

// The run's closing totals: track lengths (points seen by only 2 images are the
// fragile ones; a model dominated by 2-view tracks is weakly constrained), wall
// clock per stage, and the summed BA solver statistics (bundleSession.js).
export function logRunTotals({ hist, totalMs, stageTimes, solverTotals, baSolver, log }) {
  const { t2: tracks2, t3: tracks3, t4: tracks4 } = hist
  log(`track lengths — ${tracks2} ×2-view, ${tracks3} ×3-view, ${tracks4} ×4+-view`, 'info', 'Reconstruction')
  log(`total time ${(totalMs / 1000).toFixed(1)}s `
    + `(${Object.entries(stageTimes).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ')})`, 'info', 'Reconstruction')
  if (solverTotals.calls) {
    const T = solverTotals
    log(`bundle adjustment solver — ${T.calls} BA call(s), ${(T.ms / 1000).toFixed(1)}s, largest n ${T.maxN}; `
      + `${T.solves} solves: ${T.cholesky} Cholesky, PCG ${T.pcgConverged} converged / ${T.pcgPartial} partial / `
      + `${T.pcgFallback} → Cholesky / ${T.pcgNotPd} not PD (${T.pcgIters} CG it, max ${T.pcgItersMax}); `
      + `policy ${JSON.stringify(baSolver ?? {})}`, 'info', 'Reconstruction')
  }
}

// Diagnose coherent blocks left outside the chosen incremental model. This is
// materially different from isolated failures: a sizeable remaining component
// has enough internal geometry to seed a second model and should be routed to a
// future multi-model/merge pass, not described as "too few keypoints".
// Returns the components (≥2 images) for the summary — reconstruct() routes them to
// secondary-model recovery (multiModel.js secondaryJobs).
export function unregisteredComponents({ imgs, cameras, donePairs, imageByUuid, cfg, log }) {
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
  return remainingComponents
}

// Final focal per sensor, from the registered cameras' K (BA writes refined
// intrinsics back onto it) and falling back to Kmap for an unregistered sensor.
// Prefer an actually registered camera for each sensor. The previous image-order
// loop could see an unregistered first image, mark the shared sensor false, and
// then suppress every later registered image because fxFinal was already filled.
// Fills fxFinal / cx / cy / registered on the `intrinsicsRecord` rows in place.
export function finaliseIntrinsics({ imgs, cameras, Kmap, intrinsicsRecord }) {
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
}

// Q3: persistable run summary so successive runs are honestly comparable
// ("did it improve" becomes a number, not a feeling). Persisted next to
// georef in reconstruction.json by the store.
export function assembleSummary({
  cameras, nPoints, pct3plusViewTracks, preBaStats, finalStats,
  bestPair, imgA, imgB, best, seedPointCount, perPairInitReproj,
  runConfig, gateRecord, guidedRecord, selfCalRecord, trackCompletionRecord, intrinsicsRecord,
  stageTimes, t0, solverTotals, baSolver, finalTrackPrune, finalMinTrackViews,
  remainingComponents, selfCalDistortion, fiducialTransforms,
}) {
  return {
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
    // Run record (baseline bookkeeping) — see captureRunConfig above.
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
    baSolver: { ...solverTotals, policy: { ...(baSolver ?? {}) } },
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
    // undistortion so its rasters land in the same pinhole frame), about the final
    // camera K. An image without a sensor self-calibrates alone: its row carries
    // `sensorId: null` and its `imageUuid`. Empty when self-calibration was off.
    // `fitRmsPx` is the composed-fit residual (a health signal — warn if it drifts
    // above ~0.05px). Rows from selfCalFold.js ▸ distortionSummary.
    selfCalDistortion,
    // F4: per-image scan→canonical transform for each film image, so the dense
    // stage reproduces the exact same frame (it must NOT re-fit — the sparse run
    // defines the frame). Empty for all-digital projects.
    fiducialTransforms: [...fiducialTransforms].map(([uuid, t]) => ({ uuid, A: t.A, transform: t.transform, frame: t.frame })),
  }
}

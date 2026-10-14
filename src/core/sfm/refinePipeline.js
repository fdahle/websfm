// Post-registration refinement of one single-model run (Phase 2 + 3): the default-FOV
// focal pre-solve, the pre-BA gross cleanup, the first global BA, retriangulation +
// split-track merge, the filter → BA loop (track completion, guided extension, the
// staged / identifiability-guarded self-cal mode per pass) with the guided-extension
// audit, and — separately, after the survey-constrained solves — the final 2-view
// prune. Mutates the shared model in place; every point id is re-read after each
// `refreshTracks()` (it renumbers them), none is held across one.
//
// ctx = {
//   cfg, images, imgs, cameras, tracks, ids, keypointsAt, donePairs, refreshTracks,
//   modelResiduals, runBundleAdjust (bundleSession.js), selfCalRecord, intrinsicsRecord,
//   imageByUuid, defaultKCount, log, report, memoryMark,
// }

import { triangulateDlt } from './reconstruction.js'
import { projectPoint } from './geometry.js'
import {
  retriangulatePairs, mergeSplitTracks, pruneFinalTwoViewTracks, completeTracks, filterTracks,
} from './tracks.js'
import {
  stagedSelfCalTerms, stagedSelfCalDeferred, distortionIdentifiable, withoutDistortionTerms,
} from './selfCalSchedule.js'
import { adaptiveReprojThreshold, CLEANUP_THRESHOLD_DEFAULTS } from './cleanupThreshold.js'
import { guidedExtendTracks, auditGuidedAdditions } from './guidedExtension.js'
import { hasKp, kpX, kpY } from './keypointSet.js'
import { trackHist } from './modelStats.js'

// Runs the bundle-adjustment + track-filtering stages. Returns the records they fill
// for the run summary: `guidedRecord` (projection-guided track extension,
// guidedExtension.js — null when it didn't run) and `trackCompletionRecord` (final-stage
// track completion, one row per pass). Post-filter passes append to
// `selfCalRecord.passes`, which the camera-prior solve's 'auto' mode reads afterwards.
export async function refineModel(ctx) {
  const {
    cfg, images, imgs, cameras, tracks, ids, keypointsAt, donePairs, refreshTracks,
    modelResiduals, runBundleAdjust, selfCalRecord, intrinsicsRecord, imageByUuid,
    defaultKCount, log, report, memoryMark,
  } = ctx
  // Defaults + rationale for these live in defaults.user.js (baIterations,
  // refineIntrinsics) and tuning.js (the rest); `cfg` already merged them.
  const { baIterations, filterMaxReprojPx, filterMinTriAngleDeg, refineIntrinsics } = cfg
  let guidedRecord = null     // projection-guided track extension (guidedExtension.js)
  const guidedAdds = []       // its accepted observations, audited after the final pass
  // Final-stage track completion, one row per pass (completeTracksFinal below).
  const trackCompletionRecord = []

  const filterModelTracks = (gates) => filterTracks({ tracks, ids, cameras, keypointsAt, ...gates })

  // What fraction of observations are still gross outliers (the junk tracks BA
  // can only down-weight, not delete). Logged before/after filtering.
  const logOutlierShare = (label) => {
    const resid = modelResiduals()
    const nr = resid.length || 1
    log(`${label} — ${(100 * resid.filter((r) => r > 5).length / nr).toFixed(1)}% obs over 5px, `
      + `${(100 * resid.filter((r) => r > 20).length / nr).toFixed(1)}% over 20px`, 'info', 'Reconstruction')
  }

  // Track completion to a fixpoint (tracks.js `completeTracks`, COLMAP's
  // CompleteTracks) against the CURRENT poses. Registration's fold judged
  // observations against rough poses and pre-self-cal keypoints; retriangulation
  // creates only 2-view points. Runs after
  // the retriangulation/merge below and before each post-filter pass, so every added
  // observation is then filtered and bundle-adjusted like any other. Gate = the
  // tight track-filter threshold, whichever pass it precedes.
  const completeTracksFinal = (label) => {
    refreshTracks()
    const before = trackHist(tracks)
    const res = completeTracks({
      tracks, ids, cameras, pairs: donePairs, keypointsAt,
      maxReprojPx: filterMaxReprojPx, maxRounds: cfg.completeTracksMaxRounds,
    })
    const after = trackHist(tracks)
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

  if (cameras.size >= 2 && tracks.liveCount() >= 10 && baIterations > 0) {
    report('bundle', 1, 'Bundle adjustment…', { done: cameras.size, total: imgs.length })

    // With no focal length anywhere, resolveK fell back to `fx = max(w,h)` — a
    // guess that can be ~50% off on a scanned aerial frame, shifting EVERY
    // residual above the cleanup gate below. Solve focal only first (cx/cy and
    // the radial terms stay fixed; the R6 concern is principal-point drift, not
    // f) so the gate judges tracks rather than the intrinsics guess. Only the
    // default-FOV groups are refined: a project with real calibration is untouched,
    // and in a mixed one the calibrated sensors keep their K (authoritative px focals
    // are not refitted on the pre-cleanup outlier soup) — the crate cannot hold a group
    // fixed, so their K is restored and the poses re-settled around it. An explicit
    // refineIntrinsics 'none' turns it off; 'auto' resolved to 'none' (a calibrated
    // distortion model on some sensor) keeps it — that only spares the radial terms,
    // and a guessed focal is the error this pass exists for.
    const focalIsGuess = (uuid) => {
      const img = imageByUuid(uuid)
      return !!intrinsicsRecord.get(img?.sensorId ?? `image:${uuid}`)?.source?.startsWith('default')
    }
    const regUuids = [...cameras.keys()]
    if (defaultKCount > 0 && selfCalRecord.requested !== 'none' && regUuids.some(focalIsGuess)) {
      const mixed = !regUuids.every(focalIsGuess)
      const pre = await runBundleAdjust('focal pre-solve (default-FOV intrinsics)', baIterations, 'f',
        mixed ? { refineOnly: focalIsGuess } : {})
      if (pre && mixed) {
        await runBundleAdjust('focal pre-solve re-settle (calibrated intrinsics kept)', baIterations, 'none')
      }
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
    const preClean = filterModelTracks({
      maxReprojPx: preThr.px,
      minTriAngleDeg: filterMinTriAngleDeg,
    })
    log(`pre-BA gross cleanup (≤${preThr.px.toFixed(1)}px, `
      + `≥${filterMinTriAngleDeg}° parallax) — removed ${preClean.obsRemoved} obs + `
      + `${preClean.ptsRemoved} points; ${tracks.liveCount()} points remain`,
    preClean.obsRemoved || preClean.ptsRemoved ? 'info' : 'debug', 'Reconstruction')
    refreshTracks()

    // Pre-filter solve stays pinhole ('none'): self-calibration before the tighter
    // cleanup can drift cx/cy badly (R6). Intrinsics are refined only below.
    await runBundleAdjust('bundle adjustment', baIterations, 'none')
    logOutlierShare('pre-filter residuals')

    // A3: retriangulate missed matches + merge split tracks under the improved
    // poses, then one more BA so the new/merged structure settles jointly.
    {
      report('retriangulate', 1, 'Retriangulating + merging tracks…', { done: cameras.size, total: imgs.length })
      const before = trackHist(tracks)
      const { added, lowParallax } = await retriangulatePairs({
        tracks, ids, cameras, pairs: donePairs, keypointsAt,
        maxReprojPx: filterMaxReprojPx, minTriAngleDeg: filterMinTriAngleDeg,
        triangulate: triangulateDlt,
      })
      const { merged } = mergeSplitTracks({ tracks, ids, cameras, pairs: donePairs, keypointsAt, maxReprojPx: filterMaxReprojPx })
      const completed = completeTracksFinal('post-BA')
      if (added || merged || completed) {
        const after = trackHist(tracks)
        log(`retriangulation +${added} point(s), merged ${merged} split track(s)`
          + `${lowParallax ? `, rejected ${lowParallax} low-parallax candidate(s)` : ''}; `
          + `${tracks.liveCount()} points`, 'info', 'Reconstruction')
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
        refreshTracks()
        const before = trackHist(tracks)
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
          tracks, ids, cameras, keypointsAt, gatePx,
          ratio: cfg.guidedRatio ?? 0.8, quantile: cfg.guidedQuantile ?? 0.9,
          onAdd: (p, img, kp) => guidedAdds.push({ uuid: ids.uuid(img), kp }),
          descOf: (img, k) => { const d = images[img]?.descU8; return d && (k + 1) * 128 <= d.length ? { arr: d, off: k * 128 } : null },
        })
        const after = trackHist(tracks)
        guidedRecord = [...(guidedRecord ?? []), { pass: round, ...g, gatePx, before, after }]
        log(`guided track extension (pass ${round}) +${g.added} observation(s) on ${g.pointsExtended} point(s) — `
          + `${g.lifted} lifted from 2 to ≥3 views (≤${gatePx.toFixed(1)}px, descriptor ≤ `
          + `${g.tau?.toFixed(3) ?? '–'} measured from ≥3-view tracks, ratio ${cfg.guidedRatio ?? 0.8}; ${g.windows} search window(s), `
          + `${g.proposals} proposal(s)); track lengths (2/3/4+ view) ${before.t2}/${before.t3}/${before.t4} → `
          + `${after.t2}/${after.t3}/${after.t4}`, 'info', 'Reconstruction')
        memoryMark('guided extension')
      } else if (round === 2 && cfg.guidedSkippedForMemory) {
        // The store's memory preflight turned guided extension off so the run fits
        // (memBudget.js): record it, so the summary and the verdict say what was lost.
        const m = cfg.guidedSkippedForMemory
        guidedRecord = [{ pass: round, skipped: 'memory', ...m }]
        log(`guided track extension skipped — the memory preflight projected the worker past its `
          + `ceiling with it on${m.reason ? ` (${m.reason})` : ''}; the model is complete without it, `
          + 'with fewer ≥3-view tracks', 'warn', 'Reconstruction')
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
      const { obsRemoved, ptsRemoved } = filterModelTracks({ maxReprojPx: thr.px, minTriAngleDeg: filterMinTriAngleDeg })
      log(`track filter pass ${round} (≤${thr.px.toFixed(1)}px, ≥${filterMinTriAngleDeg}° parallax) — `
        + `removed ${obsRemoved} obs + ${ptsRemoved} points; ${tracks.liveCount()} points remain`, 'info', 'Reconstruction')
      // Staged self-cal (WS2): under 'auto' the post-filter passes escalate the refined
      // terms (k2 / cx,cy / k3) as the camera + observation counts clear each gate; an
      // explicit user refine string is used verbatim (selfCalStaged is false).
      let refineMode = refineIntrinsics
      let reducedReason = null
      if (cfg.selfCalStaged) {
        let nObs = 0
        tracks.forEachPoint((p) => { nObs += tracks.viewCount(p) })
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
        const hist = trackHist(tracks)
        const ident = distortionIdentifiable({
          nCams: cameras.size,
          nTracks: tracks.liveCount(),
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
      const audit = auditGuidedAdditions(guidedAdds, (visit) => tracks.forEachPoint((p) => {
        const x = tracks.x(p), y = tracks.y(p), z = tracks.z(p)
        tracks.forEachView(p, (img, kp) => {
          const uuid = ids.uuid(img)
          const cam = cameras.get(uuid), set = keypointsAt(img)
          const pr = cam?.K && hasKp(set, kp) ? projectPoint(cam, x, y, z) : null
          visit(uuid, kp, pr ? Math.hypot(pr.u - kpX(set, kp), pr.v - kpY(set, kp)) : null)
        })
      }))
      guidedRecord.at(-1).audit = audit
      const f = (v) => (v == null ? '–' : v.toFixed(2))
      log(`guided track extension audit — ${audit.survived}/${audit.proposed} added observation(s) survived the `
        + `filter and BA; their residuals median ${f(audit.medianPx)}px, p90 ${f(audit.p90Px)}px vs every other `
        + `observation's ${f(audit.restMedianPx)}px / ${f(audit.restP90Px)}px`, 'info', 'Reconstruction')
    }

    log('bundle adjustment + filtering complete', 'success', 'Reconstruction')
  } else {
    log(`bundle adjustment skipped (cameras=${cameras.size}, `
      + `points=${tracks.liveCount()}, iters=${baIterations})`, 'debug', 'Reconstruction')
  }
  return { guidedRecord, trackCompletionRecord }
}

// The incremental solver needs 2-view points to bootstrap and register cameras,
// but final products do not need to expose them when a strong multi-view core is
// available. This removes the one class of point for which a wrong match along an
// epipolar line can retain low reprojection error with no independent witness.
// Returns the prune result (tracks.js pruneFinalTwoViewTracks) for the run summary.
export function pruneFinalTracks({ cfg, tracks, refreshTracks, log }) {
  const { finalMinTrackViews, finalTrackPruneMinCount, finalTrackPruneMinShare } = cfg
  const finalTrackPrune = pruneFinalTwoViewTracks(tracks, {
    minViews: finalMinTrackViews,
    minSupportedTracks: finalTrackPruneMinCount,
    minSupportedShare: finalTrackPruneMinShare,
  })
  if (finalTrackPrune.applied) {
    refreshTracks()
    log(`final track-quality cleanup — removed ${finalTrackPrune.removed} uncorroborated `
      + `2-view point(s); ${finalTrackPrune.supported} point(s) with ≥${finalMinTrackViews} views remain`,
    finalTrackPrune.removed ? 'info' : 'debug', 'Reconstruction')
  } else if (finalTrackPrune.total > 0 && finalMinTrackViews > 2) {
    log(`final track-quality cleanup kept 2-view points — only ${finalTrackPrune.supported}/`
      + `${finalTrackPrune.total} (${(100 * finalTrackPrune.supportedShare).toFixed(1)}%) have `
      + `≥${finalMinTrackViews} views, below the safe automatic-pruning floor`,
    'warn', 'Reconstruction')
  }
  return finalTrackPrune
}

// Incremental Structure-from-Motion — the public entry. Pure compute, no Vue/Pinia/
// OPFS. Lifted verbatim from useReconstructionStore so it can run inside the
// compute worker (off the main thread). Side effects are injected as hooks:
//   onLog(message, level, category)   — diagnostics (mirrors the app log)
//   onProgress(done, total, label)    — progress for the modal
// The store keeps persistence (OPFS) and reactive state; this module only takes
// plain data in and returns plain data out.
//
// This file owns the multi-model orchestration — the primary model, alternate-seed
// retries and secondary-model recovery (reconstruct) — and the per-sub-run input copy
// (cloneSfmInput). One model from one seed is singleModel.js; its stages live in
// runRecord.js, selfCalFold.js, bundleSession.js and refinePipeline.js.
//
// Input:
//   images:   [{ uuid, name, keypoints, meta: { width, height, focalLength35 } | null }]
//             keypoints: a KeypointSet (keypointSet.js; what the store sends) or
//             [{x, y, color?}, …] (tests). reconstruct() turns them into `img.kp` sets.
//   pairs:    [{ idA, idB, F: number[3][3], matches: [[ia,ib], …], inlierCount, status }]
//             (only 'done' pairs are used; the store passes those)
//   settings: tuning knobs (resolved in singleModel.js; defaults.user.js + tuning.js)
// Output:
//   { status: 'idle' | 'done' | 'error',
//     cameras: [{ uuid, R, t, K }],
//     points:  [{ x, y, z, views: [[uuid, kpIdx], …] }] }

import { scopeProgress, RUN_BUDGET, sliceRange } from './progressPlan.js'
import { SFM_TUNING } from '../tuning.js'
import { buildScaleContext, describeScaleContext } from '../scaleContext.js'
import { secondaryJobs, alignSecondary, mergeAligned } from './multiModel.js'
import { wrapPackedMatches } from './matchCodec.js'
import { keypointSetFrom } from './keypointSet.js'
import { reconstructSingleModel } from './singleModel.js'

// Re-export the extracted pure modules so existing importers (sfm.test.js and any
// others that reached for these through sfm.js) keep working unchanged.
export { retriangulatePairs, mergeSplitTracks, pruneFinalTwoViewTracks, completeTracks } from './tracks.js'

// A working copy of the SfM input (or of an image / pair list) for one sub-run. The
// caller keeps the original as the pristine input for seed retries and secondary
// models, because a run moves its keypoints (ingest undistortion, the self-cal fold)
// and pairs (refitted F). Two image fields are SHARED, not cloned, because nothing
// writes into them: `descU8`, the guided-extension descriptors (cloning doubled them,
// 128 B per keypoint — 576 MB on the 4.5 M-keypoint Monster set), and `kp`, the
// keypoint set — a move replaces `img.kp` with a new set on the copy and never writes
// into the shared one (keypointSet.js). Only the small per-image records are copied.
const SHARED_IMAGE_FIELDS = ['descU8', 'kp']
export function cloneSfmInput(value) {
  const isList = Array.isArray(value)
  const list = isList ? value : value?.images
  const shared = list ? list.map((im) => SHARED_IMAGE_FIELDS.map((f) => im?.[f] ?? null)) : null
  const strip = (im) => {
    if (!im || !SHARED_IMAGE_FIELDS.some((f) => im[f])) return im
    const out = { ...im }
    for (const f of SHARED_IMAGE_FIELDS) if (out[f]) out[f] = null
    return out
  }
  const src = isList ? value.map(strip) : list ? { ...value, images: list.map(strip) } : value
  const copy = structuredClone(src)
  const out = isList ? copy : copy?.images
  if (shared && out) {
    out.forEach((im, i) => {
      if (!im) return
      SHARED_IMAGE_FIELDS.forEach((f, j) => { if (shared[i][j]) im[f] = shared[i][j] })
    })
  }
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
  // Keypoints as immutable typed-array sets (`img.kp`, keypointSet.js) from here on,
  // shared by every sub-run's working copy. New image records, so the caller's objects
  // are not touched.
  input = {
    ...input,
    images: (input.images || []).map(({ keypoints, ...img }) => ({ ...img, kp: img.kp ?? keypointSetFrom(keypoints) })),
  }
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
  // Images any attempt registered: a retry seeds where none of them reached
  // (initPair.js exploredInitImages), so the retries explore the match graph.
  const explored = new Set(primary.cameras.map((c) => c.uuid))
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
      settings: { ...(input.settings || {}), secondaryModels: false, excludedInitPairs: [...excluded],
        exploredInitImages: [...explored] },
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
      // A failed retry has no summary, but it may have committed to a seed before it
      // failed (`seedPair`): exclude that too, or every later retry repeats it.
      const failed = candidate.seedPair ?? null
      attempts.seeds.push({
        attempt: attempt + 1, pair: failed ? `${failed.nameA} ↔ ${failed.nameB}` : null,
        cameras: 0, points: 0, kept: false, status: candidate.status,
      })
      const failedKey = pairKey(failed)
      if (!failedKey) {
        // Failed before choosing a seed: the same exclusions would fail the same way.
        log(`seed retry ${attempt + 1} found no usable seed (${candidate.status}); stopping the retries`,
          'warn', 'Reconstruction')
        break
      }
      excluded.add(failedKey)
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
    for (const c of candidate.cameras) explored.add(c.uuid)
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

// One incremental SfM model from one seed (reconstructSingleModel): owns the run's
// model state — the camera Map, the track store, the image ids — and wires the stages
// over it in order: run record + gates (runRecord.js), ingest (ingest.js), seed
// (initPair.js), incremental registration (register.js), refinement
// (refinePipeline.js), the survey-constrained solves (bundleSession.js) and the
// summary. Every stage shares the same objects by reference: the self-cal fold
// replaces `img.kp` and rewrites Kmap / GCP marks in place, and `refreshTracks`
// renumbers point ids, so no stage holds a point id across it. Seed retries and
// secondary models are reconstruct()'s job (sfm.js).
//
// With `input.base` (a saved model, extendModel.js) the run starts from that model in
// place of a seed pair: its cameras stay fixed, self-calibration is off, and only the
// images it lacks are registered.

import { markToCentrePx } from './displayFrame.js'
import {
  applyFiducialFrames,
  resolveIntrinsics,
  gcpObservationMover,
  undistortAtIngest,
  refitMovedPairs,
} from './ingest.js'
import { makeProgressReporter } from './progressPlan.js'
import { completeTracks, mergeSplitTracks, filterTracks } from './tracks.js'
import { selectInitPair } from './initPair.js'
import { seedFromModel } from './extendModel.js'
import { registerImages } from './register.js'
import { RECONSTRUCT_DEFAULTS } from '../defaults.user.js'
import { SFM_TUNING } from '../tuning.js'
import { compactTrackRecords } from './resultCodec.js'
import { createTrackStore, makeImageIds } from './trackStore.js'
import { hasKp, kpX, kpY } from './keypointSet.js'
import { registrationOutliers, deregisterCamera } from './registrationCheck.js'
import { estimateFocalsFromPairs } from './focalFromPairs.js'
import { isFisheyeModel } from './distortion.js'
import { numStats, fmtStats, modelResiduals as residualsOf, trackHist } from './modelStats.js'
import { createSelfCalFold } from './selfCalFold.js'
import { createBundleSession } from './bundleSession.js'
import { refineModel, pruneFinalTracks } from './refinePipeline.js'
import {
  captureRunConfig,
  resolveGates,
  resolveRefineIntrinsics,
  logMatchGraphHealth,
  logPerCameraResiduals,
  logRunTotals,
  unregisteredComponents,
  finaliseIntrinsics,
  assembleSummary,
} from './runRecord.js'
import { pluralize } from '../textFormat.js'
import { sparseSnapshot, createSnapshotPacer } from './liveSnapshot.js'

// ── Geometry helpers ────────────────────────────────────────────────────────────
// Depth of world point (x,y,z) along a flat 3×4 projection matrix's principal
// axis. P is row-major [r0(4), r1(4), r2(4)]; depth = r2 · [x, y, z, 1].
// Positive ⇒ the point is in front of that camera (cheirality).
function projDepth(P, x, y, z) {
  return P[8] * x + P[9] * y + P[10] * z + P[11]
}

// Score, take out, re-register, re-check (see the call site). Returns the run record:
// { median, limit, flagged: [{ name, px }], readmitted: [name], dropped: [name] }.
async function recheckRegistrations({
  protect = null,
  cfg,
  cameras,
  tracks,
  ids,
  keypointsAt,
  donePairs,
  registeredUuids,
  refreshTracks,
  imageByUuid,
  log,
  runBundleAdjust,
  reregister,
}) {
  const check = () =>
    registrationOutliers({
      cameras,
      pairs: donePairs,
      keypointsAt,
      ids,
      scale: cfg.detectScaleFactor ?? 1,
      cfg: cfg.registrationCheck,
    })
  const nameOf = (u) => imageByUuid(u)?.name ?? u
  const scored = check()
  // An extension's fixed cameras are the model itself: only the new ones are judged.
  const first = protect ? { ...scored, flagged: scored.flagged.filter((f) => !protect.has(f.uuid)) } : scored
  const record = {
    median: first.median,
    limit: first.limit,
    flagged: first.flagged.map((f) => ({ name: nameOf(f.uuid), px: f.px })),
    readmitted: [],
    dropped: [],
  }
  log(
    `registration check — ${pluralize(first.scores.size, 'camera')} against their strongest verified pairs: median ` +
      `${first.median.toFixed(2)}px, limit ${first.limit.toFixed(1)}px, ${pluralize(first.flagged.length, 'outlier')}`,
    first.flagged.length ? 'warn' : 'info',
    'Reconstruction',
  )
  if (!first.flagged.length || cameras.size - first.flagged.length < 2) return record
  for (const { uuid, px } of first.flagged) {
    const gone = deregisterCamera({ uuid, cameras, registeredUuids, tracks, ids })
    log(
      `  ${nameOf(uuid)} disagrees with its pairs by ${px.toFixed(1)}px — taken out of the model ` +
        `(${pluralize(gone, 'point')} only it supported) for re-registration`,
      'warn',
      'Reconstruction',
    )
  }
  refreshTracks()
  await reregister()
  await runBundleAdjust('post-check bundle adjustment', cfg.baIterations, 'none', { warm: true })
  const second = check()
  const stillBad = new Set(second.flagged.map((f) => f.uuid))
  for (const { uuid } of first.flagged) {
    if (!cameras.has(uuid)) record.dropped.push(nameOf(uuid))
    else if (stillBad.has(uuid)) {
      deregisterCamera({ uuid, cameras, registeredUuids, tracks, ids })
      record.dropped.push(nameOf(uuid))
    } else record.readmitted.push(nameOf(uuid))
  }
  if (record.dropped.length) {
    refreshTracks()
    await runBundleAdjust('post-check bundle adjustment (outliers left out)', cfg.baIterations, 'none', { warm: true })
  }
  log(
    `registration check: ${record.readmitted.length} re-registered consistently` +
      `${record.readmitted.length ? ` (${record.readmitted.join(', ')})` : ''}, ${record.dropped.length} left out` +
      `${record.dropped.length ? ` (${record.dropped.join(', ')})` : ''}`,
    record.dropped.length ? 'warn' : 'success',
    'Reconstruction',
  )
  return record
}

export async function reconstructSingleModel(input, hooks = {}) {
  const { images, pairs, settings = {}, gcps = [], cameraPriors = [], base = null } = input
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
  // The solver policy merges key by key: a partial override ({ pcgRelTol }) replacing the
  // whole object silently dropped functionTolerance, so LM ran to its iteration cap and an
  // overnight sweep read that as the override's cost (HANDOVER ▸ B-parity).
  cfg.baSolver = { ...SFM_TUNING.baSolver, ...(settings.baSolver ?? {}) }
  // An extension keeps the model's lens: self-calibration would move the fixed cameras'
  // frame under them.
  if (base) cfg.refineIntrinsics = 'none'
  const log = hooks.onLog ?? (() => {})

  // The knobs as requested — captured HERE, before resolveGates and the 'auto'
  // self-cal resolution below mutate `cfg` (runRecord.js captureRunConfig).
  const runConfig = captureRunConfig({ cfg, settings, cameraPriors })
  // Records the stages fill in as they run (ingest.js, bundleSession.js,
  // refinePipeline.js); every field stays null when its stage didn't run, so a
  // missing number is never confused with a zero.
  const selfCalRecord = { requested: cfg.refineIntrinsics, resolved: null, staged: false, passes: [], adjustments: [] }
  const intrinsicsRecord = new Map() // sensorId → { fxNominal, fxFinal, cx, cy, source, label }

  // Detect-px → native-px gates, resolved on `cfg` before anything reads them.
  const gateRecord = resolveGates({ cfg, settings, images, log })
  // Progress is phase-weighted (core/sfm/progressPlan.js), not a camera count: the
  // count reaches its maximum at the end of registration, which is roughly halfway
  // through the run. `hooks.progressRange` lets a nested sub-run (seed retry /
  // secondary model) report an honest local 0..1 into a slice of the parent's bar.
  const onProgress = hooks.onProgress
  const reportProgress = makeProgressReporter(onProgress, hooks.progressRange ?? {})
  // Every phase's progress report also offers the live view a snapshot (paced).
  let snapshots = null
  const report = (...args) => {
    reportProgress(...args)
    snapshots?.tick()
  }

  // uuid → image, built once: it was a linear `images.find` per call, and it is called
  // per observation (BA, residuals) and per candidate keypoint (guided extension). The
  // image list never changes within a run; folds replace `img.kp` on the same
  // object, so the map stays valid. First occurrence wins, as `find` did.
  const imageMap = new Map()
  for (const img of images) if (!imageMap.has(img.uuid)) imageMap.set(img.uuid, img)
  const imageByUuid = (uuid) => imageMap.get(uuid) || null
  // Images by dense index for the track store (trackStore.js): `ids.img(uuid)` /
  // `ids.uuid(img)`; `images[img]` is the same object `imageByUuid` returns.
  const ids = makeImageIds(images.map((img) => img.uuid))
  // An image's KeypointSet (keypointSet.js) by image index, or null. Shared by the BA
  // observation builders, the track functions and guided extension.
  const keypointsAt = (img) => images[img]?.kp ?? null

  // Local model state (was reactive refs in the store).
  const cameras = new Map() // uuid → { R, t, K }
  // Points and their observations (trackStore.js): dense point ids, views keyed by
  // image index, and the keypoint → point index the old `viewIndex` Map was.
  const tracks = createTrackStore(
    images.map((img) => img.kp?.n ?? 0),
    { impl: cfg.trackStore },
  )
  // `hooks.onSnapshot(snapshot)`: the model so far, for the live 3D view (liveSnapshot.js),
  // at most every few seconds while cameras register.
  snapshots = createSnapshotPacer(hooks.onSnapshot, () =>
    cameras.size >= 2 ? sparseSnapshot(cameras, tracks, { keypointsAt }) : null,
  )

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

  // Reprojection residuals of the current model (modelStats.js) and their summary.
  const modelResiduals = () => residualsOf({ tracks, cameras, ids, images })
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
    log(`stage "${label}" took ${stageTimes[label].toFixed(0)}ms`, 'debug', 'Reconstruction')
  }
  // A finer boundary than markStage for memory measurement only: the bench samples the
  // worker heap and attributes each peak to the segment the next mark closes
  // (scripts/bench/workerHeap.mjs). Debug level; not part of the run record.
  const memoryMark = (label) => log(`memory mark "${label}"`, 'debug', 'Reconstruction')

  // Per-track colour: median (per channel) of the source-image RGB sampled at
  // each observing keypoint. Median (not mean) is robust to a stray observation
  // landing on a different surface. Returns null when no view carries a colour.
  const pointColor = (p) => {
    const rs = [],
      gs = [],
      bs = []
    tracks.forEachView(p, (img, kpIdx) => {
      const set = keypointsAt(img)
      if (set?.hasColor?.[kpIdx]) {
        rs.push(set.rgb[3 * kpIdx])
        gs.push(set.rgb[3 * kpIdx + 1])
        bs.push(set.rgb[3 * kpIdx + 2])
      }
    })
    if (!rs.length) return null
    const med = (a) => {
      a.sort((x, y) => x - y)
      return a[a.length >> 1]
    }
    return [med(rs), med(gs), med(bs)]
  }

  // The seed this run committed to, once chosen. A run that fails after that returns
  // no summary, so the failure carries it instead (`seedPair`): the alternate-seed
  // retries in reconstruct() must exclude it, or they repeat the same failing seed.
  let seedPair = null
  const done = (status, summary = null) => ({
    status,
    ...(status !== 'done' && seedPair ? { seedPair } : {}),
    cameras: [...cameras.entries()].map(([uuid, cam]) => ({ uuid, ...cam })),
    // Fold the solver's tracks directly into shared CSR buffers. Creating an
    // intermediate [uuid,kp,x,y] array for each observation made finalisation's
    // peak proportional to millions of JS objects and could kill the worker after
    // it had already logged success. The slices remain iterable/Map-compatible for
    // secondary-model alignment and callers of this pure module.
    points: compactTrackRecords(tracks, {
      uuidOf: ids.uuid,
      colorOf: pointColor,
      pixelOf: (img, kpIdx) => {
        const set = keypointsAt(img)
        return hasKp(set, kpIdx) ? [kpX(set, kpIdx), kpY(set, kpIdx)] : null
      },
    }),
    summary,
  })

  try {
    const imgs = images.filter((img) => img.kpStatus === 'done')
    if (imgs.length < 2) {
      log('need at least 2 images with keypoints', 'warn', 'Reconstruction')
      return done('idle')
    }
    log(
      `starting with ${imgs.length} images, ${donePairs.length} match pairs` +
        `${weakPairs.length ? ` (+${weakPairs.length} weak PnP bridge${weakPairs.length === 1 ? '' : 's'})` : ''}`,
      'info',
      'Reconstruction',
    )

    logMatchGraphHealth({ imgs, donePairs, log })
    // An extension rebuilds the model's frame from the keypoints as detected.
    const rawKp = base ? new Map(imgs.map((im) => [im.uuid, im.kp])) : null

    // ── Ingest: film frames, K, ingest undistortion, F refit (ingest.js) ─────
    const fiducialTransforms = applyFiducialFrames({ imgs, gcps, log })
    const { Kmap, defaultKCount } = resolveIntrinsics({ imgs, intrinsicsRecord, log })
    const moveGcpObs = gcpObservationMover(gcps)
    const { anyCalibratedDistortion, undistortedUuids } = undistortAtIngest({ imgs, Kmap, moveGcpObs, log })
    refitMovedPairs({
      donePairs,
      bridgePairs: weakPairs,
      imageByUuid,
      log,
      movedUuids: new Set([...undistortedUuids, ...fiducialTransforms.keys()]),
    })

    // No focal in the metadata (resolveK's default-FOV guess): estimate it from the
    // verified pair geometry before registration builds on it (focalFromPairs.js).
    // Film scans and fisheye lenses keep their own paths, and self-calibration 'none'
    // (the user's "leave the intrinsics as they are") keeps the guess too.
    if (!base && defaultKCount > 0 && cfg.refineIntrinsics !== 'none') {
      const imgByUuid = new Map(imgs.map((im) => [im.uuid, im]))
      const set = estimateFocalsFromPairs({
        imgs,
        Kmap,
        pairs: donePairs,
        isGuess: (u) => {
          const im = imgByUuid.get(u)
          return (
            Kmap.get(u)?.source?.startsWith('default') &&
            im?.sensor?.kind !== 'film' &&
            !isFisheyeModel(im?.sensor?.distortionModel)
          )
        },
        groupOf: (u) => imgByUuid.get(u)?.sensorId ?? `image:${u}`,
        dims: (u) => {
          const im = imgByUuid.get(u),
            K = Kmap.get(u)
          return {
            width: im?.sensor?.width || im?.meta?.width || 2 * K.cx,
            height: im?.sensor?.height || im?.meta?.height || 2 * K.cy,
          }
        },
      })
      for (const g of set) {
        const rec = intrinsicsRecord.get(g.group)
        const first = imgs.find((im) => (im.sensorId ?? `image:${im.uuid}`) === g.group)
        if (rec && first) {
          rec.fxNominal = Kmap.get(first.uuid).fx
          rec.source = Kmap.get(first.uuid).source
        }
        log(
          `focal from pair geometry — ${pluralize(g.images, 'image')} without a focal in their metadata` +
            `${first?.sensor?.label ? ` (${first.sensor.label})` : ''}: f = ${g.s.toFixed(3)} × image size` +
            ` (${first ? Kmap.get(first.uuid).fx.toFixed(0) : '?'}px), ${g.n} of ${pluralize(g.of, 'pair')} agree within 10 %` +
            `${g.own ? '' : ' (pooled over all such images)'}`,
          'info',
          'Reconstruction',
        )
      }
    }

    // 'auto' self-calibration → a concrete mode, now that ingest knows whether a
    // calibrated distortion model exists (runRecord.js resolveRefineIntrinsics).
    resolveRefineIntrinsics({
      cfg,
      anyCalibratedDistortion,
      selfCalRecord,
      log,
      anyReseauCalibrated:
        [...fiducialTransforms.values()].some((t) => t.transform?.residual) ||
        imgs.some((img) => img.sensor?.reseauStitched || img.sensor?.panoramicSegments),
    })

    if (!base && defaultKCount > 0) {
      log(
        `${pluralize(defaultKCount, 'image')} of ${imgs.length} ${defaultKCount === 1 ? 'has' : 'have'} no focal length — using a default FOV guess. ` +
          `Wrong intrinsics distort the geometry and commonly prevent cameras from registering; ` +
          `supply a focal length or sensor size for reliable results.`,
        defaultKCount === imgs.length ? 'warn' : 'info',
        'Reconstruction',
      )
    }

    // Two-view initialisation + seed selection lives in initPair.js. It probes
    // every candidate (pose recovery + triangulation + cheirality + init reproj)
    // and returns a sound seed with strong one-step growth support; the local helpers
    // it needs are injected so it stays pure (no cycle back into this file).
    // The seed: the best two-view start, or the saved model an extension grows.
    let best = null,
      perPairInitReproj = null,
      bestPair = null,
      imgA = null,
      imgB = null,
      seedPointCount = 0
    let extension = null
    if (base) {
      const seeded = seedFromModel({
        imgs,
        rawKp,
        base,
        Kmap,
        fiducialTransforms,
        cameras,
        tracks,
        ids,
        maxFrameMedianPx: cfg.extendFrameMaxMedianPx,
      })
      if (!seeded.ok) {
        log(`Cannot add the images to the model: ${seeded.reason}`, 'error', 'Reconstruction')
        return { ...done('error'), reason: seeded.reason }
      }
      extension = seeded
      seedPointCount = tracks.liveCount()
      log(
        `starting from the model: ${pluralize(cameras.size, 'camera')} (held fixed), ` +
          `${seedPointCount.toLocaleString()} points; ${pluralize(seeded.added.length, 'image')} to add` +
          (seeded.ownLens ? `, ${seeded.ownLens} on a lens the model has not seen` : ''),
        'info',
        'Reconstruction',
      )
      log(
        `model frame rebuilt from the detected keypoints: ${seeded.frame.n.toLocaleString()} observations, ` +
          `median ${seeded.frame.medianPx.toFixed(3)} px, p95 ${seeded.frame.p95Px.toFixed(3)} px from the saved pixels`,
        'debug',
        'Reconstruction',
      )
      markStage('init')
      report('initPair', 1, `Model: ${pluralize(cameras.size, 'camera')}`, { done: cameras.size, total: imgs.length })
    } else {
      const initSel = await selectInitPair(
        { donePairs, Kmap, settings: cfg, imageByUuid, numStats, projDepth },
        {
          onLog: log,
          onProgress: onProgress
            ? (k, m) =>
                report('initPair', m > 0 ? (k + 1) / m : 0, `Scoring initial pairs ${k + 1}/${m}…`, {
                  done: k + 1,
                  total: m,
                })
            : undefined,
        },
      )
      if (initSel.status !== 'ok') return done(initSel.status)
      ;({ best, perPairInitReproj } = initSel)

      bestPair = best.entry
      imgA = best.iA
      imgB = best.iB
      seedPair = { idA: bestPair.idA, idB: bestPair.idB, nameA: imgA.name, nameB: imgB.name }
      cameras.set(bestPair.idA, best.cA)
      cameras.set(bestPair.idB, best.cB)
      // The seed's points become the first tracks, in order; this also seeds the
      // keypoint → point index.
      for (const pt of best.points) {
        const p = tracks.addPoint(pt.x, pt.y, pt.z)
        pt.views.forEach((kpIdx, uuid) => tracks.addView(p, ids.img(uuid), kpIdx))
      }
      seedPointCount = best.points.length

      log(
        `initial pair ${imgA.name} ↔ ${imgB.name} ` +
          `(${best.inliers} inliers, ${best.points.length} pts, ${best.angle.toFixed(2)}° parallax)`,
        'success',
        'Reconstruction',
      )
      log(`init reprojection — ${fmtStats(modelReprojStats())}`, 'debug', 'Reconstruction')
      // Essential-matrix conditioning: σ2/σ1 ≈ 1 for a valid E. A low ratio of Kᵀ F K
      // means wrong intrinsics OR a degenerate F (near-planar scene: F is undetermined
      // there). When the seed came from the calibrated five-point E instead
      // (initPair.js), say so — that is the planar case, not a focal problem.
      {
        const { s1, s2, s3 } = best.fEsv ?? best.esv
        const ratio = s1 > 0 ? s2 / s1 : 0
        const fivePt = best.eSource === '5pt'
        // Only flag below 0.9: a healthy E sits at ~0.95–1.0.
        const conditioning =
          ratio >= 0.9
            ? ''
            : fivePt
              ? " — the matcher's F is degenerate here (near-planar scene); the seed pose comes from the calibrated five-point E"
              : ' — well below 1 points to wrong intrinsics (focal / principal point), which ' +
                'inflates init reprojection and typically blocks PnP registration'
        log(
          `essential matrix (Kᵀ F K) σ = [${s1.toFixed(3)}, ${s2.toFixed(3)}, ${s3.toFixed(3)}] — ` +
            `σ2/σ1 ${ratio.toFixed(2)} (ideal ≈ 1.0)${conditioning}`,
          ratio < 0.7 && !fivePt ? 'warn' : 'debug',
          'Reconstruction',
        )
      }
      markStage('init')
      report('initPair', 1, `Initial pair: ${imgA.name} ↔ ${imgB.name}`, { done: 2, total: imgs.length })
    }

    // ── Track index ──────────────────────────────────────────────────────────
    // The reverse map keypoint → point (`tracks.pointAt`) is what makes tracks
    // (rather than a heap of 2-view points) possible: registration asks "does this
    // keypoint already belong to a point?" in O(1) and either extends that track or
    // knows to triangulate fresh structure. The store keeps it current as views are
    // added and removed. Where the old code rebuilt its index Map (after bundle
    // adjustment, filtering, merging), `refreshTracks` compacts the store — renumbering
    // the points, so no point id may be held across it — and rebuilds the index in
    // point order (trackStore.js ▸ reindex).
    const refreshTracks = () => tracks.compact()

    // ── Bundle-adjustment / filtering wiring (R3) ────────────────────────────────
    // The BA session and the track filter are needed *during* incremental registration
    // (interleaved BA), not just after it, so they are created here, before
    // registerImages, together with the sensor-group map they share.
    // Map each image's sensor to a stable integer so BA can share one focal across
    // all cameras on the same sensor. Images without an assigned sensor get their
    // own group (−1 sentinel); reconstruction still runs pinhole otherwise.
    const sensorIntByUuid = new Map()
    {
      const idToInt = new Map()
      for (const img of imgs) {
        const sid = img.sensorId ?? null
        if (sid == null) {
          sensorIntByUuid.set(img.uuid, -1)
          continue
        }
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
    // stage runs the same function to a fixpoint (refinePipeline.js completeTracksFinal).
    const foldOneEndpointMatches = (gate) =>
      completeTracks({
        tracks,
        ids,
        cameras,
        pairs: donePairs,
        keypointsAt,
        maxReprojPx: gate,
      }).added

    // Consolidate split tracks: the *both*-endpoints-assigned case foldOneEndpointMatches
    // skips (line above) — a verified match whose two ends already belong to two DIFFERENT
    // points means one physical feature was reconstructed twice. mergeSplitTracks folds the
    // loser into the winner (conflict- + reproj-gated). It ran only once post-BA before, so
    // the model grew mostly 2-view during registration (the building run finished at 15%
    // ≥3-view tracks); running it in the interim cleanup as the model builds raises track
    // multiplicity early, which both conditions BA better and gives later PnP longer, more
    // stable points. Removes the merged-away points from the store; callers
    // refreshTracks afterwards. Same maxReprojPx gate as the post-BA merge.
    const mergeTracks = (gate) =>
      mergeSplitTracks({
        tracks,
        ids,
        cameras,
        pairs: donePairs,
        keypointsAt,
        maxReprojPx: gate,
      }).merged

    // Track filtering (tracks.js filterTracks) over the live model, for the interim
    // cleanups during registration.
    const filterModelTracks = (gates) => filterTracks({ tracks, ids, cameras, keypointsAt, ...gates })

    // Self-cal groups + distortion fold (selfCalFold.js) and every bundle adjustment
    // (bundleSession.js). Both before registerImages: the interim BA self-calibrates
    // f,k1 mid-registration (D3) and folds during the registration call.
    const selfCal = createSelfCalFold({
      imgs,
      cameras,
      Kmap,
      moveGcpObs,
      sensorIntByUuid,
      fiducialTransforms,
      log,
      refoldMovePx: cfg.selfCalRefoldMovePx,
      composedWarnPx: cfg.selfCalComposedWarnPx,
    })
    const bundles = createBundleSession({
      cfg,
      cameras,
      tracks,
      ids,
      keypointsAt,
      imageByUuid,
      sensorIntByUuid,
      intrinsicsRecord,
      selfCalRecord,
      selfCal,
      cameraPriors,
      gcps,
      modelReprojStats,
      log,
      fixedCameras: extension?.fixed ?? null,
    })

    // ── Incremental registration ───────────────────────────────────────────
    // Grow the sparse model one camera at a time — next-best-view ordering,
    // two-gate PnP, track extension/triangulation, interleaved BA. Extracted to
    // register.js (see there). registeredUuids is created HERE, seeded with the
    // initial pair; the track store is shared and mutated in place by register.js
    // and the injected BA/filter closures alike.
    const registeredUuids = extension ? new Set(cameras.keys()) : new Set([bestPair.idA, bestPair.idB])
    const registrationCtx = {
      imgs,
      donePairs,
      Kmap,
      cfg,
      // corrPairs = strong + weak bridges. register.js draws PnP
      // correspondences from this superset but triangulates fresh structure only from
      // donePairs — weak pairs extend registration reach without seeding geometry.
      corrPairs: [...donePairs, ...weakPairs],
      cameras,
      tracks,
      ids,
      keypointsAt,
      registeredUuids,
      refreshTracks,
      foldOneEndpointMatches,
      mergeTracks,
      runBundleAdjust: bundles.runBundleAdjust,
      runLocalBundleAdjust: bundles.runLocalBundleAdjust,
      filterTracks: filterModelTracks,
      modelReprojStats,
      imageByUuid,
      numStats,
      log,
      onProgress,
      reportPhase: (local, label, counts) => report('register', local, label, counts),
    }
    await registerImages(registrationCtx)
    snapshots.tick({ force: true })
    const preBaStats = modelReprojStats()
    log(`pre-BA reprojection — ${fmtStats(preBaStats)}`, 'info', 'Reconstruction')
    markStage('registration')

    // ── Bundle adjustment + track filtering (Phase 2 + 3, refinePipeline.js) ──
    const { guidedRecord, trackCompletionRecord } = await refineModel({
      cfg,
      images,
      imgs,
      cameras,
      tracks,
      ids,
      keypointsAt,
      donePairs,
      refreshTracks,
      modelResiduals,
      runBundleAdjust: bundles.runBundleAdjust,
      lastSolve: bundles.lastSolve,
      selfCalRecord,
      intrinsicsRecord,
      imageByUuid,
      defaultKCount,
      log,
      report,
      memoryMark,
      selfCalLensTerms: imgs.reduce((m, im) => Math.max(m, selfCal.lensOf(im.uuid)?.terms ?? 0), 0),
    })
    snapshots.tick({ force: true })
    // ── Registration plausibility (registrationCheck.js) ─────────────────────
    // A camera can register in a wrong place and stay there self-consistently (it
    // triangulates its own points). Score every camera against the epipolar geometry of
    // its strongest verified pairs; take outliers out, let a final registration sweep
    // re-resect them against the now complete model, re-solve, and leave out any that
    // still disagree — an unregistered camera is better than a misplaced one.
    const registrationCheck = await recheckRegistrations({
      protect: extension?.fixed ?? null,
      cfg,
      cameras,
      tracks,
      ids,
      keypointsAt,
      donePairs,
      registeredUuids,
      refreshTracks,
      imageByUuid,
      log,
      runBundleAdjust: bundles.runBundleAdjust,
      reregister: () => registerImages({ ...registrationCtx, finalSweep: true }),
    })

    // Survey-constrained solves (bundleSession.js): camera positions, then GCPs. An
    // extension's fixed cameras already carry them, and the new ones are held to those.
    if (!extension && cameraPriors.length && cameras.size >= 2 && tracks.liveCount() >= 10) {
      report('gcpBundle', 1, 'Camera-position constrained bundle adjustment…', {
        done: cameras.size,
        total: imgs.length,
      })
      await bundles.runCameraPriorBundleAdjust()
    }
    if (!extension && gcps.length && cameras.size >= 2 && tracks.liveCount() >= 10) {
      report('gcpBundle', 1, 'GCP-anchored bundle adjustment…', { done: cameras.size, total: imgs.length })
      await bundles.runGcpAnchoredBundleAdjust()
    }
    markStage('bundleAdjust')

    const finalTrackPrune = pruneFinalTracks({ cfg, tracks, refreshTracks, keypointsAt, log })

    // ── Run record + summary (runRecord.js) ──────────────────────────────────
    logPerCameraResiduals({ tracks, ids, cameras, keypointsAt, imageByUuid, modelResiduals, log })
    const hist = trackHist(tracks)
    const { t3: tracks3, t4: tracks4 } = hist
    const totalMs = performance.now() - t0
    logRunTotals({ hist, totalMs, stageTimes, solverTotals: bundles.solverTotals, baSolver: cfg.baSolver, log })

    const finalStats = modelReprojStats()
    const nPoints = tracks.liveCount()
    const pct3plusViewTracks = nPoints ? (100 * (tracks3 + tracks4)) / nPoints : 0
    const remainingComponents = unregisteredComponents({ imgs, cameras, donePairs, imageByUuid, cfg, log })
    finaliseIntrinsics({ imgs, cameras, Kmap, intrinsicsRecord })
    const summary = assembleSummary({
      cameras,
      nPoints,
      pct3plusViewTracks,
      preBaStats,
      finalStats,
      bestPair,
      imgA,
      imgB,
      best,
      seedPointCount,
      perPairInitReproj,
      runConfig,
      gateRecord,
      guidedRecord,
      selfCalRecord,
      trackCompletionRecord,
      intrinsicsRecord,
      stageTimes,
      t0,
      solverTotals: bundles.solverTotals,
      baSolver: cfg.baSolver,
      finalTrackPrune,
      finalMinTrackViews: cfg.finalMinTrackViews,
      remainingComponents,
      // An extension's lens is the model's (self-calibration is off for it).
      selfCalDistortion: extension ? (base.summary?.selfCalDistortion ?? []) : selfCal.distortionSummary(),
      fiducialTransforms,
      initPairRecord: extension ? (base.summary?.initPair ?? null) : undefined,
    })
    if (extension) {
      const added = extension.added.filter((u) => cameras.has(u))
      summary.extension = {
        modelCameras: extension.fixed.size,
        added: added.length,
        notAdded: extension.added.filter((u) => !cameras.has(u)).map((u) => imageByUuid(u)?.name ?? u),
        addedNames: added.map((u) => imageByUuid(u)?.name ?? u),
        frame: extension.frame,
      }
    }
    summary.registrationCheck = registrationCheck

    memoryMark('final cleanup + summary')
    report('finalize', 1, 'Finalising model…', { done: cameras.size, total: imgs.length })
    // A run that finishes with no points (or a single camera) is a failed
    // reconstruction, not a success — log it red so it doesn't read as green.
    const degenerate = tracks.liveCount() === 0 || cameras.size < 2
    log(
      `Reconstruction complete: ${cameras.size} cameras, ${tracks.liveCount()} points, ` +
        `final reprojection ${fmtStats(finalStats)}`,
      degenerate ? 'error' : 'success',
      'Reconstruction',
    )
    log(
      `Reconstruction summary: ${summary.nCameras} cameras, ${summary.nPoints} points, ` +
        `${pct3plusViewTracks.toFixed(1)}% ≥3-view tracks, pre-BA p95 ${preBaStats.p95.toFixed(1)}px, ` +
        `post-BA median ${finalStats.median.toFixed(2)}px`,
      'success',
      'Reconstruction',
    )
    const output = done('done', summary)
    memoryMark('compact result')
    log(`compact model ready: ${summary.nCameras} cameras, ${summary.nPoints} points`, 'info', 'Reconstruction')
    return output
  } catch (err) {
    log(`Reconstruction error: ${err?.message ?? err}`, 'error', 'Reconstruction')
    return done('error')
  }
}

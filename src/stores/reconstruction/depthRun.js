// Dense Stage A — Build Depth Maps (reconstruction/dense.js): the depth run over the
// worker pool, its frames and cameras, and the filter over saved maps.
//
// Moved verbatim from the store: everything it shares comes in by name.

import { toRaw } from 'vue'
import { depthMapSteps } from '../../core/runSteps.js'
import { computeSourceOf } from '../../utils/image.js'
import { isImageEnabled } from '../../core/imageEnabled.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { rollingShutterWarps } from '../../core/sfm/rollingShutter.js'
import {
  qualityToMaxDim,
  fitDepthQuality,
  filterConfig,
  filterSettings,
  autoMinConsistent,
  resolveDepthMethod,
  logFilterCache,
  logFilterTotals,
  emptyFilterTotals,
} from '../../core/dense/mvs.js'
import { isFiducialCalibrated } from '../../core/sfm/fiducialModel.js'
import { packSparseForDense, sparseInputTransfer } from '../../core/dense/sparseInput.js'
import {
  computeDepthMaps as workerComputeDepthMaps,
  depthAck as workerDepthAck,
  depthBackend as workerDepthBackend,
  POOL_SIZE,
  cancelRun,
  releaseIdleWorkers,
  filterDepthMaps as workerFilterDepthMaps,
} from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'
import { serializeDepthMap } from '../../core/dense/depthMapCodec.js'
import { DEFAULT_BUDGET_BYTES, formatBytes, projectDensePeakBytes, workingPixels } from '../../core/dense/memBudget.js'
import { contiguousChunks, depthWorkerCount, mergeDepthSummaries } from '../../core/dense/depthSplit.js'
import { DENSE_TUNING } from '../../core/tuning.js'
import { pluralize } from '../../core/textFormat.js'
import { canContinue, journalKey, journalSettings, journalWriter, startJournal } from '../../core/runJournal.js'
import { depthMapsKey, depthRunShape, reusableDepthMaps, depthCameraKey } from '../../core/dense/depthReuse.js'

// The backend lines of a depth run split over the pool (workers/ops/dense.js), the same
// from every worker.
const SAME_ON_EVERY_WORKER = /^Depth maps: (backend = |GPU requested but no adapter)/

export function createDepthRun({
  activeRegion,
  beginStreamedDepthMaps,
  cancelled,
  depthMaps,
  depthMapsMeta,
  depthSummary,
  images,
  imagesStore,
  isPersisting,
  log,
  mainSparseCloud,
  persistDepthMaps,
  projects,
  reconStatus,
  sensors,
  summary,
  withRegion,
}) {
  // Dense Stage A — Build Depth Maps. Runs PatchMatch MVS in the worker over the
  // sparse cloud's registered cameras, stores the raw depth maps for fusion, and
  // pushes a display depth image into each image (viewer overlay). Needs a sparse
  // cloud whose points carry view-tracks; these are now persisted, so a restored
  // project works without rebuilding (legacy models saved before this still need
  // a Reconstruct re-run).
  // `resume`: the journal a dead tab's run left (core/runJournal.js, the Continue prompt
  // on open). Its saved maps are kept and only the rest are computed.
  // The frame lookups a depth run needs: each image's lens and composed self-cal bag
  // (core/sfm/displayFrame.js), and its film transform from the sparse run. Copied out
  // of the raw rows: the summary is reactive state, and its nested A / frame read
  // through it are Proxies the worker cannot receive.
  // The main sparse cloud's own calibration where it has one (displayFrame.js
  // calibrationSnapshot), else the project's run summary (a cloud saved before it).
  function depthFrames() {
    const calibration = mainSparseCloud.value?.calibration ? toRaw(mainSparseCloud.value.calibration) : null
    const frameModel = makeFrameModelResolver({ calibration, summary: toRaw(summary.value), sensors: sensors.value })
    const fidByUuid = new Map(
      ((calibration ?? toRaw(summary.value))?.fiducialTransforms ?? []).map((t) => [
        t.uuid,
        structuredClone({ A: t.A, transform: t.transform ?? null, frame: t.frame }),
      ]),
    )
    // A rolling-shutter photo is resampled onto its principal row's pose as it is read
    // (core/sfm/rollingShutter.js rollingShutterWarps).
    const cloud = mainSparseCloud.value
    const rsWarps = cloud ? rollingShutterWarps(cloud.cameras, cloud.points) : new Map()
    return { frameModel, fidByUuid, rsWarps }
  }
  // One image's camera as the run hands it to the worker (plain arrays and objects).
  function depthCamera(uuid, cam, im, { frameModel, fidByUuid, rsWarps }) {
    const { dist, selfCal } = frameModel(im)
    return {
      R: cam.R.map((row) => [...row]),
      t: [...cam.t],
      K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
      dist,
      selfCal,
      fid: fidByUuid.get(uuid) ?? null,
      // Only when the photo has one, so a global-shutter camera's key is unchanged.
      ...(rsWarps?.get(uuid) ? { rs: structuredClone(rsWarps.get(uuid)) } : {}),
      // Keep valid depth maps compares the mask too (core/dense/depthReuse.js): its content
      // hash, known from the image record before the mask loads; a mask from before the
      // hash existed keys as present until it is next set.
      maskKey: im.maskHash ?? (im.mask || im.hasMaskRecord ? 'mask' : null),
    }
  }
  // uuid → depthCameraKey of every image of the main model: what Keep valid depth maps
  // compares with the saved index (the depth dialog's effect line).
  function depthCameraKeys() {
    const cloud = mainSparseCloud.value
    if (!cloud) return {}
    const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
    const frames = depthFrames()
    const out = {}
    for (const [uuid, cam] of cloud.cameras) {
      const im = imgByUuid.get(uuid)
      if (im && isImageEnabled(im)) out[uuid] = depthCameraKey(depthCamera(uuid, cam, im, frames))
    }
    return out
  }

  async function computeDepthMaps(settings = {}, onProgress, { resume = null } = {}) {
    const cloud = mainSparseCloud.value
    if (!cloud || cloud.cameras.size < 2) {
      log('Dense: need a sparse cloud with ≥2 cameras first', 'warn', 'Dense')
      return
    }
    const hasTracks = cloud.points.viewTotal > 0
    if (!hasTracks) {
      log('Dense: sparse cloud has no view-tracks (rebuild the sparse model first)', 'warn', 'Dense')
      return
    }
    reconStatus.value = 'running'
    let writeFailure = null // the first depth map that could not be saved (see beginStreamedDepthMaps)
    try {
      // Rebuild every value as plain arrays/objects: cloud cameras + points are
      // reactive Pinia state, and Vue's Proxy wrappers can't be structured-cloned
      // to the worker ("object can not be cloned").
      const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
      const sensorById = new Map(sensors.value.map((s) => [s.id, s]))
      // WS2: composed radial distortion {k1,k2,k3} the sparse run self-calibrated per
      // sensor — or per image, for one with no sensor (folded into the keypoints
      // there). Passed to dense as a SECOND bag (`selfCal`) applied after the
      // calibrated `dist` — dense's camera K is the BA-refined K the fold used, so it
      // reproduces the same pinhole frame as the sparse cloud. The one lookup that
      // knows both row kinds is the frame-model resolver (core/sfm/displayFrame.js).
      const ownLens = (mainSparseCloud.value?.calibration?.groups ?? []).filter((g) => g.dist || g.selfCal)
      const selfCalRows = mainSparseCloud.value?.calibration ? [] : (summary.value?.selfCalDistortion ?? [])
      // F4: per-image scan→canonical transform from the sparse run. The dense
      // stage reproduces that exact frame (it must NOT re-fit) — the sparse run
      // defines it. Fail loudly if a film image is in the cloud but its transform
      // is missing (a stale/partial summary would silently mis-warp its raster).
      const frames = depthFrames()
      const { fidByUuid } = frames
      const inputImages = []
      let disabled = 0
      for (const [uuid, cam] of cloud.cameras) {
        const im = imgByUuid.get(uuid)
        if (!im) continue
        // Disabled (core/imageEnabled.js): no map, and no source for the others' maps.
        if (!isImageEnabled(im)) {
          disabled++
          continue
        }
        // Lens distortion for this image's sensor — the worker undistorts the raster
        // so depth maps / fusion / DEM / ortho all stay pinhole (matches sparse).
        const s = im.sensorId ? sensorById.get(im.sensorId) : null
        const fid = fidByUuid.get(uuid) ?? null
        if (s?.kind === 'film' && !fid) {
          // Three distinct causes — point the user at the actual fix, not always "re-run".
          const cal = s.fiducialCalibration
          const nMarks = isFiducialCalibrated(cal) ? cal.marks.length : 0
          const nObs = im.fiducialDetections?.length || 0
          let why
          if (nMarks < 3) {
            why =
              `its detected fiducials are not calibrated (${nMarks} metric marks, need ≥3) — ` +
              `run Calibrate Fiducials, then re-run the sparse reconstruction`
          } else if (nObs < 3) {
            why =
              `this image has ${pluralize(nObs, 'accepted fiducial detection')} (need ≥3) — ` +
              `run Detect Fiducials or review its spots, then re-run the sparse reconstruction`
          } else {
            why =
              `the last sparse run produced no interior-orientation transform for it — ` +
              `re-run the sparse reconstruction before building the dense cloud`
          }
          log(`Dense: ${im.name} skipped — ${why}.`, 'error', 'Dense')
          continue
        }
        // A TIFF's lossless compute PNG may still be encoding right after ingest;
        // wait for it (rejects if its transcode failed) so dense reads the PNG,
        // never the lossy display JPEG — see the computeUrl invariant.
        await imagesStore.whenComputeReady(im)
        inputImages.push({
          uuid,
          name: im.name,
          url: computeSourceOf(im),
          // Per-image mask (if any) so masked regions are excluded from the dense cloud.
          mask: im.mask?.blob ?? null,
          // Pose, K, the lens (the sensor's, or the run's self-calibrated fisheye), the
          // composed self-cal bag applied after it (null when self-cal was off for it) and
          // the film scan→canonical warp.
          ...depthCamera(uuid, cam, im, frames),
          // The working grid's basis (the canonical frame for a film scan), so the
          // worker's memory pre-flight counts real pixels, not maxDim².
          width: fid?.frame?.width ?? im.meta?.width ?? 0,
          height: fid?.frame?.height ?? im.meta?.height ?? 0,
        })
      }
      if (disabled) log(`Dense: ${pluralize(disabled, 'disabled image')} left out of the depth maps`, 'info', 'Dense')
      if (ownLens.length) {
        const terms = (d) =>
          ['k1', 'k2', 'k3', 'k4', 'p1', 'p2']
            .filter((k) => d?.[k])
            .map((k) => `${k} ${d[k].toFixed(5)}`)
            .join(', ')
        const parts = ownLens.map(
          (g) =>
            `${
              g.sensorId != null
                ? (sensorById.get(g.sensorId)?.label ?? String(g.sensorId).slice(0, 6))
                : (imgByUuid.get(g.imageUuid)?.name ?? 'image')
            }${g.dist?.fisheye ? ' fisheye' : ''} ${terms(g.dist) || 'pinhole'}` +
            (g.selfCal ? ` (+ correction ${terms(g.selfCal)})` : ''),
        )
        log(`Dense: undistorting with the sparse model's own lens — ${parts.join('; ')}`, 'info', 'Dense')
      }
      if (selfCalRows.length) {
        const parts = selfCalRows.map(
          (d) =>
            `${
              d.sensorId != null
                ? (sensorById.get(d.sensorId)?.label ?? d.sensorId.slice(0, 6))
                : (imgByUuid.get(d.imageUuid)?.name ?? 'image')
            }${d.fisheye ? ' fisheye' : ''} k1 ${(d.k1 || 0).toFixed(5)}` +
            `${d.k2 ? `, k2 ${d.k2.toFixed(5)}` : ''}${d.k3 ? `, k3 ${d.k3.toFixed(5)}` : ''}` +
            `${d.k4 ? `, k4 ${d.k4.toFixed(5)}` : ''}`,
        )
        log(`Dense: applying self-calibrated distortion from the sparse run — ${parts.join('; ')}`, 'info', 'Dense')
      }
      // Packed typed arrays, transferred (core/dense/sparseInput.js) — not an object
      // plus a views array per point, structured-cloned.
      const sparse = packSparseForDense(cloud.points)

      // The image's depth preview (display PNG), then drop it from the map.
      let previews = 0
      const takePreview = (m) => {
        const im = imgByUuid.get(m.uuid)
        if (im && m.displayBlob) {
          imagesStore.updateDepth(im.id, m.displayBlob, { quiet: true, persistSync: false })
          previews++
        }
        delete m.displayBlob
      }
      // Streamed (TODO ▸ SC-4) whenever the maps can be saved: each finished map is
      // written and released at once, and the cross-view filter runs as its own pass
      // over the saved files. Holding every map to the end (the in-memory path, kept
      // for a project that cannot save) made the preflight refuse ~100+ images.
      // A map that cannot be saved (storage full) stops the run: the rest could not
      // be kept either, and the worker would spend minutes computing them.
      // The run journal's key: the model, the images and the settings the dialog asked
      // for. A stopped run continues only on the same three (core/runJournal.js).
      const requested = journalSettings(structuredClone(toRaw(settings)))
      const key = journalKey({
        sparse: [cloud.id, cloud.createdAt ?? null],
        images: inputImages.map((im) => im.uuid),
        settings: requested,
      })
      let journal = null
      if (resume && isPersisting()) {
        const verdict = canContinue(resume, key)
        if (verdict.ok) journal = structuredClone(resume)
        else log(`Dense: the stopped depth-map run cannot continue (${verdict.why}); starting again`, 'warn', 'Dense')
      }
      // Resolve a quality preset → working maxDim from the largest native image
      // dimension (Step 3), unless the user set an explicit maxDim in Advanced. A
      // quality whose projected peak exceeds the memory budget steps down (High →
      // Medium → Low) with a warning, rather than the worker refusing to start.
      const resolved = { ...settings }
      // A blank "Consistent views" follows the project's scene type (geomFilter.js
      // autoMinConsistent), resolved where the filter reads it.
      resolved.sceneType = projects.currentSceneType ?? null
      if (resolved.geomConsistency !== false && (settings.minConsistent == null || settings.minConsistent === '')) {
        log(
          `Dense: consistent views auto → ${autoMinConsistent(resolved.sceneType)} ` +
            `(${resolved.sceneType === 'object' ? 'object capture' : 'aerial / mapping'} project)`,
          'info',
          'Dense',
        )
      }
      // The method (Full: ACMH + planar prior + geometric pass; Fast: best-K, one pass). An
      // explicit low-level choice (bench, console) still wins.
      const onGpu = !!settings.useGpu && (await workerDepthBackend(0)).gpu
      const method = resolveDepthMethod(settings.method, onGpu)
      resolved.viewSelection = settings.viewSelection ?? (method === 'full' ? 'acmh' : 'bestk')
      resolved.planarPrior = settings.planarPrior ?? method === 'full'
      resolved.geomPass = settings.geomPass ?? method === 'full'
      log(
        `Dense: method ${method === 'full' ? 'Full (ACMH, planar prior, geometric pass)' : 'Fast (best-K, one pass)'}` +
          `${(settings.method ?? 'auto') === 'auto' ? ` — auto, ${onGpu ? 'on the GPU' : 'without a GPU'}` : ''}`,
        'info',
        'Dense',
      )
      if (resolved.quality && !(resolved.maxDim > 0)) {
        const nativeLong = images.value.reduce((m, im) => Math.max(m, im.meta?.width || 0, im.meta?.height || 0), 0)
        resolved.maxDim = qualityToMaxDim(resolved.quality, nativeLong)
        const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
        const plan = (quality, cap) =>
          fitDepthQuality({
            quality,
            budget: cap,
            sizes: inputImages.map((im) => ({ width: im.width, height: im.height })),
            backend: settings.useGpu ? 'gpu' : 'wasm',
            nSources: Math.min(16, settings.maxSources ?? 6),
            streamMaps: isPersisting(),
            geomConsistency: settings.geomConsistency !== false,
            full: resolved.planarPrior || resolved.geomPass,
          })
        const fit = plan(resolved.quality, budget)
        if (fit?.steps > 0) {
          log(
            `Dense: quality '${resolved.quality}' would need ≈ ${formatBytes(plan(resolved.quality, Infinity).proj.total)} ` +
              `against the ${formatBytes(budget)} budget — using '${fit.quality}' (≤${fit.maxDim}px, ≈ ${formatBytes(fit.proj.total)}). ` +
              'Raise the memory budget (Settings ▸ Compute) to keep the higher quality.',
            'warn',
            'Dense',
          )
          resolved.quality = fit.quality
          resolved.maxDim = fit.maxDim
        }
        log(
          `Dense: quality '${resolved.quality}' → working ≤${resolved.maxDim}px ` +
            `(¼-scale presets of ${nativeLong}px native)`,
          'info',
          'Dense',
        )
      }
      settings = resolved
      // Keep valid depth maps (core/dense/depthReuse.js): the saved maps whose camera and
      // settings are unchanged are kept, and only the others are computed. A continued
      // run has its own list (the journal) and needs no second one.
      const nativeLongNow = images.value.reduce((m, im) => Math.max(m, im.meta?.width || 0, im.meta?.height || 0), 0)
      const mapsKey = depthMapsKey(
        depthRunShape(requested, {
          onGpu,
          nativeLong: nativeLongNow,
          sceneType: resolved.sceneType,
          region: activeRegion(),
          maxDim: resolved.maxDim ?? null,
        }),
      )
      const cameraKeys = Object.fromEntries(inputImages.map((im) => [im.uuid, depthCameraKey(im)]))
      let kept = []
      let savedIndex = null
      if (!journal && settings.keepMaps !== false && isPersisting()) {
        savedIndex = await opfs.loadDepthIndex(projects.currentProjectId).catch(() => null)
        kept = reusableDepthMaps({ index: savedIndex, cloud, key: mapsKey, cameraKeys })
        if (kept.length === inputImages.length) {
          log(
            `Dense: all ${pluralize(kept.length, 'depth map')} kept — their cameras and settings are unchanged, so there is nothing to compute`,
            'success',
            'Dense',
          )
          reconStatus.value = 'done'
          return
        }
        if (kept.length)
          log(
            `Dense: ${pluralize(kept.length, 'depth map')} of ${inputImages.length} kept (cameras and settings unchanged); ` +
              `computing ${pluralize(inputImages.length - kept.length, 'map')}`,
            'info',
            'Dense',
          )
      }
      // A continued run reads them back from its journal (`kept`), for pass 2.
      const keptUuids = new Set(journal?.kept ?? kept.map((m) => m.uuid))
      const run = await beginStreamedDepthMaps({
        onWriteFailure: (err) => {
          writeFailure = err
          cancelRun(err.message)
        },
        resume: journal ? (journal.phase === 'pass1' ? journal.done : journal.metas) : kept.length ? kept : null,
      })
      // The progress dialog's step list (core/runSteps.js), now the method is known. An
      // in-memory run (no project storage) filters inside its one pass.
      const withPhase = (cb, phase) => cb && ((d, t, lbl, f) => cb(d, t, lbl, f, phase))
      {
        const steps = depthMapSteps({
          geomPass: !!run && settings.geomPass && inputImages.length > 1,
          filter: !!run && settings.geomConsistency !== false,
        })
        const from = journal?.phase
        const phase =
          from === 'pass2' || from === 'promote'
            ? 'pass2'
            : from?.startsWith('filter') || from === 'promoteFilter'
              ? 'filter'
              : 'pass1'
        onProgress?.(0, inputImages.length, 'Starting the depth maps…', 0, phase, steps)
      }
      // The saved index lists only the kept maps from here on: the run overwrites the
      // planes of the others, and a run that stops must not leave an index naming them.
      if (run && kept.length && savedIndex && kept.length < savedIndex.maps.length)
        await run.saveOrMove(() => opfs.commitDepthIndex(run.projectId, { ...savedIndex, maps: kept }))
      // A streamed run keeps a journal while it runs, so a tab that dies (closed, crashed,
      // killed for memory) leaves enough to continue: the maps saved so far and the
      // phase. Phases: pass1 → pass2 (Full method) → promote → filter → promoteFilter.
      let writer = null
      if (run) {
        if (!journal) {
          journal = startJournal({
            stage: 'depth',
            key,
            settings: requested,
            total: inputImages.length,
            phase: 'pass1',
          })
          // Kept maps are saved maps: a run that stops after this continues with them.
          journal.done = kept.map((m) => ({ ...m }))
          journal.kept = kept.map((m) => m.uuid)
        }
        writer = journalWriter((j) => opfs.saveRunJournal(run.projectId, j), {
          intervalMs: settings._journalMs ?? DENSE_TUNING.journalIntervalMs,
          holdAt: settings._holdAt,
        })
        await writer.flush(journal)
      }
      const phase = journal?.phase ?? 'pass1'
      const order = ['pass1', 'pass2', 'promote', 'filter', 'promoteFilter']
      const reached = (p) => order.indexOf(phase) > order.indexOf(p)
      const setPhase = async (next) => {
        journal.phase = next
        journal.metas = run.metas.map((m) => ({ ...m }))
        journal.done = []
        await writer.flush(journal)
      }
      // The maps a run with these refs leaves out: those the journal says are saved.
      const remaining = (saved) =>
        saved.size ? inputImages.map((_, i) => i).filter((i) => !saved.has(inputImages[i].uuid)) : null
      // A continued run's progress counts the maps already saved.
      const offset = (before) =>
        before
          ? (d, t, lbl, f) => onProgress?.(d + before, t + before, lbl, f == null ? f : (before + f * t) / (before + t))
          : onProgress
      if (resume && journal) {
        const n = journal.phase === 'pass1' ? journal.done.length : inputImages.length
        log(
          `Dense: continuing the stopped run — ${pluralize(n, 'depth map')} of ${inputImages.length} already saved` +
            `${journal.phase === 'pass1' ? '' : ` (from step ${journal.phase})`}`,
          'info',
          'Dense',
        )
      }
      let pass1 = { maps: [], summary: null, loopShare: journal?.loopShare ?? 0 }
      const saved1 = new Set(run && phase === 'pass1' ? run.metas.map((m) => m.uuid) : [])
      const refs1 = remaining(saved1)
      if (!reached('pass1') && (!refs1 || refs1.length)) {
        pass1 = await runDepthMaps(
          inputImages,
          sparse,
          withRegion({ ...settings, streamMaps: !!run }),
          withPhase(offset(saved1.size), 'pass1'),
          run
            ? (m, ack) => {
                takePreview(m)
                run
                  .add(m, (meta) => {
                    journal.done.push(meta)
                    writer.touch(journal)
                  })
                  .finally(ack)
              }
            : null,
          refs1 ? { refs: refs1 } : {},
        )
      }
      const { maps, summary: aSummary, loopShare } = pass1
      let stageSummary = aSummary ?? journal?.summary ?? null
      if (run) {
        await run.settled()
        if (!reached('pass1')) {
          journal.summary = stageSummary
          journal.loopShare = loopShare
          await setPhase(settings.geomPass && run.metas.length > 1 ? 'pass2' : 'filter')
        }
        // Full method, last stage (ACMP): the geometric-consistency pass over the saved first
        // pass. Its maps are written staged and promoted once all exist (utils/opfs/depth.js).
        if (settings.geomPass && run.metas.length > 1 && !reached('pass2')) {
          const entries = await opfs.loadDepthFiles(run.projectId, run.metas)
          const at = new Map(run.metas.map((m, k) => [m.uuid, k]))
          // A continued pass 2 keeps the staged maps its journal lists.
          for (const meta of phase === 'pass2' ? journal.done : []) {
            if (at.has(meta.uuid)) run.metas[at.get(meta.uuid)] = { ...meta }
          }
          // Kept maps are final: pass 2 reads them as neighbours and leaves them as they are.
          const saved2 = new Set([...keptUuids, ...(phase === 'pass2' ? journal.done.map((m) => m.uuid) : [])])
          const refs2 = remaining(saved2)
          const staged = []
          let stageFailure = null
          if (!refs2 || refs2.length) {
            await runDepthMaps(
              inputImages,
              sparse,
              withRegion({ ...settings, streamMaps: true }),
              withPhase(offset(saved2.size), 'pass2'),
              (m, ack) => {
                takePreview(m)
                const { meta, buffers } = serializeDepthMap(m)
                if (at.has(m.uuid)) run.metas[at.get(m.uuid)] = meta
                staged.push(
                  run
                    .saveOrMove(() => opfs.saveStagedDepthPlane(run.projectId, m.uuid, buffers))
                    .then(() => {
                      journal.done.push(meta)
                      writer.touch(journal)
                    })
                    .catch((err) => {
                      stageFailure ??= err
                    })
                    .finally(ack),
                )
              },
              { geomFrom: entries, ...(refs2 ? { refs: refs2 } : {}) },
            )
          }
          await Promise.all(staged)
          if (stageFailure) throw stageFailure
          await setPhase('promote')
        }
        if (settings.geomPass && run.metas.length > 1 && !reached('promote')) {
          // Idempotent (a promoted plane has no staged file left), so it can be retried.
          await run.saveOrMove(() =>
            opfs.promoteStagedDepthPlanes(
              run.projectId,
              run.metas.map((m) => m.uuid),
            ),
          )
          await setPhase('filter')
        }
        // A split run's maps arrive in finishing order. Keep the input order, so the
        // filter and fusion (which keeps the first point per cell) see the maps as one
        // worker would have written them, and the result does not depend on the split.
        const at = new Map(inputImages.map((im, k) => [im.uuid, k]))
        run.metas.sort((a, b) => at.get(a.uuid) - at.get(b.uuid))
        if (settings.geomConsistency !== false && run.metas.length) {
          if (!reached('filter')) {
            // The depth workers hold their last rasters until a collection that may not
            // come: start the filter on a fresh pool, so they cannot crowd the tab's buffers.
            releaseIdleWorkers()
            // Kept maps were filtered when they were made: only the others are judged,
            // with every map a neighbour.
            const judge = keptUuids.size
              ? new Set(run.metas.filter((m) => !keptUuids.has(m.uuid)).map((m) => m.uuid))
              : null
            stageSummary = await filterSavedDepthMaps(
              run,
              settings,
              stageSummary,
              loopShare,
              withPhase(onProgress, 'filter'),
              judge,
            )
            journal.summary = stageSummary
            await setPhase('promoteFilter')
          }
          // The filtered planes were staged (a filter that stops leaves the maps intact).
          await run.saveOrMove(() =>
            opfs.promoteStagedDepthPlanes(
              run.projectId,
              run.metas.map((m) => m.uuid),
              'f',
            ),
          )
        }
        await run.commit(settings, { mapsKey, cameraKeys })
        await writer.settled()
        await opfs.deleteRunJournal(run.projectId, 'depth').catch(() => {})
      } else {
        depthMaps.value = new Map(maps.map((m) => [m.uuid, m]))
        depthMapsMeta.value = [] // the fresh maps supersede any restored index
        for (const m of maps) takePreview(m)
      }
      depthSummary.value = stageSummary
      if (previews && isPersisting()) imagesStore.save()
      log(`Dense: ${pluralize(run ? run.metas.length : maps.length, 'depth map')} computed`, 'success', 'Dense')
      reconStatus.value = 'done'
      // In memory only: save before densify can transfer the buffers away (a no-op
      // when the project cannot save, which is why this path exists).
      if (!run) await persistDepthMaps(maps, settings)
    } catch (err) {
      if (!writeFailure && cancelled(err, 'Depth maps', 'Dense')) return
      log(`Depth-map error: ${(writeFailure ?? err)?.message ?? err}`, 'error', 'Dense')
      reconStatus.value = 'error'
    }
  }

  // Stage A on the pool. On the CPU each map is one single-threaded WASM PatchMatch, so a
  // streamed run splits its images over the workers (core/dense/depthSplit.js), each
  // with its share of the memory budget. A GPU run stays on one worker (the device is
  // the bottleneck), and so does an in-memory run, whose filter needs every map at once.
  // `onMap(map, ack)` takes each streamed map and calls `ack` once it is saved; null
  // for an in-memory run. A worker keeps at most DENSE_TUNING.depthMapsUnsaved maps
  // unsaved and waits for the acks beyond that: a disk slower than the maps (the last
  // maps of a film block at High, raster cache warm) otherwise queued 0.6 GB per map
  // on the page until the tab's buffer pool ran out.
  // `extra.refs` (indices into `images`) computes only those maps, every image still a
  // candidate source view: how a run continues after a tab died (core/runJournal.js).
  async function runDepthMaps(images, sparse, settings, onProgress, onMap, extraIn = {}) {
    const { refs: only = null, ...extra } = extraIn
    const n = only ? only.length : images.length
    const onLog = (m, l, c) => log(m, l, c)
    const runToken = crypto.randomUUID()
    const onEventFor =
      (w) =>
      (ev, [m]) => {
        if (ev === 'map' && onMap) onMap(m, () => workerDepthAck(`${runToken}:${w}`, w).catch(() => {}))
      }
    const withAck = (s, w) => (onMap ? { ...s, ackToken: `${runToken}:${w}` } : s)
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    let workers = 1
    // On the CPU with threads (shared memory: a cross-origin isolated page), one worker runs
    // every map on all cores (workers/ops/dense.js cpuThreads): several workers would each
    // start a pool that size. Without threads the maps split over the pool.
    const cpuThreads =
      DENSE_TUNING.cpuDepthThreads &&
      globalThis.crossOriginIsolated === true &&
      typeof SharedArrayBuffer !== 'undefined'
    if (onMap && n > 1 && !cpuThreads && !(settings.useGpu && (await workerDepthBackend(0)).gpu)) {
      const nSources = Math.min(16, settings.maxSources ?? 6)
      // One worker's peak: its raster cache plus the run's shared inputs (counted whole).
      const perWorkerBytes = projectDensePeakBytes({
        nImages: images.length,
        maxDim: settings.maxDim,
        nSources,
        backend: 'wasm',
        pixels: images.map((im) => workingPixels(im.width, im.height, settings.maxDim)),
        retainedMaps: 1,
        filterMaps: 0,
      }).total
      workers = depthWorkerCount({ n, poolSize: POOL_SIZE, budget, perWorkerBytes })
    }
    if (workers === 1) {
      return workerComputeDepthMaps(
        { images, sparse, ...(only ? { refs: only } : {}), settings: withAck(settings, 0), ...extra },
        {
          worker: 0,
          // The first of the Full method's passes keeps the sparse inputs: the geometric
          // pass (extra.geomFrom) sends them again, and that last run may transfer them.
          transfer: settings.geomPass && !extra.geomFrom ? [] : sparseInputTransfer(sparse),
          onLog,
          onEvent: onEventFor(0),
          onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f),
        },
      )
    }
    log(
      `Depth maps: on the CPU, split over ${workers} workers (${formatBytes(budget / workers)} of the ` +
        `memory budget each)`,
      'info',
      'Dense',
    )
    const chunks = contiguousChunks(n, workers).map((c) => (only ? c.map((k) => only[k]) : c))
    // Every worker picks its backend the same way: the first says which, not every one.
    const onLogOf = (w) => (w === 0 ? onLog : (m, l, c) => SAME_ON_EVERY_WORKER.test(m) || onLog(m, l, c))
    const counts = new Array(workers).fill(0),
      fractions = new Array(workers).fill(0)
    const t0 = performance.now()
    // Each worker gets its own copy of the sparse inputs (no transfer: there are several).
    const parts = await Promise.all(
      chunks.map((refs, w) =>
        workerComputeDepthMaps(
          {
            images,
            sparse,
            refs,
            split: true,
            settings: withAck({ ...settings, memBudgetBytes: budget / workers }, w),
            ...extra,
          },
          {
            worker: w,
            onLog: onLogOf(w),
            onEvent: onEventFor(w),
            onProgress: (d, t, lbl, f) => {
              counts[w] = d
              fractions[w] = f
              onProgress?.(
                counts.reduce((x, y) => x + y, 0),
                n,
                lbl,
                fractions.reduce((x, y) => x + y, 0) / workers,
              )
            },
          },
        ),
      ),
    ).catch((err) => {
      cancelRun(String(err?.message ?? err))
      throw err
    })
    return {
      maps: [],
      summary: mergeDepthSummaries(parts, { totalMs: performance.now() - t0, nImages: n }),
      loopShare: parts.reduce((x, p) => x + p.loopShare, 0) / workers,
    }
  }

  // The cross-view filter over a streamed run's saved maps: the worker reads them on
  // demand and returns each filtered depth plane, which is written back over the
  // unfiltered one (the worker has judged every map before the first comes back).
  // Folds the filter's numbers into the Stage A summary, as the in-memory pass does.
  // `judge` (a Set of uuids, or null for every map): the maps filtered; all are neighbours.
  async function filterSavedDepthMaps(run, settings, stageSummary, from, onProgress, judge = null) {
    const metaByUuid = new Map(run.metas.map((m) => [m.uuid, m]))
    const nameByUuid = new Map(images.value.map((im) => [im.uuid, im.name]))
    const entries = (await opfs.loadDepthFiles(run.projectId, run.metas)).map((e) => ({
      ...e,
      name: nameByUuid.get(e.uuid),
    }))
    // Each rewrite is handled as it is queued (see beginStreamedDepthMaps): the first
    // that fails (storage full) stops the workers and fails the stage with its message.
    const writes = []
    let writeFailure = null
    const onEvent = (ev, [f]) => {
      if (ev !== 'filtered') return
      const meta = metaByUuid.get(f.uuid)
      if (meta) Object.assign(meta, f.coverage)
      writes.push(
        run
          .saveOrMove(() => opfs.saveStagedDepthPlane(run.projectId, f.uuid, { depth: f.depth }, 'f'))
          .catch((err) => {
            if (writeFailure) return
            writeFailure = err
            cancelRun(err.message)
          }),
      )
    }
    // References are judged independently against the unfiltered planes, so the maps
    // split over the pool in contiguous chunks (neighbouring captures share candidate
    // views, which keeps each worker's cache warm) give the single run's verdicts.
    const n = entries.length
    const own = judge ? entries.map((_, i) => i).filter((i) => judge.has(entries[i].uuid)) : null
    // Memory, not only the map count, bounds the split: each reference is judged with
    // all its candidate views resident at once (core/dense/geomFilter.js), up to
    // DENSE_TUNING.filterMaxViews depth planes. 3 workers at High on 58 film maps (27 MP, 108 MB a plane)
    // filled the tab's buffer pool in 35 s.
    const planeBytes = run.metas.reduce((m, x) => Math.max(m, 4 * x.width * x.height), 0)
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    const views = DENSE_TUNING.filterMaxViews > 0 ? Math.min(n - 1, DENSE_TUNING.filterMaxViews) : n - 1
    const perWorker = Math.max(1, views * planeBytes * 1.25)
    const workers = Math.max(
      1,
      Math.min(
        POOL_SIZE,
        Math.floor((own ? own.length : n) / (DENSE_TUNING.filterMapsPerWorker ?? 16)),
        Math.floor(budget / perWorker),
      ),
    )
    log(
      `Depth filter: ${pluralize(workers, 'worker')} (up to ${formatBytes(perWorker)} of candidate planes each, ` +
        `budget ${formatBytes(budget)})`,
      'info',
      'Dense',
    )
    let stats, ms
    // Judging a subset goes through the split path (judge, then apply), on one worker too.
    if (workers === 1 && !own) {
      ;({ stats, ms } = await workerFilterDepthMaps(
        { maps: entries, settings, from },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), onEvent },
      ))
    } else {
      const t0 = performance.now()
      const fractions = new Array(workers).fill(from),
        counts = new Array(workers).fill(0)
      const chunks = own
        ? contiguousChunks(own.length, workers).map((c) => c.map((k) => own[k]))
        : contiguousChunks(n, workers)
      const parts = await Promise.all(
        chunks.map((refs, w) =>
          workerFilterDepthMaps(
            { maps: entries, settings, from, refs, workers },
            {
              worker: w,
              onLog: (m, l, c) => log(m, l, c),
              onEvent,
              onProgress: (d, t, lbl, f) => {
                fractions[w] = f
                counts[w] = d
                onProgress?.(
                  counts.reduce((x, y) => x + y, 0),
                  own ? own.length : n,
                  lbl,
                  fractions.reduce((x, y) => x + y, 0) / workers,
                )
              },
            },
          ),
        ),
      )
      stats = new Array(n)
      const totals = emptyFilterTotals()
      let loads = 0,
        hits = 0,
        nCand = 0
      parts.forEach((p, w) => {
        for (const i of chunks[w]) stats[i] = p.stats[i]
        for (const k of Object.keys(totals)) totals[k] += p.totals[k]
        loads += p.loads
        hits += p.hits
        nCand += p.nCand
      })
      // Every map is judged now; only now may any of them be rewritten.
      await Promise.all(
        chunks.map((refs, w) =>
          workerFilterDepthMaps(
            { maps: entries, apply: { refs, masks: parts[w].masks, stats: refs.map((i) => parts[w].stats[i]) } },
            { worker: w, onEvent, transfer: parts[w].masks.map((m) => m.buffer) },
          ),
        ),
      )
      ms = performance.now() - t0
      const cfg = filterConfig(filterSettings(settings))
      if (n >= 2 && cfg.minConsistent > 0)
        logFilterCache(log, { nMaps: n, nCand, loads, hits, cacheBytes: parts[0].cacheBytes, cull: cfg.cull, workers })
      logFilterTotals(log, totals, n, cfg)
      const marginal = entries
        .map((e, i) => ({ e, s: stats[i] }))
        .filter(({ s }) => s && s.considered > 0 && s.keptPct < 1)
      if (marginal.length) {
        const names = marginal
          .slice(0, 12)
          .map(({ e, s }) => `${e.name || e.uuid} ${s.keptPct.toFixed(1)}%`)
          .join('; ')
        log(
          `Depth filter: ${pluralize(marginal.length, 'marginal map')} kept <1% after cross-view filtering — ` +
            `${names}${marginal.length > 12 ? `; +${marginal.length - 12} more` : ''}. ` +
            'They remain cached for diagnostics/orthophoto use but will contribute little to fusion.',
          'warn',
          'Dense',
        )
      }
      log(
        `Depth filter: cross-view consistency in ${(ms / 1000).toFixed(1)}s on ${workers} workers ` +
          `(streamed from saved maps; judging ${(Math.max(...parts.map((p) => p.judgeMs)) / 1000).toFixed(1)}s in the slowest)`,
        'info',
        'Dense',
      )
      onProgress?.(n, n, 'Depth maps complete', 1)
    }
    await Promise.all(writes)
    if (writeFailure) throw writeFailure
    const kept = stats.filter(Boolean).map((s) => s.keptPct)
    const sorted = [...kept].sort((a, b) => a - b)
    return (
      stageSummary && {
        ...stageSummary,
        geomFilterMs: ms,
        geomFilterMedianKeptPct: sorted.length ? sorted[Math.round(0.5 * (sorted.length - 1))] : null,
        geomFilterMinKeptPct: sorted.length ? sorted[0] : null,
        geomFilterMarginalMaps: kept.filter((v) => v < 1).length,
      }
    )
  }

  return { computeDepthMaps, depthCameraKeys, filterSavedDepthMaps }
}

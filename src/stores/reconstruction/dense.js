import { toRaw } from 'vue'
import { computeSourceOf } from '../../utils/image.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
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
  mergeFusionCounters,
  logFusionStream,
  finishFusion,
} from '../../core/dense/mvs.js'
import { isFiducialCalibrated } from '../../core/sfm/fiducialModel.js'
import { packSparseForDense, sparseInputTransfer } from '../../core/dense/sparseInput.js'
import {
  computeDepthMaps as workerComputeDepthMaps,
  depthAck as workerDepthAck,
  fusePlanAnswer as workerFusePlanAnswer,
  depthBackend as workerDepthBackend,
  POOL_SIZE,
  terminateAll,
  releaseIdleWorkers,
  filterDepthMaps as workerFilterDepthMaps,
  densify as workerDensify,
  meshify as workerMeshify,
  meshPrepare as workerMeshPrepare,
  meshTile as workerMeshTile,
  meshFinish as workerMeshFinish,
} from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'
import { serializeDepthMap } from '../../core/dense/depthMapCodec.js'
import { DEFAULT_BUDGET_BYTES, formatBytes, projectDensePeakBytes, workingPixels } from '../../core/dense/memBudget.js'
import { contiguousChunks, depthWorkerCount, mergeDepthSummaries } from '../../core/dense/depthSplit.js'
import { DENSE_TUNING } from '../../core/tuning.js'
import { FUSION_PLAN_SHARE } from '../../core/dense/fusionPlan.js'
import { bufferFailureText } from '../../core/bufferLimit.js'
import { pluralize } from '../../core/textFormat.js'
import { isSharedArray, postableCopy, shareableArray } from '../../core/bigArray.js'
import { poissonHeapBytes } from '../../core/products/mesh.js'

// The backend lines of a depth run split over the pool (workers/ops/dense.js), the same
// from every worker.
const SAME_ON_EVERY_WORKER = /^Depth maps: (backend = |GPU requested but no adapter)/

// The dense pipeline, split out of useReconstructionStore: Stage A depth maps
// (PatchMatch MVS in the workers, persisted per image), the saved-map filter,
// fusion into the dense cloud (streamed over the worker pool when the maps are on
// disk), and Poisson meshing. Each run checks it is still current — same project,
// same main sparse model — before it commits anything.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createDense({
  beginStreamedDepthMaps,
  clipToRegion,
  clouds,
  denseSummary,
  depthMapInput,
  depthMaps,
  depthMapsMeta,
  depthSummary,
  images,
  imagesStore,
  isPersisting,
  loadDepthIndexIntoMeta,
  log,
  mainSparseCloud,
  meshSource,
  meshSources,
  save,
  persistDepthMaps,
  projects,
  reconStatus,
  sensors,
  summary,
  upsertDenseCloud,
  upsertMeshCloud,
  withRegion,
}) {
  // Dense Stage A — Build Depth Maps. Runs PatchMatch MVS in the worker over the
  // sparse cloud's registered cameras, stores the raw depth maps for fusion, and
  // pushes a display depth image into each image (viewer overlay). Needs a sparse
  // cloud whose points carry view-tracks; these are now persisted, so a restored
  // project works without rebuilding (legacy models saved before this still need
  // a Reconstruct re-run).
  async function computeDepthMaps(settings = {}, onProgress) {
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
      const selfCalRows = summary.value?.selfCalDistortion ?? []
      const frameModel = makeFrameModelResolver({ summary: toRaw(summary.value), sensors: sensors.value })
      // F4: per-image scan→canonical transform from the sparse run. The dense
      // stage reproduces that exact frame (it must NOT re-fit) — the sparse run
      // defines it. Fail loudly if a film image is in the cloud but its transform
      // is missing (a stale/partial summary would silently mis-warp its raster).
      // Copied out of the raw rows: the summary is reactive state, and its nested
      // A / frame read through it are Proxies the worker cannot receive.
      const fidByUuid = new Map(
        (toRaw(summary.value)?.fiducialTransforms ?? []).map((t) => [
          t.uuid,
          structuredClone({ A: t.A, transform: t.transform ?? null, frame: t.frame }),
        ]),
      )
      const inputImages = []
      for (const [uuid, cam] of cloud.cameras) {
        const im = imgByUuid.get(uuid)
        if (!im) continue
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
              `re-run the sparse reconstruction before densifying`
          }
          log(`Dense: ${im.name} skipped — ${why}.`, 'error', 'Dense')
          continue
        }
        // A TIFF's lossless compute PNG may still be encoding right after ingest;
        // wait for it (rejects if its transcode failed) so dense reads the PNG,
        // never the lossy display JPEG — see the computeUrl invariant.
        await imagesStore.whenComputeReady(im)
        // The lens (the sensor's, or the run's self-calibrated fisheye) and the composed
        // self-cal bag applied after it — null when self-cal was off for it.
        const { dist, selfCal } = frameModel(im)
        inputImages.push({
          uuid,
          name: im.name,
          url: computeSourceOf(im),
          // Per-image mask (if any) so masked regions are excluded from the dense cloud.
          mask: im.mask?.blob ?? null,
          R: cam.R.map((row) => [...row]),
          t: [...cam.t],
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
          dist,
          selfCal,
          // Film scan→canonical warp (plain data; the frame is already a plain object).
          fid,
          // The working grid's basis (the canonical frame for a film scan), so the
          // worker's memory pre-flight counts real pixels, not maxDim².
          width: fid?.frame?.width ?? im.meta?.width ?? 0,
          height: fid?.frame?.height ?? im.meta?.height ?? 0,
        })
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
      const run = await beginStreamedDepthMaps({
        onWriteFailure: (err) => {
          writeFailure = err
          terminateAll(err.message)
        },
      })
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
            streamMaps: !!run,
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
      const {
        maps,
        summary: aSummary,
        loopShare,
      } = await runDepthMaps(
        inputImages,
        sparse,
        withRegion({ ...settings, streamMaps: !!run }),
        onProgress,
        run
          ? (m, ack) => {
              takePreview(m)
              run.add(m).finally(ack)
            }
          : null,
      )
      let stageSummary = aSummary ?? null
      if (run) {
        await run.settled()
        // Full method, last stage (ACMP): the geometric-consistency pass over the saved first
        // pass. Its maps are written staged and promoted once all exist (utils/opfs/depth.js).
        if (settings.geomPass && run.metas.length > 1) {
          const entries = await opfs.loadDepthFiles(run.projectId, run.metas)
          const at = new Map(run.metas.map((m, k) => [m.uuid, k]))
          const staged = []
          let stageFailure = null
          await runDepthMaps(
            inputImages,
            sparse,
            withRegion({ ...settings, streamMaps: true }),
            onProgress,
            (m, ack) => {
              takePreview(m)
              const { meta, buffers } = serializeDepthMap(m)
              if (at.has(m.uuid)) run.metas[at.get(m.uuid)] = meta
              staged.push(
                run
                  .saveOrMove(() => opfs.saveStagedDepthPlane(run.projectId, m.uuid, buffers))
                  .catch((err) => {
                    stageFailure ??= err
                  })
                  .finally(ack),
              )
            },
            { geomFrom: entries },
          )
          await Promise.all(staged)
          if (stageFailure) throw stageFailure
          // Idempotent (a promoted plane has no staged file left), so it can be retried.
          await run.saveOrMove(() =>
            opfs.promoteStagedDepthPlanes(
              run.projectId,
              run.metas.map((m) => m.uuid),
            ),
          )
        }
        // A split run's maps arrive in finishing order. Keep the input order, so the
        // filter and fusion (which keeps the first point per cell) see the maps as one
        // worker would have written them, and the result does not depend on the split.
        const at = new Map(inputImages.map((im, k) => [im.uuid, k]))
        run.metas.sort((a, b) => at.get(a.uuid) - at.get(b.uuid))
        if (settings.geomConsistency !== false && run.metas.length) {
          // The depth workers hold their last rasters until a collection that may not
          // come: start the filter on a fresh pool, so they cannot crowd the tab's buffers.
          releaseIdleWorkers()
          stageSummary = await filterSavedDepthMaps(run, settings, stageSummary, loopShare, onProgress)
        }
        await run.commit(settings)
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
  async function runDepthMaps(images, sparse, settings, onProgress, onMap, extra = {}) {
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
    if (onMap && images.length > 1 && !cpuThreads && !(settings.useGpu && (await workerDepthBackend(0)).gpu)) {
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
      workers = depthWorkerCount({ n: images.length, poolSize: POOL_SIZE, budget, perWorkerBytes })
    }
    if (workers === 1) {
      return workerComputeDepthMaps(
        { images, sparse, settings: withAck(settings, 0), ...extra },
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
    const chunks = contiguousChunks(images.length, workers)
    // Every worker picks its backend the same way: the first says which, not every one.
    const onLogOf = (w) => (w === 0 ? onLog : (m, l, c) => SAME_ON_EVERY_WORKER.test(m) || onLog(m, l, c))
    const counts = new Array(workers).fill(0),
      fractions = new Array(workers).fill(0)
    const t0 = performance.now()
    // Each worker gets its own copy of the sparse inputs (no transfer: there are several).
    const parts = await Promise.all(
      chunks.map((refs, w) =>
        workerComputeDepthMaps(
          { images, sparse, refs, settings: withAck({ ...settings, memBudgetBytes: budget / workers }, w), ...extra },
          {
            worker: w,
            onLog: onLogOf(w),
            onEvent: onEventFor(w),
            onProgress: (d, t, lbl, f) => {
              counts[w] = d
              fractions[w] = f
              onProgress?.(
                counts.reduce((x, y) => x + y, 0),
                images.length,
                lbl,
                fractions.reduce((x, y) => x + y, 0) / workers,
              )
            },
          },
        ),
      ),
    ).catch((err) => {
      terminateAll(String(err?.message ?? err))
      throw err
    })
    return {
      maps: [],
      summary: mergeDepthSummaries(parts, { totalMs: performance.now() - t0, nImages: images.length }),
      loopShare: parts.reduce((x, p) => x + p.loopShare, 0) / workers,
    }
  }

  // The cross-view filter over a streamed run's saved maps: the worker reads them on
  // demand and returns each filtered depth plane, which is written back over the
  // unfiltered one (the worker has judged every map before the first comes back).
  // Folds the filter's numbers into the Stage A summary, as the in-memory pass does.
  async function filterSavedDepthMaps(run, settings, stageSummary, from, onProgress) {
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
          .saveOrMove(() => opfs.saveDepthPlane(run.projectId, f.uuid, { depth: f.depth }))
          .catch((err) => {
            if (writeFailure) return
            writeFailure = err
            terminateAll(err.message)
          }),
      )
    }
    // References are judged independently against the unfiltered planes, so the maps
    // split over the pool in contiguous chunks (neighbouring captures share candidate
    // views, which keeps each worker's cache warm) give the single run's verdicts.
    const n = entries.length
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
      Math.min(POOL_SIZE, Math.floor(n / (DENSE_TUNING.filterMapsPerWorker ?? 16)), Math.floor(budget / perWorker)),
    )
    log(
      `Depth filter: ${pluralize(workers, 'worker')} (up to ${formatBytes(perWorker)} of candidate planes each, ` +
        `budget ${formatBytes(budget)})`,
      'info',
      'Dense',
    )
    let stats, ms
    if (workers === 1) {
      ;({ stats, ms } = await workerFilterDepthMaps(
        { maps: entries, settings, from },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), onEvent },
      ))
    } else {
      const t0 = performance.now()
      const fractions = new Array(workers).fill(from),
        counts = new Array(workers).fill(0)
      const chunks = contiguousChunks(n, workers)
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
                  n,
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
      const marginal = entries.map((e, i) => ({ e, s: stats[i] })).filter(({ s }) => s.considered > 0 && s.keptPct < 1)
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
    const kept = stats.map((s) => s.keptPct)
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

  // A buffer the browser refused (it arrives from the worker as a plain message) says
  // why and what to change; anything else as it is.
  const densifyErrorText = (err) =>
    bufferFailureText(
      err?.message ?? err,
      'Lower the memory budget (Settings ▸ Compute) so fusion works in slabs, or raise the point-density sample step',
    )

  // Fusion over saved maps on `workers` pool slots. The plan's preflight already counted
  // every worker's input, accumulator and the join; a plan that cannot split (small
  // scene, tight budget) runs whole on one worker without repeating the pre-passes.
  // Returns { cloud, summary } or null (refused, already logged).
  async function densifyParallel(mapsInput, settings, budget, workers, onProgress, stillCurrent) {
    const t0 = performance.now()
    // Each worker's comparison cache; the plan's preflight counts it per worker. An
    // eighth of the budget split K ways starved the cache (96 MB each on quarry).
    const cacheBytes = Math.floor(Math.min(512 * 1024 ** 2, budget / (4 * workers)))
    const fuseSettings = withRegion({ ...settings, memBudgetBytes: budget, cacheBytes, parallel: workers })
    const PLAN_SHARE = FUSION_PLAN_SHARE
    const onLog = (m, l, c) => log(m, l, c)
    onProgress?.(0, 1, 'Planning fusion…', 0, 'plan')
    // The plan's pre-passes over the pool (core/dense/fusionPlan.js fusionPrepassSteps):
    // worker 0 asks for each pass as a batch, the maps go in contiguous runs to the
    // fusion's `workers` slots (worker 0 too: its plan call waits meanwhile), and the parts
    // go back to it. On quarry the plan's passes were most of fusion on one worker.
    const onPlanEvent = (ev, [token, request]) => {
      if (ev !== 'batch') return
      const shares = contiguousChunks(mapsInput.length, Math.max(1, Math.min(workers, mapsInput.length)))
      Promise.all(
        shares.map((refs, w) =>
          workerDensify(
            { maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'prepass', batch: request, refs },
            { worker: w },
          ),
        ),
      )
        .then((parts) => workerFusePlanAnswer(token, parts, 0))
        .catch((err) => workerFusePlanAnswer(token, { error: String(err?.message ?? err) }, 0))
    }
    const { plan, refused } = await workerDensify(
      { maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'plan', splitPlan: workers > 1 },
      {
        onLog,
        worker: 0,
        onEvent: onPlanEvent,
        onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, PLAN_SHARE * (f ?? 0), 'plan'),
      },
    )
    if (refused || !plan || !stillCurrent()) return null
    if (plan.workers <= 1) {
      const { cloud, summary } = await workerDensify(
        { maps: mapsInput, streamed: true, settings: { ...fuseSettings, plan } },
        {
          onLog,
          worker: 0,
          onProgress: (d, t, lbl) =>
            onProgress?.(d, t, lbl, PLAN_SHARE + (1 - PLAN_SHARE) * (t > 0 ? d / t : 0), 'fuse'),
        },
      )
      return { cloud, summary }
    }
    const nM = plan.nMaps,
      nT = plan.slabs.length
    const totalCells = plan.slabs.reduce((s, x) => s + x.cells, 0) || 1
    const slabDone = new Float64Array(nT)
    const report = (lbl) => {
      let f = 0
      for (let i = 0; i < nT; i++) f += (slabDone[i] * plan.slabs[i].cells) / totalCells
      onProgress?.(Math.round(f * nT), nT, lbl, PLAN_SHARE + (1 - PLAN_SHARE) * f, 'fuse')
    }
    // Largest slabs first, so the pool does not end on one long straggler.
    const queue = plan.slabs.map((s, i) => i).sort((a, b) => plan.slabs[b].cells - plan.slabs[a].cells)
    const parts = new Array(nT),
      counters = [],
      streams = []
    const runner = async (w) => {
      while (queue.length) {
        const i = queue.shift()
        const res = await workerDensify(
          { maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'slab', plan, slab: i },
          {
            onLog,
            worker: w,
            onProgress: (d, t, lbl) => {
              slabDone[i] = Math.min(1, Math.max(0, (d - i * nM) / nM))
              report(lbl)
            },
          },
        )
        parts[i] = res.part
        counters.push(res.counters)
        streams.push(res.stream)
        slabDone[i] = 1
        report(`slab ${i + 1}/${nT} done`)
      }
    }
    await Promise.all(Array.from({ length: plan.workers }, (_, w) => runner(w)))
    if (!stillCurrent()) return null
    const merged = mergeFusionCounters(counters)
    const sum = (k) => streams.reduce((s, x) => s + (x?.[k] ?? 0), 0)
    logFusionStream(onLog, {
      compared: sum('compared'),
      culled: sum('culled'),
      skipped: sum('skipped'),
      reads: sum('reads'),
      hits: sum('hits'),
      cacheBytes,
      workers: plan.workers,
      loadMs: sum('loadMs'),
      eligMs: sum('eligMs'),
      checkMs: sum('checkMs'),
    })
    const { summary } = finishFusion(plan, merged, [], onLog)
    // Join the slabs (in slab order, so a run is deterministic for a given plan).
    const n = parts.reduce((s, p) => s + p.count, 0)
    // Shareable (core/bigArray.js): past 2 GiB, shared wasm memory, outside the tab's pool.
    const cloud = {
      count: n,
      pos: shareableArray(Float32Array, n * 3),
      col: shareableArray(Uint8Array, n * 3),
      nrm: shareableArray(Float32Array, n * 3),
    }
    let o = 0
    for (let i = 0; i < nT; i++) {
      const p = parts[i]
      cloud.pos.set(p.pos, o * 3)
      cloud.col.set(p.col, o * 3)
      cloud.nrm.set(p.nrm, o * 3)
      o += p.count
      parts[i] = null
    }
    log(
      `Dense cloud: fused ${nM} depth maps → ${n} points in ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
        `(${nT} slabs on ${plan.workers} workers)`,
      n === 0 ? 'error' : 'success',
      'Dense',
    )
    onProgress?.(1, 1, 'Done', 1)
    return { cloud, summary }
  }

  // Dense Stage B — fuse the Stage A depth maps into a coloured dense cloud.
  async function densify(settings = {}, onProgress) {
    const projectId = projects.currentProjectId,
      sparse = mainSparseCloud.value
    const stillCurrent = () => projectId === projects.currentProjectId && sparse === mainSparseCloud.value
    let input
    try {
      input = await depthMapInput()
    } catch (err) {
      log(`Dense: ${err.message}`, 'error', 'Dense')
      return
    }
    const { maps, streamed } = input
    if (!maps.length) {
      log('Dense: compute depth maps before building the dense cloud', 'warn', 'Dense')
      return
    }
    // Stage B pre-flight: fusion itself measures the merged cell count (at the real
    // merge cell, step and region) and refuses over budget before its consistency
    // pass, returning the transferred buffers home — a pixel-count guess here could
    // not see the merge cell, the step or the view overlap. Same budget knob as Stage A.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    // What the open project already holds in this tab (its clouds, the previous dense
    // cloud among them until the new one replaces it): fusion plans with the rest of the
    // budget, and with the rest of the buffer pool for its plain arrays (shared ones are
    // wasm memory, outside the pool). Quarry: projected 12 GB, the renderer peaked at
    // 17.7 GB with the previous 95 M-point cloud open.
    let pageBytes = 0,
      pagePoolBytes = 0
    for (const c of clouds.value ?? [])
      for (const v of [c, c.attributes, c.points])
        for (const a of Object.values(v ?? {}))
          if (ArrayBuffer.isView(a)) {
            pageBytes += a.byteLength
            if (!isSharedArray(a)) pagePoolBytes += a.byteLength
          }
    if (pageBytes > 0)
      log(`Dense: the open project holds ${formatBytes(pageBytes)} of point data in this tab`, 'debug', 'Dense')
    settings = { ...settings, pageBytes, pagePoolBytes }
    if (streamed)
      log(
        'Dense: reading saved maps on demand (one reference + one comparison); releasing planes after use',
        'info',
        'Dense',
      )
    // Start from fresh workers: the pool's idle ones still hold the depth filter's
    // caches as uncollected garbage, charged to the tab's shared buffer pool.
    releaseIdleWorkers()
    reconStatus.value = 'running'
    // Transfer (not clone) each map's depth/cost/rgb buffers to the worker — they're
    // the bulk of dense memory, and a clone briefly doubles it (the fusion OOM's
    // secondary contributor). The per-map display PNG (displayBlob) is display-only,
    // so strip it from the wire payload entirely. The worker returns the buffers so
    // we re-attach them below; until then the store's copies are detached.
    // Resolve uuid → filename for the fusion progress/log labels. Deliberately derived
    // here rather than persisted in the depth-map index: the image list is the authority
    // on names (a rename must not leave a stale copy in the sidecar), and a restored
    // project has the list but no name on the map. Falls back to a uuid fragment in
    // core/dense/mvs.js when the image is gone.
    const nameByUuid = new Map(images.value.map((im) => [im.uuid, im.name]))
    const mapsInput = streamed
      ? maps.map((m) => ({ ...m, name: nameByUuid.get(m.uuid) }))
      : maps.map((m) => ({
          uuid: m.uuid,
          name: m.name ?? nameByUuid.get(m.uuid),
          width: m.width,
          height: m.height,
          K: m.K,
          R: m.R,
          t: m.t,
          depth: m.depth,
          cost: m.cost,
          rgb: m.rgb,
          normals: m.normals || null,
        }))
    const transfer = []
    for (const m of streamed ? [] : mapsInput) {
      transfer.push(m.depth.buffer, m.cost.buffer, m.rgb.buffer)
      if (m.normals) transfer.push(m.normals.buffer)
    }
    // Saved maps can be read by every worker, so fusion CAN split over the pool: one
    // worker plans (pre-passes + slab layout), then the slabs run in parallel, each
    // exact on its own (core/dense/mvs.js fusionSteps), and are joined in slab order.
    // Up to DENSE_TUNING.fuseWorkers (quarry at Medium: 8 workers 308 s, one 478 s).
    const workers = streamed && maps.length >= 16 ? Math.min(POOL_SIZE, DENSE_TUNING.fuseWorkers ?? 1) : 1
    if (workers > 1) {
      try {
        const done = await densifyParallel(mapsInput, settings, budget, workers, onProgress, stillCurrent)
        if (!stillCurrent() || !done) {
          if (!done) reconStatus.value = 'error'
          return
        }
        upsertDenseCloud(done.cloud, { replace: !!settings.replaceMain })
        denseSummary.value = done.summary
        reconStatus.value = 'done'
        await save()
      } catch (err) {
        if (!stillCurrent()) return
        log(`Densify error: ${densifyErrorText(err)}`, 'error', 'Dense')
        reconStatus.value = 'error'
      }
      return
    }
    try {
      const {
        cloud,
        summary: dSummary,
        refused,
        mapBuffers,
      } = await workerDensify(
        { maps: mapsInput, streamed, settings: withRegion({ ...settings, memBudgetBytes: budget }) },
        {
          onLog: (m, l, c) => log(m, l, c),
          onProgress: (d, t, lbl, f, phase) => onProgress?.(d, t, lbl, f, phase),
          transfer,
        },
      )
      if (!stillCurrent()) return
      // Re-attach the round-tripped buffers so ortho / a second densify still work.
      if (mapBuffers) {
        for (const mb of mapBuffers) {
          const m = depthMaps.value.get(mb.uuid)
          if (m) {
            m.depth = mb.depth
            m.cost = mb.cost
            m.rgb = mb.rgb
            if (mb.normals) m.normals = mb.normals
          }
        }
      }
      // Refused by fusion's measured pre-flight (logged there with its numbers).
      if (refused) {
        reconStatus.value = 'error'
        return
      }
      // The worker returns the cloud already split (Float32 pos, Uint8 col, Float32
      // world-space normals for the Poisson mesh), assembled from its fusion slabs.
      upsertDenseCloud(cloud, { replace: !!settings.replaceMain })
      denseSummary.value = dSummary ?? null
      reconStatus.value = 'done'
      await save()
    } catch (err) {
      if (!stillCurrent()) return
      // The buffers were transferred out; if the worker failed before returning them
      // they're detached (dead). Drop the in-memory cache so ortho / re-densify don't
      // read empty buffers. The planes are on disk now, so point the store back at the
      // saved index: a retry rehydrates from OPFS instead of forcing a Stage A re-run.
      depthMaps.value = new Map()
      const recovered = await loadDepthIndexIntoMeta()
      log(
        `Densify error: ${densifyErrorText(err)}. Depth maps were released to the worker` +
          (recovered
            ? ' — they will be reloaded from disk on the next attempt.'
            : ' and must be recomputed before retrying.'),
        'error',
        'Dense',
      )
      reconStatus.value = 'error'
    }
  }

  // Mesh — screened Poisson over a dense cloud with oriented normals: `settings.sourceId`
  // when given (the modal's picker), else `meshSource` — never "the first dense cloud".
  // Sends disposable copies of the dense buffers to the worker. Keeping the
  // authoritative arrays here costs one temporary copy, but makes cancellation
  // genuinely non-destructive: terminating a worker cannot strand detached
  // source buffers. Upserts a single kind:'mesh' cloud.
  async function generateMesh(settings = {}, onProgress) {
    // replaceMain: Mesh ▸ Replace the main mesh (where the mesh goes, not how it is built).
    const { sourceId, replaceMain, ...meshSettings } = settings
    const pick = sourceId != null ? meshSources.value.find((s) => s.id === sourceId) : meshSource.value
    const dense = pick ? clouds.value.find((c) => c.id === pick.id) : null
    if (!dense?.count) {
      log(
        sourceId != null
          ? 'Mesh: the chosen dense cloud is gone or has no normals'
          : 'Mesh: build a dense point cloud (with normals) first',
        'warn',
        'Products',
      )
      return
    }
    if (!dense.nrm || dense.nrm.length < dense.count * 3) {
      log('Mesh: the dense cloud has no per-point normals — re-run Densify to compute them', 'warn', 'Products')
      return
    }
    // The fusion merge cell is the sample spacing of the clouds fused in this project's
    // frame — the computed cloud and its edits. An imported cloud (or an edit of one)
    // has its own spacing, which the worker estimates.
    const mergeCell = dense.imported ? 0 : (denseSummary.value?.mergeCell ?? 0)
    log(
      `Mesh: source "${dense.name ?? 'Dense'}" (${dense.count.toLocaleString()} points` +
        `${dense.derived ? ', edited' : ''}${dense.imported ? ', imported' : ''})`,
      'info',
      'Products',
    )
    const clipped = clipToRegion(dense, 'Mesh')
    if (clipped && !clipped.count) {
      log('Mesh: no point of the source lies inside the region', 'warn', 'Products')
      return
    }
    // A shared cloud (core/bigArray.js, past 178 M points) goes as a view of itself:
    // nothing can detach it, and a copy would be one buffer over 2 GiB.
    const posCopy = clipped ? clipped.pos : postableCopy(dense.pos)
    const colCopy = clipped ? (clipped.col ?? null) : dense.col ? postableCopy(dense.col) : null
    const nrmCopy = clipped ? clipped.nrm : postableCopy(dense.nrm)
    const input = {
      dense: { count: clipped ? clipped.count : dense.count, pos: posCopy, col: colCopy, nrm: nrmCopy },
      settings: { ...meshSettings, mergeCell },
    }
    const transfer = [posCopy.buffer]
    if (colCopy) transfer.push(colCopy.buffer)
    transfer.push(nrmCopy.buffer)
    reconStatus.value = 'running'
    // Fresh workers: a solve that trapped (out of a wasm heap) leaves its worker's mesh
    // module unusable, and idle workers keep their last run's garbage in the pool.
    releaseIdleWorkers()
    try {
      const { mesh } =
        POOL_SIZE > 1 && meshSettings.tiles !== 'off'
          ? await meshOnPool(input, transfer, meshSettings, onProgress)
          : await workerMeshify(input, {
              onLog: (m, l, c) => log(m, l, c),
              onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f),
              transfer,
            })
      if (!mesh || !mesh.nVerts) {
        log('Mesh: Poisson produced no surface — try a lower depth or check the cloud/normals', 'warn', 'Products')
        reconStatus.value = 'done'
        return
      }
      upsertMeshCloud(mesh, {
        sourceId: dense.id,
        sourceName: dense.name ?? null,
        settings: meshSettings,
        replace: !!replaceMain,
      })
      reconStatus.value = 'done'
      await save()
    } catch (err) {
      log(`Mesh error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  // Build Mesh with its tiles over the pool (workers/ops/mesh.js meshPrepare / meshTile /
  // meshFinish): worker 0 conditions the input and plans — and solves at once when one
  // solve fits — then the tiles go to as many workers as the memory budget holds solves of
  // the largest tile (each a wasm heap that keeps its high-water mark), and worker 0 joins
  // them. Resolves to { mesh }.
  async function meshOnPool(input, transfer, settings, onProgress) {
    const onLog = (m, l, c) => log(m, l, c)
    const runId = `mesh-${Date.now().toString(36)}`
    const prep = await workerMeshPrepare({ ...input, runId }, { worker: 0, onLog, onProgress, transfer })
    if (prep.mesh) return prep
    const { share, tiles: n } = prep
    const tiles = share.tiling.tiles
    const perTile = poissonHeapBytes(Math.max(...tiles.map((t) => t.samples)), share.solveArgs.depth)
    const budget = settings.ramBudgetBytes > 0 ? settings.ramBudgetBytes : DEFAULT_BUDGET_BYTES
    const workers = Math.max(1, Math.min(POOL_SIZE, n, Math.floor(budget / perTile)))
    log(
      `Mesh: ${n} tiles on ${pluralize(workers, 'worker')} (a solve ≤ ${formatBytes(perTile)} each, memory ` +
        `budget ${formatBytes(budget)})`,
      'info',
      'Products',
    )
    const JOIN = 0.05
    const done = new Float64Array(n)
    const report = (lbl) => {
      const f = done.reduce((a, b) => a + b, 0) / n
      onProgress?.(Math.round(f * n), n, lbl, (1 - JOIN) * f)
    }
    // Largest tiles first, so the pool does not end on one long straggler.
    const queue = tiles.map((_, i) => i).sort((a, b) => tiles[b].samples - tiles[a].samples)
    const results = new Array(n)
    const runner = async (w) => {
      while (queue.length) {
        const i = queue.shift()
        results[i] = await workerMeshTile(
          { share, index: i },
          {
            worker: w,
            onLog,
            // The worker reports a tile's progress as its share of the whole bar.
            onProgress: (d, t, lbl, f) => {
              done[i] = Math.min(1, Math.max(0, (f ?? 0) * n - i))
              report(lbl)
            },
          },
        )
        done[i] = 1
        report(`Tile ${i + 1}/${n} done`)
      }
    }
    await Promise.all(Array.from({ length: workers }, (_, w) => runner(w)))
    onProgress?.(n, n, 'Joining the tiles…', 1 - JOIN)
    return workerMeshFinish({ runId, results }, { worker: 0, onLog })
  }

  return {
    computeDepthMaps,
    filterSavedDepthMaps,
    densifyParallel,
    densify,
    generateMesh,
  }
}

import { computeSourceOf } from '../../utils/image.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { qualityToMaxDim, fitDepthQuality, filterConfig, filterSettings, logFilterCache, logFilterTotals, emptyFilterTotals, mergeFusionCounters, logFusionStream, finishFusion } from '../../core/dense/mvs.js'
import { isFiducialCalibrated } from '../../core/sfm/fiducialModel.js'
import { packSparseForDense, sparseInputTransfer } from '../../core/dense/sparseInput.js'
import { computeDepthMaps as workerComputeDepthMaps, POOL_SIZE, terminateAll, filterDepthMaps as workerFilterDepthMaps, densify as workerDensify, meshify as workerMeshify } from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'
import { DEFAULT_BUDGET_BYTES, formatBytes } from '../../core/dense/memBudget.js'
import { DENSE_TUNING } from '../../core/tuning.js'

// The dense pipeline, split out of useReconstructionStore: Stage A depth maps
// (PatchMatch MVS in the workers, persisted per image), the saved-map filter,
// fusion into the dense cloud (streamed over the worker pool when the maps are on
// disk), and Poisson meshing. Each run checks it is still current — same project,
// same main sparse model — before it commits anything.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createDense({
  beginStreamedDepthMaps, clipToRegion, clouds, denseSummary, depthMapInput, depthMaps,
  depthMapsMeta, depthSummary, images, imagesStore, isPersisting, loadDepthIndexIntoMeta, log,
  mainSparseCloud, meshSource, meshSources, save, persistDepthMaps, projects, reconStatus,
  sensors, summary, upsertDenseCloud, upsertMeshCloud, withRegion,
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
      const frameModel = makeFrameModelResolver({ summary: summary.value, sensors: sensors.value })
      // F4: per-image scan→canonical transform from the sparse run. The dense
      // stage reproduces that exact frame (it must NOT re-fit) — the sparse run
      // defines it. Fail loudly if a film image is in the cloud but its transform
      // is missing (a stale/partial summary would silently mis-warp its raster).
      const fidByUuid = new Map(
        (summary.value?.fiducialTransforms ?? []).map((t) => [t.uuid, { A: t.A, transform: t.transform ?? null, frame: t.frame }]))
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
            why = `its detected fiducials are not calibrated (${nMarks} metric marks, need ≥3) — `
              + `run Calibrate Fiducials, then re-run the sparse reconstruction`
          } else if (nObs < 3) {
            why = `this image has ${nObs} accepted fiducial detection(s) (need ≥3) — `
              + `run Detect Fiducials or review its spots, then re-run the sparse reconstruction`
          } else {
            why = `the last sparse run produced no interior-orientation transform for it — `
              + `re-run the sparse reconstruction before densifying`
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
          uuid, name: im.name, url: computeSourceOf(im),
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
        const parts = selfCalRows.map((d) =>
          `${d.sensorId != null ? (sensorById.get(d.sensorId)?.label ?? d.sensorId.slice(0, 6))
            : (imgByUuid.get(d.imageUuid)?.name ?? 'image')}${d.fisheye ? ' fisheye' : ''} k1 ${(d.k1 || 0).toFixed(5)}`
          + `${d.k2 ? `, k2 ${d.k2.toFixed(5)}` : ''}${d.k3 ? `, k3 ${d.k3.toFixed(5)}` : ''}`
          + `${d.k4 ? `, k4 ${d.k4.toFixed(5)}` : ''}`)
        log(`Dense: applying self-calibrated distortion from the sparse run — ${parts.join('; ')}`,
          'info', 'Dense')
      }
      // Packed typed arrays, transferred (core/dense/sparseInput.js) — not an object
      // plus a views array per point, structured-cloned.
      const sparse = packSparseForDense(cloud.points)

      // The image's depth preview (display PNG), then drop it from the map.
      let previews = 0
      const takePreview = (m) => {
        const im = imgByUuid.get(m.uuid)
        if (im && m.displayBlob) { imagesStore.updateDepth(im.id, m.displayBlob, { quiet: true, persistSync: false }); previews++ }
        delete m.displayBlob
      }
      // Streamed (TODO ▸ SC-4) whenever the maps can be saved: each finished map is
      // written and released at once, and the cross-view filter runs as its own pass
      // over the saved files. Holding every map to the end (the in-memory path, kept
      // for a project that cannot save) made the preflight refuse ~100+ images.
      // A map that cannot be saved (storage full) stops the run: the rest could not
      // be kept either, and the worker would spend minutes computing them.
      const run = await beginStreamedDepthMaps({
        onWriteFailure: (err) => { writeFailure = err; terminateAll(err.message) },
      })
      // Resolve a quality preset → working maxDim from the largest native image
      // dimension (Step 3), unless the user set an explicit maxDim in Advanced. A
      // quality whose projected peak exceeds the memory budget steps down (High →
      // Medium → Low) with a warning, rather than the worker refusing to start.
      const resolved = { ...settings }
      if (resolved.quality && !(resolved.maxDim > 0)) {
        const nativeLong = images.value.reduce(
          (m, im) => Math.max(m, im.meta?.width || 0, im.meta?.height || 0), 0)
        resolved.maxDim = qualityToMaxDim(resolved.quality, nativeLong)
        const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
        const plan = (quality, cap) => fitDepthQuality({
          quality, budget: cap, sizes: inputImages.map((im) => ({ width: im.width, height: im.height })),
          backend: settings.useGpu ? 'gpu' : 'wasm', nSources: Math.min(16, settings.maxSources ?? 6),
          streamMaps: !!run, geomConsistency: settings.geomConsistency !== false,
        })
        const fit = plan(resolved.quality, budget)
        if (fit?.steps > 0) {
          log(`Dense: quality '${resolved.quality}' would need ≈ ${formatBytes(plan(resolved.quality, Infinity).proj.total)} `
            + `against the ${formatBytes(budget)} budget — using '${fit.quality}' (≤${fit.maxDim}px, ≈ ${formatBytes(fit.proj.total)}). `
            + 'Raise the memory budget (Settings ▸ Compute) to keep the higher quality.', 'warn', 'Dense')
          resolved.quality = fit.quality
          resolved.maxDim = fit.maxDim
        }
        log(`Dense: quality '${resolved.quality}' → working ≤${resolved.maxDim}px `
          + `(¼-scale presets of ${nativeLong}px native)`, 'info', 'Dense')
      }
      settings = resolved
      const { maps, summary: aSummary, loopShare } = await workerComputeDepthMaps(
        { images: inputImages, sparse, settings: withRegion({ ...settings, streamMaps: !!run }) },
        { transfer: sparseInputTransfer(sparse), onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f),
          onEvent: (ev, [m]) => { if (ev === 'map' && run) { takePreview(m); run.add(m) } } },
      )
      let stageSummary = aSummary ?? null
      if (run) {
        await run.settled()
        if (settings.geomConsistency !== false && run.metas.length) {
          stageSummary = await filterSavedDepthMaps(run, settings, stageSummary, loopShare, onProgress)
        }
        await run.commit(settings)
      } else {
        depthMaps.value = new Map(maps.map((m) => [m.uuid, m]))
        depthMapsMeta.value = []   // the fresh maps supersede any restored index
        for (const m of maps) takePreview(m)
      }
      depthSummary.value = stageSummary
      if (previews && isPersisting()) imagesStore.save()
      log(`Dense: ${run ? run.metas.length : maps.length} depth map(s) computed`, 'success', 'Dense')
      reconStatus.value = 'done'
      // In memory only: save before densify can transfer the buffers away (a no-op
      // when the project cannot save, which is why this path exists).
      if (!run) await persistDepthMaps(maps, settings)
    } catch (err) {
      log(`Depth-map error: ${(writeFailure ?? err)?.message ?? err}`, 'error', 'Dense')
      reconStatus.value = 'error'
    }
  }

  // The cross-view filter over a streamed run's saved maps: the worker reads them on
  // demand and returns each filtered depth plane, which is written back over the
  // unfiltered one (the worker has judged every map before the first comes back).
  // Folds the filter's numbers into the Stage A summary, as the in-memory pass does.
  async function filterSavedDepthMaps(run, settings, stageSummary, from, onProgress) {
    const metaByUuid = new Map(run.metas.map((m) => [m.uuid, m]))
    const nameByUuid = new Map(images.value.map((im) => [im.uuid, im.name]))
    const entries = (await opfs.loadDepthFiles(run.projectId, run.metas))
      .map((e) => ({ ...e, name: nameByUuid.get(e.uuid) }))
    // Each rewrite is handled as it is queued (see beginStreamedDepthMaps): the first
    // that fails (storage full) stops the workers and fails the stage with its message.
    const writes = []
    let writeFailure = null
    const onEvent = (ev, [f]) => {
      if (ev !== 'filtered') return
      const meta = metaByUuid.get(f.uuid)
      if (meta) Object.assign(meta, f.coverage)
      writes.push(opfs.saveDepthPlane(run.projectId, f.uuid, { depth: f.depth }).catch((err) => {
        if (writeFailure) return
        writeFailure = err
        terminateAll(err.message)
      }))
    }
    // References are judged independently against the unfiltered planes, so the maps
    // split over the pool in contiguous chunks (neighbouring captures share candidate
    // views, which keeps each worker's cache warm) give the single run's verdicts.
    const n = entries.length
    const workers = Math.max(1, Math.min(POOL_SIZE, Math.floor(n / 16)))
    let stats, ms
    if (workers === 1) {
      ({ stats, ms } = await workerFilterDepthMaps({ maps: entries, settings, from },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), onEvent }))
    } else {
      const t0 = performance.now()
      const fractions = new Array(workers).fill(from), counts = new Array(workers).fill(0)
      const chunks = Array.from({ length: workers }, (_, w) => {
        const a = Math.floor(w * n / workers), b = Math.floor((w + 1) * n / workers)
        return Array.from({ length: b - a }, (_, k) => a + k)
      })
      const parts = await Promise.all(chunks.map((refs, w) => workerFilterDepthMaps(
        { maps: entries, settings, from, refs, workers },
        { worker: w, onLog: (m, l, c) => log(m, l, c), onEvent,
          onProgress: (d, t, lbl, f) => {
            fractions[w] = f; counts[w] = d
            onProgress?.(counts.reduce((x, y) => x + y, 0), n, lbl, fractions.reduce((x, y) => x + y, 0) / workers)
          } })))
      stats = new Array(n)
      const totals = emptyFilterTotals()
      let loads = 0, hits = 0, nCand = 0
      parts.forEach((p, w) => {
        for (const i of chunks[w]) stats[i] = p.stats[i]
        for (const k of Object.keys(totals)) totals[k] += p.totals[k]
        loads += p.loads; hits += p.hits; nCand += p.nCand
      })
      // Every map is judged now; only now may any of them be rewritten.
      await Promise.all(chunks.map((refs, w) => workerFilterDepthMaps(
        { maps: entries, apply: { refs, masks: parts[w].masks, stats: refs.map((i) => parts[w].stats[i]) } },
        { worker: w, onEvent, transfer: parts[w].masks.map((m) => m.buffer) })))
      ms = performance.now() - t0
      const cfg = filterConfig(filterSettings(settings))
      if (n >= 2 && cfg.minConsistent > 0) logFilterCache(log, { nMaps: n, nCand, loads, hits, cacheBytes: parts[0].cacheBytes, cull: cfg.cull, workers })
      logFilterTotals(log, totals, n, cfg)
      const marginal = entries.map((e, i) => ({ e, s: stats[i] })).filter(({ s }) => s.considered > 0 && s.keptPct < 1)
      if (marginal.length) {
        const names = marginal.slice(0, 12).map(({ e, s }) => `${e.name || e.uuid} ${s.keptPct.toFixed(1)}%`).join('; ')
        log(`Depth filter: ${marginal.length} marginal map(s) kept <1% after cross-view filtering — `
          + `${names}${marginal.length > 12 ? `; +${marginal.length - 12} more` : ''}. `
          + 'They remain cached for diagnostics/orthophoto use but will contribute little to fusion.', 'warn', 'Dense')
      }
      log(`Depth filter: cross-view consistency in ${(ms / 1000).toFixed(1)}s on ${workers} workers `
        + `(streamed from saved maps; judging ${(Math.max(...parts.map((p) => p.judgeMs)) / 1000).toFixed(1)}s in the slowest)`, 'info', 'Dense')
      onProgress?.(n, n, 'Depth maps complete', 1)
    }
    await Promise.all(writes)
    if (writeFailure) throw writeFailure
    const kept = stats.map((s) => s.keptPct)
    const sorted = [...kept].sort((a, b) => a - b)
    return stageSummary && {
      ...stageSummary,
      geomFilterMs: ms,
      geomFilterMedianKeptPct: sorted.length ? sorted[Math.round(0.5 * (sorted.length - 1))] : null,
      geomFilterMinKeptPct: sorted.length ? sorted[0] : null,
      geomFilterMarginalMaps: kept.filter((v) => v < 1).length,
    }
  }

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
    const PLAN_SHARE = 0.1 // the pre-passes read every map four times, the slabs do the rest
    const onLog = (m, l, c) => log(m, l, c)
    onProgress?.(0, 1, 'Planning fusion…', 0)
    const { plan, refused } = await workerDensify({ maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'plan' }, { onLog, worker: 0 })
    if (refused || !plan || !stillCurrent()) return null
    if (plan.workers <= 1) {
      const { cloud, summary } = await workerDensify({ maps: mapsInput, streamed: true, settings: { ...fuseSettings, plan } },
        { onLog, worker: 0, onProgress: (d, t, lbl) => onProgress?.(d, t, lbl, PLAN_SHARE + (1 - PLAN_SHARE) * (t > 0 ? d / t : 0)) })
      return { cloud, summary }
    }
    const nM = plan.nMaps, nT = plan.slabs.length
    const totalCells = plan.slabs.reduce((s, x) => s + x.cells, 0) || 1
    const slabDone = new Float64Array(nT)
    const report = (lbl) => {
      let f = 0
      for (let i = 0; i < nT; i++) f += slabDone[i] * plan.slabs[i].cells / totalCells
      onProgress?.(Math.round(f * nT), nT, lbl, PLAN_SHARE + (1 - PLAN_SHARE) * f)
    }
    // Largest slabs first, so the pool does not end on one long straggler.
    const queue = plan.slabs.map((s, i) => i).sort((a, b) => plan.slabs[b].cells - plan.slabs[a].cells)
    const parts = new Array(nT), counters = [], streams = []
    const runner = async (w) => {
      while (queue.length) {
        const i = queue.shift()
        const res = await workerDensify({ maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'slab', plan, slab: i }, {
          onLog, worker: w,
          onProgress: (d, t, lbl) => { slabDone[i] = Math.min(1, Math.max(0, (d - i * nM) / nM)); report(lbl) },
        })
        parts[i] = res.part; counters.push(res.counters); streams.push(res.stream)
        slabDone[i] = 1
        report(`slab ${i + 1}/${nT} done`)
      }
    }
    await Promise.all(Array.from({ length: plan.workers }, (_, w) => runner(w)))
    if (!stillCurrent()) return null
    const merged = mergeFusionCounters(counters)
    const sum = (k) => streams.reduce((s, x) => s + (x?.[k] ?? 0), 0)
    logFusionStream(onLog, { compared: sum('compared'), culled: sum('culled'), reads: sum('reads'), hits: sum('hits'),
      cacheBytes, workers: plan.workers })
    const { summary } = finishFusion(plan, merged, [], onLog)
    // Join the slabs (in slab order, so a run is deterministic for a given plan).
    const n = parts.reduce((s, p) => s + p.count, 0)
    const cloud = { count: n, pos: new Float32Array(n * 3), col: new Uint8Array(n * 3), nrm: new Float32Array(n * 3) }
    let o = 0
    for (let i = 0; i < nT; i++) {
      const p = parts[i]
      cloud.pos.set(p.pos, o * 3); cloud.col.set(p.col, o * 3); cloud.nrm.set(p.nrm, o * 3)
      o += p.count; parts[i] = null
    }
    log(`Dense cloud: fused ${nM} depth maps → ${n} points in ${((performance.now() - t0) / 1000).toFixed(1)}s `
      + `(${nT} slabs on ${plan.workers} workers)`, n === 0 ? 'error' : 'success', 'Dense')
    onProgress?.(1, 1, 'Done', 1)
    return { cloud, summary }
  }

  // Dense Stage B — fuse the Stage A depth maps into a coloured dense cloud.
  async function densify(settings = {}, onProgress) {
    const projectId = projects.currentProjectId, sparse = mainSparseCloud.value
    const stillCurrent = () => projectId === projects.currentProjectId && sparse === mainSparseCloud.value
    let input
    try { input = await depthMapInput() }
    catch (err) { log(`Dense: ${err.message}`, 'error', 'Dense'); return }
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
    if (streamed) log('Dense: reading saved maps on demand (one reference + one comparison); releasing planes after use', 'info', 'Dense')
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
    const mapsInput = streamed ? maps.map(m => ({ ...m, name: nameByUuid.get(m.uuid) })) : maps.map((m) => ({
      uuid: m.uuid, name: m.name ?? nameByUuid.get(m.uuid), width: m.width, height: m.height, K: m.K, R: m.R, t: m.t,
      depth: m.depth, cost: m.cost, rgb: m.rgb, normals: m.normals || null,
    }))
    const transfer = []
    for (const m of streamed ? [] : mapsInput) {
      transfer.push(m.depth.buffer, m.cost.buffer, m.rgb.buffer)
      if (m.normals) transfer.push(m.normals.buffer)
    }
    // Saved maps can be read by every worker, so fusion CAN split over the pool: one
    // worker plans (pre-passes + slab layout), then the slabs run in parallel, each
    // exact on its own (core/dense/mvs.js fusionSteps), and are joined in slab order.
    // Off by default (DENSE_TUNING.fuseWorkers): fusion is bound by plane reads, and on
    // quarry 8 workers took 630 s against one worker's 557 s (HANDOVER ▸ B-parity).
    const workers = streamed && maps.length >= 16 ? Math.min(POOL_SIZE, DENSE_TUNING.fuseWorkers ?? 1) : 1
    if (workers > 1) {
      try {
        const done = await densifyParallel(mapsInput, settings, budget, workers, onProgress, stillCurrent)
        if (!stillCurrent() || !done) { if (!done) reconStatus.value = 'error'; return }
        upsertDenseCloud(done.cloud)
        denseSummary.value = done.summary
        reconStatus.value = 'done'
        await save()
      } catch (err) {
        if (!stillCurrent()) return
        log(`Densify error: ${err?.message ?? err}`, 'error', 'Dense')
        reconStatus.value = 'error'
      }
      return
    }
    try {
      const { cloud, summary: dSummary, refused, mapBuffers } = await workerDensify(
        { maps: mapsInput, streamed, settings: withRegion({ ...settings, memBudgetBytes: budget }) },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
      )
      if (!stillCurrent()) return
      // Re-attach the round-tripped buffers so ortho / a second densify still work.
      if (mapBuffers) {
        for (const mb of mapBuffers) {
          const m = depthMaps.value.get(mb.uuid)
          if (m) { m.depth = mb.depth; m.cost = mb.cost; m.rgb = mb.rgb; if (mb.normals) m.normals = mb.normals }
        }
      }
      // Refused by fusion's measured pre-flight (logged there with its numbers).
      if (refused) { reconStatus.value = 'error'; return }
      // The worker returns the cloud already split (Float32 pos, Uint8 col, Float32
      // world-space normals for the Poisson mesh), assembled from its fusion slabs.
      upsertDenseCloud(cloud)
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
      log(`Densify error: ${err?.message ?? err}. Depth maps were released to the worker`
        + (recovered
          ? ' — they will be reloaded from disk on the next attempt.'
          : ' and must be recomputed before retrying.'), 'error', 'Dense')
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
    const { sourceId, ...meshSettings } = settings
    const pick = sourceId != null ? meshSources.value.find((s) => s.id === sourceId) : meshSource.value
    const dense = pick ? clouds.value.find((c) => c.id === pick.id) : null
    if (!dense?.count) {
      log(sourceId != null
        ? 'Mesh: the chosen dense cloud is gone or has no normals'
        : 'Mesh: build a dense point cloud (with normals) first', 'warn', 'Products')
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
    log(`Mesh: source "${dense.name ?? 'Dense'}" (${dense.count.toLocaleString()} points`
      + `${dense.derived ? ', edited' : ''}${dense.imported ? ', imported' : ''})`, 'info', 'Products')
    const clipped = clipToRegion(dense, 'Mesh')
    if (clipped && !clipped.count) {
      log('Mesh: no point of the source lies inside the region', 'warn', 'Products')
      return
    }
    const posCopy = clipped ? clipped.pos : dense.pos.slice()
    const colCopy = clipped ? (clipped.col ?? null) : (dense.col?.slice() || null)
    const nrmCopy = clipped ? clipped.nrm : dense.nrm.slice()
    const input = {
      dense: { count: clipped ? clipped.count : dense.count, pos: posCopy, col: colCopy, nrm: nrmCopy },
      settings: { ...meshSettings, mergeCell },
    }
    const transfer = [posCopy.buffer]
    if (colCopy) transfer.push(colCopy.buffer)
    transfer.push(nrmCopy.buffer)
    reconStatus.value = 'running'
    try {
      const { mesh } = await workerMeshify(input,
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer })
      if (!mesh || !mesh.nVerts) {
        log('Mesh: Poisson produced no surface — try a lower depth or check the cloud/normals', 'warn', 'Products')
        reconStatus.value = 'done'
        return
      }
      upsertMeshCloud(mesh, { sourceId: dense.id, sourceName: dense.name ?? null, settings: meshSettings })
      reconStatus.value = 'done'
      await save()
    } catch (err) {
      log(`Mesh error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  return {
    computeDepthMaps, filterSavedDepthMaps, densifyParallel, densify, generateMesh,
  }
}

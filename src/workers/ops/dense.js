import { readDepthFiles, readDepthOnly, readDepthAndCost, readDepthCostMap } from '../../core/dense/depthFileReader.js'
import {
  selectSourceViews,
  scaleK,
  resolveViewSelection,
  fuseDepthMaps,
  fuseDepthMapsStreamed,
  filterDepthMapsGeometric,
  filterDepthMapsGeometricStreamed,
  applyPackedMask,
  geomFilterLoopShare,
  autoBestK,
  filterSettings,
  depthMapSettings,
} from '../../core/dense/mvs.js'
import { depthCoverage } from '../../core/dense/depthMapCodec.js'
import { FUSION_PLAN_SHARE, fusionPrepassSteps } from '../../core/dense/fusionPlan.js'
import { viewIndex } from '../../core/dense/sparseInput.js'
import { hasDistortion } from '../../core/sfm/distortion.js'
import { fisheyeCanvas } from '../../core/products/undistort.js'
import { isGpuAvailable, ensureDevice } from '../gpu/device.js'
import { projectDensePeakBytes, workingPixels, formatBytes, DEFAULT_BUDGET_BYTES } from '../../core/dense/memBudget.js'
import { pluralize } from '../../core/textFormat.js'
import { DENSE_TUNING } from '../../core/tuning.js'
import { joinCloudParts } from '../../core/dense/cloudParts.js'
import { createRasterCache, gridScale, paddedK } from './depthRasters.js'
import { chooseDepthBackend, warmUpDepthBackend, depthMapOnBackend } from './depthBackend.js'
import { finishDepthMap } from './depthMapFinish.js'

// Dense MVS ops (Stage A depth maps + Stage B fusion). `rasterize` (OffscreenCanvas
// pixel decode) is injected. computeDepthMaps runs Stage A's loop; its parts are
// depthRasters.js (the rasters in the pinhole frame and their cache), depthBackend.js
// (GPU or CPU, one map with its fallbacks and the slow-GPU probe) and depthMapFinish.js
// (a finished map's filtering, preview and log line).

export function makeDenseOps({ rasterize }) {
  // Saved-map acks per streamed run (`settings.ackToken`), from the page's depthAck:
  // { acked, wake } — the run waits while too many of its maps are unsaved.
  const acks = new Map()
  function depthAck([token]) {
    const a = acks.get(token) ?? { acked: 0, wake: null }
    a.acked++
    acks.set(token, a)
    a.wake?.()
    return { result: a.acked }
  }
  async function untilSaved(token, streamed) {
    const a = acks.get(token) ?? acks.set(token, { acked: 0, wake: null }).get(token)
    while (streamed - a.acked > DENSE_TUNING.depthMapsUnsaved) await new Promise((r) => (a.wake = r))
    a.wake = null
  }

  // Stage A — Build Depth Maps. Rasterises each registered image (and its source
  // neighbours), runs PatchMatch MVS, and returns one depth map per reference image
  // (raw depth/cost planes + colours for fusion, plus a display PNG). Pure compute
  // lives in core/dense/mvs.js; pixel decoding is worker-only (OffscreenCanvas).
  // Whether this worker's depth maps would run on the GPU (the same test as
  // computeDepthMaps), so the store keeps a GPU run on one worker and splits a CPU run
  // over the pool. The main thread cannot tell: headless Chrome, for one, exposes
  // navigator.gpu with no adapter, and a worker's adapter can differ from the page's.
  async function depthBackend() {
    return { result: { gpu: isGpuAvailable() && !!(await ensureDevice()) } }
  }

  async function computeDepthMaps([input], { emit }) {
    // `sparse`: the packed sparse model (core/dense/sparseInput.js), transferred.
    // `refs`: the indices of `images` this call computes (default all). A run split over
    // the pool (core/dense/depthSplit.js) gives each worker every image, so source views
    // are chosen among all cameras as in a single run, and its own share to compute.
    const { images, sparse, settings = {} } = input
    const order = input.refs ?? images.map((_, i) => i)
    // Every knob through the engine-boundary checks (core/dense/mvs.js depthMapSettings):
    // a blank / non-finite / out-of-range value takes its default.
    const {
      maxDim,
      maxSources: maxSourcesReq,
      minAngleDeg,
      window,
      iterations,
      bestK,
      speckleFilter,
      filterRadius,
      filterRelTol,
      coarseLong,
      // Resolved here (not left to the filter's own defaults) so the run record below
      // states the values the filter actually used, also for a recipe saved before a knob existed.
      geomConsistency,
      maxGeomCost,
      minConsistent,
      minNcc,
      minGeomAngleDeg,
      // Stream each finished map to the caller ('map' event, planes transferred) instead
      // of holding all of them to the end; the caller then runs the cross-view filter
      // over the saved maps (filterDepthMaps below). Holding every map was 23 B/px ×
      // every image in this worker and again on the page — the preflight refused
      // quarry (347 images) at Medium (TODO ▸ SC-4).
      streamMaps,
    } = depthMapSettings(settings)
    // The GPU kernel packs sources into a fixed MAX_SRC=16 array and silently drops
    // any beyond that (depthMapGpu.js), while the WASM path + the first-image A/B
    // validation use every source. Clamp here so both backends see the same source
    // count — otherwise >16 sources makes GPU vs WASM diverge and trips a spurious
    // A/B RMS warning.
    const maxSources = Math.min(16, maxSourcesReq)
    // Auto best-K per image (Step 3) when the user hasn't overridden it: derive from
    // that image's source count (clamp(ceil(nSources/2),1,4)) rather than a fixed 3.
    const autoBestKMode = !(bestK > 0)

    const t0 = performance.now()
    const share = input.refs
      ? `${order.length} of ${images.length} images on this worker`
      : pluralize(images.length, 'image')
    emit('log', [
      `Depth maps: ${share} — working ≤${maxDim}px, ` +
        `≤${maxSources} sources (best-${autoBestKMode ? 'auto' : bestK}), window ${window} (${2 * window + 1}×${2 * window + 1}), ` +
        `${iterations} PatchMatch iters`,
      'info',
      'Dense',
    ])

    // Backend selection: opt into the (experimental) WebGPU path with settings.useGpu
    // (depthBackend.js); `bk.backend` can still flip to WASM mid-run on a GPU error.
    const bk = await chooseDepthBackend(settings, emit)
    {
      const vs = resolveViewSelection(settings.viewSelection, !!bk.backend)
      emit('log', [
        `Depth maps: view selection ${vs === 'acmh' ? 'ACMH (adaptive checkerboard, joint view selection)' : 'best-K'}` +
          `${(settings.viewSelection ?? 'auto') === 'auto' ? ' (auto for this backend)' : ''}`,
        'info',
        'Dense',
      ])
    }
    // Stage A run record. `bk.backend` above can flip to WASM mid-run on a GPU error, so
    // the record tracks what was *requested*, what it started on, and how many images
    // fell back — "all 86 maps remained on GPU" is a target in TODO ▸ SB and is
    // unanswerable from a summary that only reports the final value.
    // The CPU path runs each map on the threaded build's pool (all cores but one) when the
    // store gave this run one worker for it (DENSE_TUNING.cpuDepthThreads); a split run
    // (`split`, its share in `refs`) keeps one thread per worker. A continued run's
    // `refs` alone, on one worker, keeps the threads.
    const cpuThreads =
      !input.split && (settings.cpuDepthThreads ?? DENSE_TUNING.cpuDepthThreads)
        ? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1)
        : 0
    if (!bk.backend && cpuThreads) emit('log', [`Depth maps: up to ${cpuThreads} threads per map`, 'info', 'Dense'])
    const startedOnGpu = !!bk.backend
    const perImage = [] // { ms, coveragePct, costMedian }

    const cameras = new Map(images.map((im) => [im.uuid, { R: im.R, t: im.t, K: im.K }]))

    // Pre-flight memory budget (Step 5): project the peak allocation and refuse to
    // start when it exceeds the budget, rather than letting the browser OOM-kill the
    // tab mid-run (Safari can't be observed or intercepted). Working dims from each
    // image's own size (maxDim² when unknown); source count uses maxSources.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    const proj = projectDensePeakBytes({
      nImages: order.length,
      maxDim,
      nSources: maxSources,
      backend: bk.backend ? 'gpu' : 'wasm',
      // A fisheye's widened canvas (undistortRaster) at the photo's working scale.
      pixels: order
        .map((i) => images[i])
        .map((im) => {
          const px = workingPixels(im.width, im.height, maxDim)
          const c = !im.fid && !hasDistortion(im.selfCal) ? fisheyeCanvas(im.K, im.dist, im.width, im.height) : null
          return c ? Math.round((px * (c.width * c.height)) / (im.width * im.height)) : px
        }),
      retainedMaps: streamMaps ? 1 : order.length,
      // The in-memory cross-view filter below; streamed maps are filtered by its own pass.
      filterMaps: geomConsistency && !streamMaps ? order.length : 0,
      planarPrior: !!settings.planarPrior,
      geomPass: !!settings.geomPass,
      geomCacheMaps: DENSE_TUNING.geomDepthCache,
    })
    emit('log', [
      `Dense: projected peak memory ≈ ${formatBytes(proj.total)} ` +
        `(store ${formatBytes(proj.store)} + raster ${formatBytes(proj.raster)}` +
        `${proj.gpu ? ` + GPU ${formatBytes(proj.gpu)}` : ''}${proj.filter ? ` + filter masks ${formatBytes(proj.filter)}` : ''}` +
        `${proj.method ? ` + Full method ${formatBytes(proj.method)}` : ''}) vs budget ${formatBytes(budget)}`,
      proj.total > budget ? 'error' : 'info',
      'Dense',
    ])
    if (proj.total > budget) {
      emit('log', [
        'Dense: aborting before start — projected memory exceeds the budget. ' +
          'Lower Quality (e.g. Medium) or raise the memory budget, then retry.',
        'error',
        'Dense',
      ])
      throw new Error(`dense pre-flight: projected ${formatBytes(proj.total)} exceeds budget ${formatBytes(budget)}`)
    }

    // Precompute each image's source views once (also drives the raster refcounts),
    // so the cache can evict a raster the moment it's no longer needed — keeping the
    // resident working set small instead of holding every image's pixels at once.
    const sparseIndex = viewIndex(sparse) // image → the points it sees, once per run
    const srcUuidsByImg = new Map(
      order.map((i) => [
        i,
        selectSourceViews(cameras, sparse, images[i].uuid, { maxSources, minAngleDeg }, sparseIndex),
      ]),
    )
    const { ready, prefetch, releaseAfter, imageByUuid, ledger, prepMs } = createRasterCache({
      rasterize,
      images,
      order,
      srcUuidsByImg,
      maxDim,
    })

    const maps = []
    const transfer = []
    let streamed = 0
    // Stage A is a per-image loop FOLLOWED by the cross-view filter, which needs every
    // map before it can start. The loop therefore owns only the first slice of the bar
    // — reporting it as the whole thing left the filter (minutes on a big set) running
    // behind a bar already sitting at 100%. done/total stay honest for the readout.
    // The slice is re-derived after every image from the measured loop time vs the
    // filter's modelled cost (geomFilterLoopShare): a fixed 85/15 was ~right for neither
    // backend. A small backwards step in the fraction is absorbed by usePipeline's
    // monotonic clamp (the bar holds briefly rather than jumping back).
    let loopShare = geomConsistency ? 0.85 : 1 // until the first image measures the loop
    let pxDone = 0
    const tLoop = performance.now()
    const updateLoopShare = (done) => {
      if (!geomConsistency) return
      const s = geomFilterLoopShare({ loopMs: performance.now() - tLoop, done, total: order.length, pxDone })
      if (s != null) loopShare = s
    }
    const total = order.length
    const loopFraction = (v) => (total > 0 ? loopShare * (v / total) : 0)
    if (!(await warmUpDepthBackend({ backend: bk.backend, cpuThreads, total, emit }))) {
      bk.backend = undefined
      bk.gpuFallbacks++
    }
    // The geometric-consistency pass (ACMP's last stage): given `input.geomFrom`, the run's
    // first-pass maps as saved file entries, this call runs each image again against its
    // neighbours' first-pass depths (core/dense/depthMap.js geomDepthMapForImage) and emits
    // the new maps. The store saves them staged and promotes them once every map is done
    // (utils/opfs/depth.js), so no first-pass plane changes while the pass still reads it.
    const geomFrom = input.geomFrom ? new Map(input.geomFrom.map((e) => [e.uuid, e])) : null
    if (geomFrom)
      emit('log', [`Depth maps: geometric-consistency pass over ${pluralize(order.length, 'map')}`, 'info', 'Dense'])
    // Neighbours' first-pass depth planes, read on demand; neighbouring captures share most
    // sources, so the most recent DENSE_TUNING.geomDepthCache are kept.
    const srcDepthCache = new Map()
    const firstPassDepth = async (uuid) => {
      const entry = geomFrom.get(uuid)
      if (!entry) return null
      let d = srcDepthCache.get(uuid)
      if (d) {
        srcDepthCache.delete(uuid)
      } else {
        d = (await readDepthOnly(entry)).depth
        while (srcDepthCache.size >= DENSE_TUNING.geomDepthCache)
          srcDepthCache.delete(srcDepthCache.keys().next().value)
      }
      srcDepthCache.set(uuid, d)
      return d
    }
    {
      // A slow GPU (an integrated one): its second map (the first pays the shader's
      // compilation and the band sizing) took over DENSE_TUNING.gpuProbeMs, so the next is
      // computed on the CPU to compare, per pixel and source view, and the run goes on with
      // the faster; the verdict holds for this device for the rest of the session. Only
      // where the CPU path has its threads (a cross-origin isolated page): on one core it
      // would rarely win, and the bands keep a slow GPU from freezing the screen anyway.
      // `bk.probe`: { gpuMsPerUnit, gpu } while the CPU map is under way.
      const canProbe =
        cpuThreads > 1 && globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined'
      // A finished map's filtering, statistics, preview and hand-over run while the next
      // map matches (on the GPU the worker's thread is mostly waiting): chained, so maps
      // leave in order, and pausing between their loops so the next map's GPU bands keep
      // being submitted. They used to leave the GPU idle, 20–30 % of the depth stage. At
      // most one map waits for it: map k+1 starts once map k−1's is done.
      let postChain = Promise.resolve(),
        postBehind = Promise.resolve(),
        postError = null
      const pause = () => new Promise((resolve) => setTimeout(resolve, 0))
      for (let k = 0; k < total; k++) {
        await postBehind
        if (postError) throw postError
        const i = order[k]
        const img = images[i]
        if (k > 0) updateLoopShare(k)
        emit('progress', [k, total, img.name, loopFraction(k)])

        const srcUuids = srcUuidsByImg.get(i)
        if (srcUuids.length === 0) {
          emit('log', [`Depth maps: ${img.name} skipped (no overlapping views)`, 'warn', 'Dense'])
          releaseAfter(i)
          continue
        }
        const imgBestK = autoBestKMode ? autoBestK(srcUuids.length) : bestK

        const { r: rRef, gray: refGray, mask: refMask } = await ready(img)
        const ref = {
          gray: refGray,
          width: rRef.width,
          height: rRef.height,
          K: scaleK(paddedK(img.K, rRef), gridScale(rRef)),
          cam: { R: img.R, t: img.t },
        }
        const sources = []
        for (const u of srcUuids) {
          const s = imageByUuid.get(u)
          const { r: rs, gray: srcGray, mask: srcMask } = await ready(s)
          // Source masks (film frame / fiducials) must be excluded from the ZNCC match,
          // not just from the reference's own depth: otherwise a reference pixel finds a
          // spurious low-cost match against a neighbour's high-contrast border, leaking
          // those edges into the depth map. Build the LUT at the source's working size.
          // The mask is drawn in scan space; move it the same way the raster moved —
          // the film scan→canonical warp, or the plain distortion map.
          // A widened fisheye canvas also excludes its pixels off the photo.
          sources.push({
            gray: srcGray,
            w: rs.width,
            h: rs.height,
            K: scaleK(paddedK(s.K, rs), gridScale(rs)),
            cam: { R: s.R, t: s.t },
            mask: srcMask,
          })
        }

        // The next map's images decode and warp while this one matches.
        prefetch(k + 1)
        // Always stream depthMapForImage's own log (coarse-to-fine plan, debug level).
        const logHooks = {
          onLog: (m, l, c) => emit('log', [`${img.name}: ${m}`, l, c]),
          // Fractional within-image progress (0..1 across pyramid levels), folded into
          // the per-image emit so the bar glides through a minute-long WASM image.
          onProgress: (f) => emit('progress', [k + f, total, img.name, loopFraction(k + f)]),
        }
        // The run's per-image settings: GPU or CPU decide the view selection and threads.
        const settingsFor = (backend) => ({
          window,
          iterations,
          bestK: imgBestK,
          coarseLong,
          region: settings.region ?? null,
          bilateralSigmaColor: settings.bilateralSigmaColor,
          bilateralSigmaSpatial: settings.bilateralSigmaSpatial,
          viewSelection: resolveViewSelection(settings.viewSelection, !!backend),
          windowStep: settings.windowStep,
          threads: backend ? 0 : cpuThreads,
          planarPrior: settings.planarPrior,
          priorMaxCost: settings.priorMaxCost,
          priorIterations: settings.priorIterations,
        })
        const { dm, imgMs } = await depthMapOnBackend(bk, {
          k,
          total,
          img,
          ref,
          sources,
          sparsePos: sparse.pos,
          srcUuids,
          settingsFor,
          logHooks,
          geomInputs: geomFrom
            ? async () => {
                const entry = geomFrom.get(img.uuid)
                const ph = entry ? await readDepthFiles(entry) : null
                const srcDepth = await Promise.all(srcUuids.map(firstPassDepth))
                return { ph, srcDepth }
              }
            : null,
          canProbe,
          settings,
          emit,
        })
        if (!dm) {
          emit('log', [`Depth maps: ${img.name} skipped (no sparse depth support)`, 'warn', 'Dense'])
          releaseAfter(i)
          continue
        }
        const finishMap = async () => {
          // The thread time this takes, not the pauses (the "filtering + previews" figure).
          let tSeg = performance.now()
          const yieldNow = async () => {
            prepMs.post += performance.now() - tSeg
            await pause()
            tSeg = performance.now()
          }
          const { map, planes, cs } = await finishDepthMap(
            dm,
            { img, rRef, refMask, ref, srcUuids, imgBestK, imgMs },
            { speckleFilter, filterRadius, filterRelTol, emit, yieldNow },
          )
          perImage.push({
            ms: imgMs,
            coveragePct: (100 * cs.valid) / dm.depth.length,
            costMedian: cs.median,
          })
          pxDone += dm.width * dm.height
          prepMs.post += performance.now() - tSeg
          if (streamMaps) {
            emit('map', [map], planes)
            streamed++
            const tWait = performance.now()
            if (input.settings?.ackToken) await untilSaved(input.settings.ackToken, streamed)
            prepMs.saveWait += performance.now() - tWait
          } else {
            maps.push(map)
            transfer.push(...planes)
          }
          releaseAfter(i) // evict rasters this image was the last consumer of
        }
        postBehind = postChain
        postChain = postChain.then(finishMap).catch((err) => {
          postError ??= err
        })
      }
      await postChain
      if (postError) throw postError
    }

    emit('log', [
      `Depth maps: ${streamMaps ? streamed : maps.length}/${total} computed in ${((performance.now() - t0) / 1000).toFixed(1)}s; ` +
        `raster cache peak ${formatBytes(ledger.peak())}`,
      'success',
      'Dense',
    ])
    if (input.settings?.ackToken) acks.delete(input.settings.ackToken)
    const sec = (ms) => `${(ms / 1000).toFixed(1)} s`
    emit('log', [
      `Depth maps: time — matching ${sec(perImage.reduce((a, p) => a + p.ms, 0))}, rasters decoded + warped ` +
        `${sec(prepMs.raster)}, masks ${sec(prepMs.mask)}, grey planes ${sec(prepMs.gray)} ` +
        `(of the preparation, ${sec(prepMs.waited)} not hidden behind matching), ` +
        `filtering + previews ${sec(prepMs.post)}` +
        (prepMs.saveWait > 1000 ? `, waiting for saves ${sec(prepMs.saveWait)}` : ''),
      'info',
      'Dense',
    ])

    // Cross-view geometric consistency — the only filter that sees sky/vegetation for
    // what it is (both have high NCC; only their cross-view *disagreement* gives them
    // away). Runs here, after the loop, because it needs every map's depth at once; it
    // zeroes rejected pixels in `maps`, so what we persist and hand to the ortho is the
    // filtered plane. The display PNGs above were rendered pre-filter and are only a
    // preview, so they intentionally still show the raw plane.
    let geomFilterMs = null
    if (geomConsistency && maps.length && !streamMaps) {
      updateLoopShare(total)
      const LOOP_SHARE = loopShare
      const loopMs = performance.now() - tLoop
      emit('progress', [0, maps.length, 'Filtering depth maps…', LOOP_SHARE])
      const tFilt = performance.now()
      filterDepthMapsGeometric(
        maps,
        { maxGeomCost, minConsistent, minNcc, minGeomAngleDeg },
        (m, l, c) => emit('log', [m, l, c]),
        {
          onProgress: (d, t, lbl) =>
            emit('progress', [d, t, `Cross-view filter: ${lbl}`, LOOP_SHARE + (1 - LOOP_SHARE) * (t > 0 ? d / t : 0)]),
        },
      )
      const marginal = maps.filter((m) => (m.filterStats?.considered ?? 0) > 0 && m.filterStats.keptPct < 1)
      if (marginal.length) {
        const names = marginal
          .slice(0, 12)
          .map((m) => `${m.name || m.uuid} ${m.filterStats.keptPct.toFixed(1)}%`)
          .join('; ')
        emit('log', [
          `Depth filter: ${pluralize(marginal.length, 'marginal map')} kept <1% after cross-view filtering — ` +
            `${names}${marginal.length > 12 ? `; +${marginal.length - 12} more` : ''}. ` +
            'They remain cached for diagnostics/orthophoto use but will contribute little to fusion.',
          'warn',
          'Dense',
        ])
      }
      geomFilterMs = performance.now() - tFilt
      // Measured vs modelled, so DENSE_TUNING.geomFilterUsPerPx can be retuned from runs.
      const usPerPx = pxDone > 0 ? (geomFilterMs * 1000) / pxDone : 0
      emit('log', [
        `Depth filter: cross-view consistency in ${(geomFilterMs / 1000).toFixed(1)}s ` +
          `(${usPerPx.toFixed(2)} µs/px; ${((100 * geomFilterMs) / (geomFilterMs + loopMs)).toFixed(0)}% of Stage A, ` +
          `progress bar gave it ${(100 * (1 - LOOP_SHARE)).toFixed(0)}%)`,
        'info',
        'Dense',
      ])
    }

    // Streaming: the caller's filter pass owns the rest of the bar, from `loopShare`.
    if (!streamMaps) emit('progress', [total, total, 'Depth maps complete', 1])
    // Stage A summary — settings + throughput + the cross-view filter's cost and bite.
    // Persisted by the store (reconstruction.json) so a dense baseline survives a reload.
    const med = (vals) => {
      if (!vals.length) return null
      const s = [...vals].sort((a, b) => a - b)
      return s[Math.min(s.length - 1, Math.round(0.5 * (s.length - 1)))]
    }
    const filterKept = maps.map((m) => m.filterStats?.keptPct).filter((v) => v != null)
    const summary = {
      date: new Date().toISOString(),
      nMaps: streamMaps ? streamed : maps.length,
      nImages: total,
      backend: startedOnGpu ? (bk.gpuFallbacks ? 'gpu→wasm' : 'gpu') : 'wasm',
      gpuRequested: !!settings.useGpu,
      gpuFallbacks: bk.gpuFallbacks,
      settings: {
        quality: settings.quality ?? null,
        maxDim,
        maxSources,
        window,
        iterations,
        bestK: autoBestKMode ? 'auto' : bestK,
        viewSelection: resolveViewSelection(settings.viewSelection, startedOnGpu),
        planarPrior: !!settings.planarPrior,
        geomPass: !!settings.geomPass,
        speckleFilter: !!speckleFilter,
        geomConsistency: !!geomConsistency,
        maxGeomCost: geomConsistency ? maxGeomCost : null,
        minConsistent: geomConsistency ? minConsistent : null,
        minNcc: geomConsistency ? minNcc : null,
        minGeomAngleDeg: geomConsistency ? minGeomAngleDeg : null,
      },
      medianMsPerImage: med(perImage.map((p) => p.ms)),
      totalMs: performance.now() - t0,
      medianCoveragePct: med(perImage.map((p) => p.coveragePct)),
      medianCostMedian: med(perImage.map((p) => p.costMedian)),
      geomFilterMs,
      // Post-filter survival: the DF item needs both the cost of the pass and how
      // much it actually removed, per map rather than as one blended figure.
      geomFilterMedianKeptPct: med(filterKept),
      geomFilterMinKeptPct: filterKept.length ? Math.min(...filterKept) : null,
      geomFilterMarginalMaps: filterKept.filter((v) => v < 1).length,
      projectedPeakBytes: proj.total,
      budgetBytes: budget,
      streamed: !!streamMaps,
    }
    // Streaming: the bar share the cross-view filter pass should take over from.
    if (geomConsistency && streamMaps) updateLoopShare(total)
    return { result: { maps, summary, perImage, loopShare: streamMaps && geomConsistency ? loopShare : 1 }, transfer }
  }

  // The cross-view consistency filter over SAVED depth maps: file handles in, read on
  // demand (reference: depth + cost; candidates: depth, through a byte-bounded LRU).
  // Judges every map against the unfiltered planes first, then emits each filtered
  // depth plane as a 'filtered' event for the caller to write back. Same verdicts as
  // the in-memory pass (core/dense/mvs.js filterDepthMapsGeometricStreamed).
  //   input: { maps: [entry with files], settings, from } — `from` is where Stage A's
  //   loop left the progress bar.
  // `refs` (a subset of map indices) and `workers` (how many such calls run at once)
  // split one filter over the pool: each call judges its own maps with a 1/workers share
  // of the cache budget and returns their masks, WITHOUT writing anything — the other
  // calls are still reading these maps' unfiltered planes as candidates (and a File read
  // after its file was rewritten fails as NotReadable). Once every call has judged, the
  // caller sends the masks back (`apply`: { refs, masks }) to be applied and emitted.
  async function filterDepthMaps([input], { emit }) {
    const { maps: entries, settings = {}, from = 0, refs = null, workers = 1, apply = null } = input
    if (apply) {
      for (let k = 0; k < apply.refs.length; k++) {
        const i = apply.refs[k]
        const depth = applyPackedMask((await readDepthOnly(entries[i])).depth, apply.masks[k])
        emit(
          'filtered',
          [{ uuid: entries[i].uuid, depth, coverage: depthCoverage(depth), filterStats: apply.stats?.[k] }],
          [depth.buffer],
        )
        emit('progress', [k + 1, apply.refs.length, 'Writing filtered depth maps…'])
      }
      return { result: { written: apply.refs.length }, transfer: [] }
    }
    const partial = !!refs
    const opts = {
      ...filterSettings(settings),
      // A share of the run's memory budget for cached candidate planes.
      cacheBytes:
        Math.max(64 * 1024 ** 2, Math.min(2 * 1024 ** 3, (settings.memBudgetBytes || DEFAULT_BUDGET_BYTES) / 4)) /
        workers,
      ...(partial ? { refs, summaryLogs: false } : {}),
    }
    const metas = entries.map(({ files: _files, ...meta }) => meta)
    const judgeShare = 0.9 // judging dominates; writing back is one read + one write per map
    const at = (f) => from + (1 - from) * f
    const t0 = performance.now()
    const io = {
      loadReference: (i) => readDepthAndCost(entries[i]),
      loadDepth: async (i) => (await readDepthOnly(entries[i])).depth,
    }
    const own = refs ?? entries.map((_, i) => i)
    emit('progress', [0, own.length, 'Filtering depth maps…', at(0)])
    const { masks, stats, totals, loads, hits, nCand } = await filterDepthMapsGeometricStreamed(
      metas,
      io,
      opts,
      (m, l, c) => emit('log', [m, l, c]),
      {
        onProgress: (d, t, lbl) =>
          emit('progress', [d, t, `Cross-view filter: ${lbl}`, at(judgeShare * (t > 0 ? d / t : 0))]),
      },
    )
    const judgeMs = performance.now() - t0
    if (partial) {
      const own = refs.map((i) => masks[i])
      return {
        result: {
          stats,
          totals,
          loads,
          hits,
          nCand,
          judgeMs,
          ms: performance.now() - t0,
          cacheBytes: opts.cacheBytes,
          masks: own,
        },
        transfer: own.map((m) => m.buffer),
      }
    }
    for (let k = 0; k < own.length; k++) {
      const i = own[k]
      const depth = applyPackedMask((await readDepthOnly(entries[i])).depth, masks[i])
      masks[i] = null
      emit(
        'filtered',
        [{ uuid: entries[i].uuid, depth, coverage: depthCoverage(depth), filterStats: stats[i] }],
        [depth.buffer],
      )
      emit('progress', [
        k + 1,
        own.length,
        'Writing filtered depth maps…',
        at(judgeShare + ((1 - judgeShare) * (k + 1)) / own.length),
      ])
    }
    const marginal = metas.map((m, i) => ({ m, s: stats[i] })).filter(({ s }) => s.considered > 0 && s.keptPct < 1)
    if (marginal.length) {
      const names = marginal
        .slice(0, 12)
        .map(({ m, s }) => `${m.name || m.uuid} ${s.keptPct.toFixed(1)}%`)
        .join('; ')
      emit('log', [
        `Depth filter: ${pluralize(marginal.length, 'marginal map')} kept <1% after cross-view filtering — ` +
          `${names}${marginal.length > 12 ? `; +${marginal.length - 12} more` : ''}. ` +
          'They remain cached for diagnostics/orthophoto use but will contribute little to fusion.',
        'warn',
        'Dense',
      ])
    }
    const ms = performance.now() - t0
    let px = 0
    for (const m of metas) px += m.width * m.height
    emit('log', [
      `Depth filter: cross-view consistency in ${(ms / 1000).toFixed(1)}s (streamed from saved maps; ` +
        `${((judgeMs * 1000) / Math.max(1, px)).toFixed(2)} µs/px judging)`,
      'info',
      'Dense',
    ])
    emit('progress', [entries.length, entries.length, 'Depth maps complete', 1])
    return { result: { stats, totals, ms }, transfer: [] }
  }

  // Stage B — Build Point Cloud (dense). Fuses the depth maps from Stage A into a
  // single coloured point cloud (pure compute in core/dense/mvs.js).
  // Parallel fusion over saved maps (the store drives it): `mode: 'plan'` runs the
  // pre-passes and returns the slab plan; `mode: 'slab'` fuses one slab of `plan` and
  // returns it in the cloud's layout with its counters. Without a mode, one call does
  // it all (with `settings.plan`, it skips the pre-passes).
  // A split plan's pre-passes (`splitPlan`): the plan asks for each one as a batch, which
  // goes to the page as a 'batch' event; the page runs it over the pool (`mode:
  // 'prepass'`, this worker included — its plan call is waiting meanwhile) and hands the
  // parts back through fusePlanAnswer.
  const planBatches = new Map() // token → resolve
  let planBatchSeq = 0
  function fusePlanAnswer([token, parts]) {
    planBatches.get(token)?.(parts)
    planBatches.delete(token)
    return { result: true }
  }
  async function densify([input], { emit }) {
    const { maps, streamed = false, settings = {}, mode = null, plan = null, slab = null } = input
    if (mode) {
      const log = (m, l, c) => emit('log', [m, l, c])
      const load = (i) => readDepthFiles(maps[i])
      const loadDepth = (i) => readDepthOnly(maps[i])
      const loadLight = (i) => readDepthCostMap(maps[i])
      if (mode === 'prepass') {
        // One share of a pre-pass: its maps' light planes, one at a time.
        const { batch, refs } = input
        const it = fusionPrepassSteps(maps, refs, batch.batch, batch.params)
        let r = it.next()
        while (!r.done) r = it.next(await loadLight(r.value.light))
        return { result: r.value, transfer: [] }
      }
      if (mode === 'plan') {
        const runBatch = input.splitPlan
          ? (request) =>
              new Promise((resolve, reject) => {
                const token = `${++planBatchSeq}`
                planBatches.set(token, (parts) =>
                  parts?.error ? reject(new Error(`fusion plan: ${parts.error}`)) : resolve(parts),
                )
                emit('batch', [token, request])
              })
          : undefined
        const res = await fuseDepthMapsStreamed(maps, load, { ...settings, planOnly: true }, log, {
          loadDepth,
          loadLight,
          runBatch,
          onPlanProgress: (d, t, lbl, f) => emit('progress', [d, t, lbl, f, 'plan']),
        })
        return {
          result: res.refused ? { plan: null, refused: res.refused } : { plan: res, refused: null },
          transfer: [],
        }
      }
      const parts = []
      const run = await fuseDepthMapsStreamed(maps, load, { ...settings, plan, slabIndices: [slab] }, log, {
        loadDepth,
        loadLight,
        onTile: (p) => parts.push(p),
        onProgress: (d, t, lbl) => emit('progress', [d, t, lbl, undefined, 'fuse']),
      })
      const part = parts[0]
      return {
        result: { part, counters: run.counters, stream: run.stream },
        transfer: [part.pos.buffer, part.col.buffer, part.nrm.buffer],
      }
    }
    const total = Math.max(1, maps.length)
    emit('progress', [0, total, 'Fusing depth maps…'])
    const tFuse = performance.now()
    // fuseDepthMaps streams kept pixels straight into the voxel merge and returns the
    // packed flat buffer [x,y,z,r,g,b] per point — no per-point object list (the OOM).
    const fuse = streamed
      ? (ms, options, log, hooks) =>
          fuseDepthMapsStreamed(ms, (i) => readDepthFiles(ms[i]), options, log, {
            ...hooks,
            loadDepth: (i) => readDepthOnly(ms[i]),
            loadLight: (i) => readDepthCostMap(ms[i]),
          })
      : fuseDepthMaps
    // Each finished slab (one, unless fusion tiles to fit the budget) comes in the
    // cloud's own layout, its accumulator already released; the slabs are joined at the end.
    // The plan's pre-passes take the first FUSION_PLAN_SHARE of the bar, the slabs the
    // rest (a plan handed in has already been run: its share is filled at once). Each
    // event names its phase, so the progress modal times the two apart.
    const parts = []
    const share = settings.plan ? 0 : FUSION_PLAN_SHARE
    const flat = await fuse(maps, settings, (m, l, c) => emit('log', [m, l, c]), {
      onPlanProgress: (d, t, lbl, f) => emit('progress', [d, t, lbl, share * f, 'plan']),
      onProgress: (d, t, lbl) => emit('progress', [d, t, lbl, share + (1 - share) * (t > 0 ? d / t : 0), 'fuse']),
      onTile: (p) => parts.push(p),
    })
    const cloud = joinCloudParts(parts)
    const nPoints = cloud.count
    // The fusion pre-flight refused (already logged with its numbers): no cloud, but
    // the transferred planes still go home below.
    if (!flat.refused)
      emit('log', [
        `Dense cloud: fused ${maps.length} depth maps → ${nPoints} points ` +
          `in ${((performance.now() - tFuse) / 1000).toFixed(1)}s` +
          (nPoints === 0
            ? ' — no pixels survived cross-view consistency; check intrinsics/distortion, Quality, or fusion gates (maxCost / minViews / parallax)'
            : ''),
        nPoints === 0 ? 'error' : 'success',
        'Dense',
      ])
    emit('progress', [total, total, 'Done'])
    // The store transfers each map's depth/cost/rgb/normals buffers in (no clone), so
    // return them so they round-trip home and the store can re-attach them to its
    // depthMaps cache (ortho reuses them). dims/K/R/t never left the main thread.
    const mapBuffers = (streamed ? [] : maps).map((m) => ({
      uuid: m.uuid,
      depth: m.depth,
      cost: m.cost,
      rgb: m.rgb,
      normals: m.normals || null,
    }))
    const transfer = [cloud.pos.buffer, cloud.col.buffer, cloud.nrm.buffer]
    for (const m of streamed ? [] : maps) {
      transfer.push(m.depth.buffer, m.cost.buffer, m.rgb.buffer)
      if (m.normals) transfer.push(m.normals.buffer)
    }
    return { result: { cloud, summary: flat.summary ?? null, refused: flat.refused ?? null, mapBuffers }, transfer }
  }

  return { depthBackend, computeDepthMaps, depthAck, filterDepthMaps, densify, fusePlanAnswer }
}

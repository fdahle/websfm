import { readDepthFiles, readDepthOnly } from '../../core/dense/depthFileReader.js'
import {
  selectSourceViews, scaleK, rgbaToGray, depthMapForImage, fuseDepthMaps, fuseDepthMapsStreamed, filterDepthMap,
  filterDepthMapsGeometric, geomFilterLoopShare, autoBestK,
} from '../../core/dense/mvs.js'
import { buildMaskLookup } from '../../core/mask.js'
import { hasDistortion } from '../../core/sfm/distortion.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import {
  resampleRgba, resampleMaskLut, pinholeFrameSize,
} from '../../core/products/undistort.js'
import { depthColor } from '../../core/products/colormap.js'
import { isGpuAvailable, ensureDevice } from '../gpu/device.js'
import { computeDepthMapGPU } from '../gpu/depthMapGpu.js'
import {
  createMemLedger, projectDensePeakBytes, formatBytes, DEFAULT_BUDGET_BYTES,
} from '../../core/dense/memBudget.js'

// Dense MVS ops (Stage A depth maps + Stage B fusion). `rasterize` (OffscreenCanvas
// pixel decode) is injected; the raster-space helpers (undistortion, RGB packing,
// depth-map colourising) live here next to the two dense handlers. The GPU backend
// swap + first-image GPU↔CPU A/B validation live inside computeDepthMaps.
export function makeDenseOps({ rasterize }) {
  // ── Raster → pinhole frame ──────────────────────────────────────────────────
  // Every raster dense reads must live in the same pinhole frame as the sparse
  // cloud: distortion folded out, and for a film scan the scan→canonical affine
  // applied too. The *map* comes from core/sfm/displayFrame.js `makeSampleMap`
  // (one composition, shared with the image view's residual overlay and the
  // undistorted-image export) and the *resampling* from core/products/undistort.js.
  // Dense supplies the two scale factors because it works at reduced resolution.

  // Any distortion to remove (calibrated OR self-calibrated)?
  function hasAnyDistortion(dist, selfCal) {
    return hasDistortion(dist) || hasDistortion(selfCal)
  }

  // Remove lens distortion from a working-resolution raster. Kfull is the
  // native-resolution K; output and source share the working grid, so both scales
  // are `r.scale`. A no-op when both bags are empty — that early return is what
  // keeps the common EXIF-only case free (a pure scale change is still a real map).
  function undistortRaster(r, Kfull, dist, selfCal) {
    if (!hasAnyDistortion(dist, selfCal)) return r
    const map = makeSampleMap({ K: Kfull, dist, selfCal, outScale: r.scale, srcScale: r.scale })
    return { ...r, data: resampleRgba(r, map, r.width, r.height) }
  }

  // The same map, nearest sample, so a distorted-space mask lines up with the
  // now-undistorted raster.
  function undistortMaskLut(lut, w, h, Kfull, dist, scale, selfCal) {
    if (!hasAnyDistortion(dist, selfCal)) return lut
    const map = makeSampleMap({ K: Kfull, dist, selfCal, outScale: scale, srcScale: scale })
    return resampleMaskLut(lut, w, h, map, w, h)
  }

  // ── Film scan → canonical warp (F4) ─────────────────────────────────────────
  // A film image's sparse cameras use the canonical K, so its dense reference
  // raster must live in the canonical pixel frame too. We warp the scan raster
  // into that frame with the SAME transform chain the sparse ingest applied, only
  // inverted (output canonical px → sample the scan). The canonical working grid
  // is sized so its long side ≈ maxDim (matching non-film rasters). Returns a
  // raster carrying what the mask warp needs (scanDims, fid, canonK, dist).
  function filmSampleMap(canonK, dist, fid, cScale, scanScale, selfCal) {
    return makeSampleMap({
      K: canonK, dist, selfCal, fiducial: fid, outScale: cScale, srcScale: scanScale,
    })
  }

  function warpFilmRaster(r, canonK, dist, fid, maxDim, selfCal) {
    const { width: sw, height: sh, scale: scanScale } = r
    const { frame } = fid
    const cScale = maxDim / Math.max(frame.width, frame.height)
    const { width: ow, height: oh } = pinholeFrameSize({ fiducial: fid, scale: cScale })
    const useDist = hasDistortion(dist) ? dist : null
    const useSelf = hasDistortion(selfCal) ? selfCal : null
    const map = filmSampleMap(canonK, useDist, fid, cScale, scanScale, useSelf)
    return {
      data: resampleRgba(r, map, ow, oh), width: ow, height: oh, scale: cScale,
      fid, canonK, dist: useDist, selfCal: useSelf, scanDims: { w: sw, h: sh, scale: scanScale },
    }
  }

  // Warp a scan-space mask LUT (built at scan working size) into the canonical
  // working grid of raster `r` (a warpFilmRaster output). Nearest sample.
  async function filmMaskLut(maskDataUrl, r) {
    const sd = r.scanDims
    const scanLut = await buildMaskLookup(maskDataUrl, sd.w, sd.h)
    const map = filmSampleMap(r.canonK, r.dist, r.fid, r.scale, sd.scale, r.selfCal)
    return resampleMaskLut(scanLut, sd.w, sd.h, map, r.width, r.height)
  }

  // Extract a tightly-packed RGB buffer (drop alpha) from RGBA pixels.
  function rgbFromRgba(data, w, h) {
    const rgb = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      rgb[i*3] = data[i*4]; rgb[i*3+1] = data[i*4+1]; rgb[i*3+2] = data[i*4+2]
    }
    return rgb
  }

  // Render a depth plane to a colourized PNG data URL for the image viewer's depth
  // overlay. Valid depths are normalised to a blue→red ramp (near = red); holes
  // are transparent so the underlying image shows through.
  async function depthToDataUrl(depth, w, h) {
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < depth.length; i++) {
      const d = depth[i]
      if (d > 0) { if (d < lo) lo = d; if (d > hi) hi = d }
    }
    const span = hi > lo ? hi - lo : 1
    const img = new ImageData(w, h)
    for (let i = 0; i < w * h; i++) {
      const d = depth[i]
      const o = i * 4
      if (d > 0) {
        // Near = warm (t→1), far = cool (t→0).
        const t = 1 - (d - lo) / span
        const [r, g, b] = depthColor(t)
        img.data[o] = r; img.data[o+1] = g; img.data[o+2] = b; img.data[o+3] = 255
      } else {
        img.data[o] = 0; img.data[o+1] = 0; img.data[o+2] = 0; img.data[o+3] = 0
      }
    }
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d').putImageData(img, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return await new Promise((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.readAsDataURL(blob)
    })
  }

  // Stage A — Build Depth Maps. Rasterises each registered image (and its source
  // neighbours), runs PatchMatch MVS, and returns one depth map per reference image
  // (raw depth/cost planes + colours for fusion, plus a display PNG). Pure compute
  // lives in core/dense/mvs.js; pixel decoding is worker-only (OffscreenCanvas).
  async function computeDepthMaps([input], { emit }) {
    const { images, points, settings = {} } = input
    const {
      maxDim = 800, maxSources: maxSourcesReq = 6, minAngleDeg = 3, window = 3, iterations = 3, bestK = null,
      speckleFilter = true, filterRadius = 1, filterRelTol = 0.1, coarseLong = 600,
      geomConsistency = true, maxGeomCost, minConsistent, minNcc,
    } = settings
    // The GPU kernel packs sources into a fixed MAX_SRC=16 array and silently drops
    // any beyond that (depthMapGpu.js), while the WASM path + the first-image A/B
    // validation use every source. Clamp here so both backends see the same source
    // count — otherwise >16 sources makes GPU vs WASM diverge and trips a spurious
    // A/B RMS warning.
    const maxSources = Math.min(16, maxSourcesReq)
    // Auto best-K per image (Step 3) when the user hasn't overridden it: derive from
    // that image's source count (clamp(ceil(nSources/2),1,4)) rather than a fixed 3.
    const autoBestKMode = !(bestK > 0)

    // Median / p95 of an array (for cost distributions). Mutates a copy.
    const stat = (arr) => {
      if (!arr.length) return { median: 0, p95: 0 }
      const s = [...arr].sort((a, b) => a - b)
      const at = (q) => s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]
      return { median: at(0.5), p95: at(0.95) }
    }

    const t0 = performance.now()
    emit('log', [`Depth maps: ${images.length} image(s) — working ≤${maxDim}px, `
      + `≤${maxSources} sources (best-${autoBestKMode ? 'auto' : bestK}), window ${window} (${2 * window + 1}×${2 * window + 1}), `
      + `${iterations} PatchMatch iters`, 'info', 'Dense'])

    // Backend selection: opt into the (experimental) WebGPU path with settings.useGpu;
    // anything that prevents it (no WebGPU, no adapter) silently keeps the WASM path.
    // `backend = undefined` ⇒ depthMapForImage uses its WASM default.
    let backend
    if (settings.useGpu && isGpuAvailable()) {
      const state = await ensureDevice()
      if (state) {
        backend = computeDepthMapGPU
        const id = [...new Set([state.info?.vendor, state.info?.architecture || state.info?.description]
          .filter(Boolean))].join(' ')
        emit('log', [`Depth maps: backend = WebGPU${id ? ` (${id})` : ''}`
          + `${state.isFallback ? ' [software adapter]' : ''} — multi-source PatchMatch (experimental)`,
          'warn', 'Dense'])
      } else {
        emit('log', ['Depth maps: GPU requested but no adapter — using WASM (CPU)', 'warn', 'Dense'])
      }
    }
    if (!backend) emit('log', ['Depth maps: backend = WASM (CPU)', 'info', 'Dense'])
    // Stage A run record. `backend` above can flip to WASM mid-run on a GPU error, so
    // the record tracks what was *requested*, what it started on, and how many images
    // fell back — "all 86 maps remained on GPU" is a target in TODO ▸ SB and is
    // unanswerable from a summary that only reports the final value.
    const startedOnGpu = !!backend
    let gpuFallbacks = 0
    const perImage = [] // { ms, coveragePct, costMedian }

    const cameras = new Map(images.map((im) => [im.uuid, { R: im.R, t: im.t, K: im.K }]))

    // Pre-flight memory budget (Step 5): project the peak allocation and refuse to
    // start when it exceeds the budget, rather than letting the browser OOM-kill the
    // tab mid-run (Safari can't be observed or intercepted). Working dims use the
    // maxDim² upper bound; source count uses maxSources.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    const proj = projectDensePeakBytes({
      nImages: images.length, maxDim, nSources: maxSources, backend: backend ? 'gpu' : 'wasm',
    })
    emit('log', [`Dense: projected peak memory ≈ ${formatBytes(proj.total)} `
      + `(store ${formatBytes(proj.store)} + raster ${formatBytes(proj.raster)}`
      + `${proj.gpu ? ` + GPU ${formatBytes(proj.gpu)}` : ''}) vs budget ${formatBytes(budget)}`,
      proj.total > budget ? 'error' : 'info', 'Dense'])
    if (proj.total > budget) {
      emit('log', ['Dense: aborting before start — projected memory exceeds the budget. '
        + 'Lower Quality (e.g. Medium) or raise the memory budget, then retry.', 'error', 'Dense'])
      throw new Error(`dense pre-flight: projected ${formatBytes(proj.total)} exceeds budget ${formatBytes(budget)}`)
    }

    // Precompute each image's source views once (also drives the raster refcounts),
    // so the cache can evict a raster the moment it's no longer needed — keeping the
    // resident working set small instead of holding every image's pixels at once.
    const srcUuidsByImg = images.map((img) =>
      selectSourceViews(cameras, points, img.uuid, { maxSources, minAngleDeg }))
    const urlByUuid = new Map(images.map((im) => [im.uuid, im.url]))
    // Per-url intrinsics + distortion, so getRaster can undistort each source once
    // (url↔image is 1:1, and undistortion is independent of ref/source role).
    const metaByUrl = new Map(images.map((im) =>
      [im.url, { K: im.K, dist: im.dist || null, selfCal: im.selfCal || null, fid: im.fid || null }]))
    const usedSets = srcUuidsByImg.map((srcUuids, i) => {
      const set = new Set([images[i].url])
      for (const u of srcUuids) { const url = urlByUuid.get(u); if (url) set.add(url) }
      return set
    })
    const useCount = new Map()
    for (const set of usedSets) for (const url of set) useCount.set(url, (useCount.get(url) || 0) + 1)

    const ledger = createMemLedger()
    const rasterCache = new Map() // url → { data, width, height, scale }
    const getRaster = async (url) => {
      if (!rasterCache.has(url)) {
        let r = await rasterize(url, maxDim)
        // Undistort at ingest so every dense consumer stays pinhole (mirrors sparse).
        const meta = metaByUrl.get(url)
        if (meta?.fid) {
          // Film scan: warp into the canonical frame (composes calibrated + self-cal).
          r = warpFilmRaster(r, meta.K, meta.dist, meta.fid, maxDim, meta.selfCal)
        } else if (meta?.dist || meta?.selfCal) {
          r = undistortRaster(r, meta.K, meta.dist, meta.selfCal)
        }
        rasterCache.set(url, r)
        ledger.track(`raster:${url}`, r.width * r.height * 4)
      }
      return rasterCache.get(url)
    }
    // Drop every raster this image was the last consumer of (decrement its remaining
    // uses; delete + untrack at zero). Runs on every path out of the loop body.
    const releaseAfter = (i) => {
      for (const url of usedSets[i]) {
        const c = (useCount.get(url) || 0) - 1
        useCount.set(url, c)
        if (c <= 0) { rasterCache.delete(url); ledger.release(`raster:${url}`) }
      }
    }

    const maps = []
    const transfer = []
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
      const s = geomFilterLoopShare({ loopMs: performance.now() - tLoop, done, total: images.length, pxDone })
      if (s != null) loopShare = s
    }
    const loopFraction = (v) => (images.length > 0 ? loopShare * (v / images.length) : 0)
    for (let i = 0; i < images.length; i++) {
      const img = images[i]
      if (i > 0) updateLoopShare(i)
      emit('progress', [i, images.length, img.name, loopFraction(i)])

      const srcUuids = srcUuidsByImg[i]
      if (srcUuids.length === 0) {
        emit('log', [`Depth maps: ${img.name} skipped (no overlapping views)`, 'warn', 'Dense'])
        releaseAfter(i)
        continue
      }
      const imgBestK = autoBestKMode ? autoBestK(srcUuids.length) : bestK

      const rRef = await getRaster(img.url)
      const ref = {
        gray: rgbaToGray(rRef.data, rRef.width, rRef.height),
        width: rRef.width, height: rRef.height,
        K: scaleK(img.K, rRef.scale),
        cam: { R: img.R, t: img.t },
      }
      const sources = []
      for (const u of srcUuids) {
        const s = images.find((im) => im.uuid === u)
        const rs = await getRaster(s.url)
        // Source masks (film frame / fiducials) must be excluded from the ZNCC match,
        // not just from the reference's own depth: otherwise a reference pixel finds a
        // spurious low-cost match against a neighbour's high-contrast border, leaking
        // those edges into the depth map. Build the LUT at the source's working size.
        // The mask is drawn in scan space; move it the same way the raster moved —
        // the film scan→canonical warp, or the plain distortion map.
        let srcMask = null
        if (s.mask) {
          if (rs.fid) srcMask = await filmMaskLut(s.mask, rs)
          else {
            srcMask = await buildMaskLookup(s.mask, rs.width, rs.height)
            if (s.dist || s.selfCal) srcMask = undistortMaskLut(srcMask, rs.width, rs.height, s.K, s.dist, rs.scale, s.selfCal)
          }
        }
        sources.push({
          gray: rgbaToGray(rs.data, rs.width, rs.height),
          w: rs.width, h: rs.height,
          K: scaleK(s.K, rs.scale),
          cam: { R: s.R, t: s.t },
          mask: srcMask,
        })
      }

      const tImg = performance.now()
      // Always stream depthMapForImage's own log (coarse-to-fine plan, debug level);
      // validate the GPU cost kernel against the CPU reference on the first image only.
      const hooks = {
        onLog: (m, l, c) => emit('log', [`${img.name}: ${m}`, l, c]),
        // Fractional within-image progress (0..1 across pyramid levels), folded into
        // the per-image emit so the bar glides through a minute-long WASM image.
        onProgress: (f) => emit('progress', [i + f, images.length, img.name, loopFraction(i + f)]),
        validate: backend && i === 0,
      }
      let dm
      try {
        dm = await depthMapForImage(ref, sources, points, { window, iterations, bestK: imgBestK, coarseLong, region: settings.region ?? null }, backend, hooks)
      } catch (err) {
        // A GPU failure mid-run must not abort the whole batch: log it, drop to WASM
        // for this image and every image after, and retry once on the CPU path.
        if (backend) {
          emit('log', [`Depth maps: GPU error on ${img.name} (${err?.message ?? err}) — falling back to WASM`,
            'warn', 'Dense'])
          backend = undefined
          gpuFallbacks++
          // Keep streaming the coarse-to-fine plan log on the retry (validate no
          // longer applies once we've dropped off the GPU path).
          dm = await depthMapForImage(ref, sources, points, { window, iterations, bestK: imgBestK, coarseLong, region: settings.region ?? null }, backend, { onLog: hooks.onLog, onProgress: hooks.onProgress })
        } else {
          throw err
        }
      }
      const imgMs = performance.now() - tImg
      if (!dm) {
        emit('log', [`Depth maps: ${img.name} skipped (no sparse depth support)`, 'warn', 'Dense'])
        releaseAfter(i)
        continue
      }
      // P2.1: invalidate "no measurement" pixels before filtering. A pixel no source
      // ever saw keeps its random init depth at the max cost 2.0; left in place, the
      // speckle filter's median mixes that junk into good neighbours. Zero its depth
      // so it reads as a hole (depth<=0) everywhere downstream.
      {
        let culled = 0
        for (let k = 0; k < dm.depth.length; k++) {
          if (dm.depth[k] > 0 && dm.cost[k] >= 1.99) { dm.depth[k] = 0; culled++ }
        }
        if (culled) emit('log', [`Depth maps: ${img.name} — invalidated ${culled} no-measurement px (cost≈2.0)`,
          'debug', 'Dense'])
      }
      // Median / speckle filter: clean per-image noise before the cross-view fusion
      // gate sees it (the per-image PatchMatch has no geometric consistency check).
      if (speckleFilter) {
        const { depth: fdepth, removed, smoothed } =
          filterDepthMap(dm.depth, dm.width, dm.height, { radius: filterRadius, relTol: filterRelTol })
        dm.depth = fdepth
        emit('log', [`Depth maps: ${img.name} — speckle filter dropped ${removed} px, smoothed ${smoothed}`,
          'debug', 'Dense'])
      }
      // Drop masked regions from the dense cloud: zero the depth there so fusion
      // (which treats depth <= 0 as "no data") skips those pixels.
      if (img.mask) {
        const maskLut = rRef.fid
          ? await filmMaskLut(img.mask, rRef)
          : await buildMaskLookup(img.mask, dm.width, dm.height)
        for (let k = 0; k < dm.depth.length; k++) if (maskLut[k]) dm.depth[k] = 0
      }
      const rgb = rgbFromRgba(rRef.data, rRef.width, rRef.height)
      const displayDataUrl = await depthToDataUrl(dm.depth, dm.width, dm.height)
      // F4: for film images the depth preview is in the canonical frame, not scan
      // space, so it won't line up with the scan in the viewer (v1 limitation).
      if (rRef.fid) {
        emit('log', [`Depth maps: ${img.name} — preview is in the canonical fiducial frame `
          + `(${dm.width}×${dm.height}), not scan space`, 'debug', 'Dense'])
      }
      // Per-pixel diagnostics: how many pixels got a depth, and the matching-cost
      // distribution over those pixels (low cost = confident; high = likely junk
      // that fusion's maxCost gate will drop — the key signal for dense quality).
      let valid = 0
      const costs = []
      for (let k = 0; k < dm.depth.length; k++) {
        if (dm.depth[k] > 0) { valid++; costs.push(dm.cost[k]) }
      }
      const cs = stat(costs)
      perImage.push({
        ms: imgMs,
        coveragePct: 100 * valid / dm.depth.length,
        costMedian: cs.median,
      })
      const seedPct = (100 * dm.seeded / dm.depth.length).toFixed(1)
      emit('log', [`Depth maps: ${img.name} — ${srcUuids.length} sources (best-${imgBestK}), ${dm.width}×${dm.height}, `
        + `depth ${dm.depthMin.toFixed(2)}–${dm.depthMax.toFixed(2)} (${dm.seeded} seeds, ${seedPct}%), `
        + `${(100 * valid / dm.depth.length).toFixed(0)}% with depth, `
        + `cost median ${cs.median.toFixed(2)} / p95 ${cs.p95.toFixed(2)}, ${(imgMs / 1000).toFixed(1)}s`,
        'info', 'Dense'])

      maps.push({
        uuid: img.uuid, name: img.name, width: dm.width, height: dm.height,
        K: ref.K, R: img.R, t: img.t,
        // Per-pixel converged plane normals (camera-frame, unit, nz<0). Kept
        // alongside depth for fusion → Poisson meshing. Holes are defined by
        // depth<=0 everywhere downstream, so stale normals under a zeroed depth are
        // harmless and deliberately NOT cleaned up.
        depth: dm.depth, cost: dm.cost, normals: dm.normals || null, rgb, displayDataUrl,
      })
      pxDone += dm.width * dm.height
      transfer.push(dm.depth.buffer, dm.cost.buffer, rgb.buffer)
      if (dm.normals) transfer.push(dm.normals.buffer)
      releaseAfter(i) // evict rasters this image was the last consumer of
    }

    emit('log', [`Depth maps: ${maps.length}/${images.length} computed in ${((performance.now() - t0) / 1000).toFixed(1)}s; `
      + `raster cache peak ${formatBytes(ledger.peak())}`, 'success', 'Dense'])

    // Cross-view geometric consistency — the only filter that sees sky/vegetation for
    // what it is (both have high NCC; only their cross-view *disagreement* gives them
    // away). Runs here, after the loop, because it needs every map's depth at once; it
    // zeroes rejected pixels in `maps`, so what we persist and hand to the ortho is the
    // filtered plane. The display PNGs above were rendered pre-filter and are only a
    // preview, so they intentionally still show the raw plane.
    let geomFilterMs = null
    if (geomConsistency && maps.length) {
      updateLoopShare(images.length)
      const LOOP_SHARE = loopShare
      const loopMs = performance.now() - tLoop
      emit('progress', [0, maps.length, 'Filtering depth maps…', LOOP_SHARE])
      const tFilt = performance.now()
      filterDepthMapsGeometric(maps, { maxGeomCost, minConsistent, minNcc },
        (m, l, c) => emit('log', [m, l, c]),
        {
          onProgress: (d, t, lbl) => emit('progress', [d, t,
            `Cross-view filter: ${lbl}`, LOOP_SHARE + (1 - LOOP_SHARE) * (t > 0 ? d / t : 0)]),
        })
      const marginal = maps.filter((m) => (m.filterStats?.considered ?? 0) > 0 && m.filterStats.keptPct < 1)
      if (marginal.length) {
        const names = marginal.slice(0, 12)
          .map((m) => `${m.name || m.uuid} ${m.filterStats.keptPct.toFixed(1)}%`).join('; ')
        emit('log', [`Depth filter: ${marginal.length} marginal map(s) kept <1% after cross-view filtering — `
          + `${names}${marginal.length > 12 ? `; +${marginal.length - 12} more` : ''}. `
          + 'They remain cached for diagnostics/orthophoto use but will contribute little to fusion.',
        'warn', 'Dense'])
      }
      geomFilterMs = performance.now() - tFilt
      // Measured vs modelled, so DENSE_TUNING.geomFilterUsPerPx can be retuned from runs.
      const usPerPx = pxDone > 0 ? geomFilterMs * 1000 / pxDone : 0
      emit('log', [`Depth filter: cross-view consistency in ${(geomFilterMs / 1000).toFixed(1)}s `
        + `(${usPerPx.toFixed(2)} µs/px; ${(100 * geomFilterMs / (geomFilterMs + loopMs)).toFixed(0)}% of Stage A, `
        + `progress bar gave it ${(100 * (1 - LOOP_SHARE)).toFixed(0)}%)`, 'info', 'Dense'])
    }

    emit('progress', [images.length, images.length, 'Depth maps complete', 1])
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
      nMaps: maps.length,
      nImages: images.length,
      backend: startedOnGpu ? (gpuFallbacks ? 'gpu→wasm' : 'gpu') : 'wasm',
      gpuRequested: !!settings.useGpu,
      gpuFallbacks,
      settings: {
        quality: settings.quality ?? null, maxDim, maxSources, window, iterations,
        bestK: autoBestKMode ? 'auto' : bestK,
        speckleFilter: !!speckleFilter,
        geomConsistency: !!geomConsistency,
        maxGeomCost: geomConsistency ? maxGeomCost : null,
        minConsistent: geomConsistency ? minConsistent : null,
        minNcc: geomConsistency ? minNcc : null,
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
    }
    return { result: { maps, summary }, transfer }
  }

  // Stage B — Build Point Cloud (dense). Fuses the depth maps from Stage A into a
  // single coloured point cloud (pure compute in core/dense/mvs.js).
  async function densify([input], { emit }) {
    const { maps, streamed = false, settings = {} } = input
    const total = Math.max(1, maps.length)
    emit('progress', [0, total, 'Fusing depth maps…'])
    const tFuse = performance.now()
    // fuseDepthMaps streams kept pixels straight into the voxel merge and returns the
    // packed flat buffer [x,y,z,r,g,b] per point — no per-point object list (the OOM).
    const fuse = streamed
      ? (ms, options, log, hooks) => fuseDepthMapsStreamed(ms, i => readDepthFiles(ms[i]), options, log,
        { ...hooks, loadDepth: i => readDepthOnly(ms[i]) })
      : fuseDepthMaps
    const flat = await fuse(maps, settings,
      (m, l, c) => emit('log', [m, l, c]),
      { onProgress: (d, t, lbl) => emit('progress', [d, t, lbl]) })
    const nPoints = flat.length / 6
    emit('log', [`Dense cloud: fused ${maps.length} depth maps → ${nPoints} points `
      + `in ${((performance.now() - tFuse) / 1000).toFixed(1)}s`
      + (nPoints === 0 ? ' — no pixels survived cross-view consistency; check intrinsics/distortion, Quality, or fusion gates (maxCost / minViews / parallax)' : ''),
      nPoints === 0 ? 'error' : 'success', 'Dense'])
    emit('progress', [total, total, 'Done'])
    // The store transfers each map's depth/cost/rgb/normals buffers in (no clone), so
    // return them so they round-trip home and the store can re-attach them to its
    // depthMaps cache (ortho reuses them). dims/K/R/t never left the main thread.
    const mapBuffers = (streamed ? [] : maps).map((m) => ({ uuid: m.uuid, depth: m.depth, cost: m.cost, rgb: m.rgb, normals: m.normals || null }))
    const transfer = [flat.buffer]
    if (flat.nrm) transfer.push(flat.nrm.buffer)
    for (const m of streamed ? [] : maps) {
      transfer.push(m.depth.buffer, m.cost.buffer, m.rgb.buffer)
      if (m.normals) transfer.push(m.normals.buffer)
    }
    return { result: { points: flat, nrm: flat.nrm ?? null, summary: flat.summary ?? null, mapBuffers }, transfer }
  }

  return { computeDepthMaps, densify }
}

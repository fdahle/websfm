import { readDepthFiles, readDepthOnly, readDepthAndCost } from '../../core/dense/depthFileReader.js'
import {
  selectSourceViews, scaleK, rgbaToGray, depthMapForImage, fuseDepthMaps, fuseDepthMapsStreamed, filterDepthMap,
  filterDepthMapsGeometric, filterDepthMapsGeometricStreamed, applyPackedMask, geomFilterLoopShare, autoBestK, filterSettings,
  depthMapSettings,
} from '../../core/dense/mvs.js'
import { depthCoverage } from '../../core/dense/depthMapCodec.js'
import { viewIndex } from '../../core/dense/sparseInput.js'
import { buildMaskLookup } from '../../core/mask.js'
import { hasDistortion } from '../../core/sfm/distortion.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import {
  resampleRgba, resampleMaskLut, pinholeFrameSize, fisheyeCanvas, resampleRgbaMarked, FISHEYE_DENSE_MAX_DEG,
} from '../../core/products/undistort.js'
import { scaleAxes } from '../../core/sfm/geometry.js'
import { depthColor } from '../../core/products/colormap.js'
import { isGpuAvailable, ensureDevice } from '../gpu/device.js'
import { computeDepthMapGPU } from '../gpu/depthMapGpu.js'
import {
  createMemLedger, projectDensePeakBytes, workingPixels, formatBytes, DEFAULT_BUDGET_BYTES,
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

  // A working raster's per-axis scale: what the rounded resize applied (rasterize's
  // scaleXY), never the nominal `scale` alone — see geometry.js scaleK.
  const gridScale = (r) => r.scaleXY ?? r.scale

  // Any distortion to remove (calibrated OR self-calibrated)?
  function hasAnyDistortion(dist, selfCal) {
    return hasDistortion(dist) || hasDistortion(selfCal)
  }

  // Remove lens distortion from a working-resolution raster. Kfull is the
  // native-resolution K; output and source share the working grid, so both scales
  // are its per-axis factors (`r.scaleXY`). A no-op when both bags are empty — that early return is what
  // keeps the common EXIF-only case free (a pure scale change is still a real map).
  //
  // A fisheye goes onto a wider canvas (undistort.js fisheyeCanvas): the raster then
  // carries `pad` (the principal-point shift, full-res px — use paddedK), `outside`
  // (0/1 LUT of canvas pixels off the photo) and, like every undistorted raster,
  // `undist` = { map, sw, sh } to move a photo-space mask the same way (undistortedMask).
  // `photo` = { width, height } of the full-resolution photo.
  function undistortRaster(r, Kfull, dist, selfCal, photo = null) {
    if (!hasAnyDistortion(dist, selfCal)) return r
    const base = makeSampleMap({ K: Kfull, dist, selfCal, outScale: gridScale(r), srcScale: gridScale(r) })
    const canvas = !hasDistortion(selfCal) && photo ? fisheyeCanvas(Kfull, dist, photo.width, photo.height) : null
    if (!canvas) {
      return { ...r, data: resampleRgba(r, base, r.width, r.height), undist: { map: base, sw: r.width, sh: r.height } }
    }
    const [sx, sy] = scaleAxes(gridScale(r))
    const ox = canvas.dx * sx, oy = canvas.dy * sy
    const map = (u, v) => base(u - ox, v - oy)
    const ow = Math.round(canvas.width * sx), oh = Math.round(canvas.height * sy)
    const { data, outside } = resampleRgbaMarked(r, map, ow, oh)
    return { ...r, data, width: ow, height: oh, pad: { dx: canvas.dx, dy: canvas.dy }, outside,
      undist: { map, sw: r.width, sh: r.height } }
  }

  // The camera's K for an undistorted raster's grid (before scaling to it): a widened
  // fisheye canvas shifts the principal point by its pad; the focal is unchanged.
  const paddedK = (K, r) => (r.pad ? { ...K, cx: K.cx + r.pad.dx, cy: K.cy + r.pad.dy } : K)

  // A photo-space mask (1 = excluded) on an undistorted raster's grid, nearest sample,
  // OR the canvas pixels off the photo. Null when there is nothing to exclude.
  async function undistortedMask(mask, r) {
    let lut = null
    if (mask) {
      lut = await buildMaskLookup(mask, r.undist ? r.undist.sw : r.width, r.undist ? r.undist.sh : r.height)
      if (r.undist) lut = resampleMaskLut(lut, r.undist.sw, r.undist.sh, r.undist.map, r.width, r.height)
    }
    if (!r.outside) return lut
    if (!lut) return r.outside
    const out = new Uint8Array(lut.length)
    for (let k = 0; k < lut.length; k++) out[k] = lut[k] || r.outside[k] ? 1 : 0
    return out
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
    const { width: sw, height: sh } = r
    const scanScale = gridScale(r)
    const { frame } = fid
    const cScale = maxDim / Math.max(frame.width, frame.height)
    const { width: ow, height: oh } = pinholeFrameSize({ fiducial: fid, scale: cScale })
    const useDist = hasDistortion(dist) ? dist : null
    const useSelf = hasDistortion(selfCal) ? selfCal : null
    const map = filmSampleMap(canonK, useDist, fid, cScale, scanScale, useSelf)
    return {
      // The canonical grid is defined by cScale on both axes (the map above), so K
      // scales uniformly; only the scan it samples has rounded per-axis factors.
      data: resampleRgba(r, map, ow, oh), width: ow, height: oh, scale: cScale, scaleXY: [cScale, cScale],
      fid, canonK, dist: useDist, selfCal: useSelf, scanDims: { w: sw, h: sh, scale: scanScale },
    }
  }

  // Warp a scan-space mask LUT (built at scan working size) into the canonical
  // working grid of raster `r` (a warpFilmRaster output). Nearest sample.
  async function filmMaskLut(mask, r) {
    const sd = r.scanDims
    const scanLut = await buildMaskLookup(mask, sd.w, sd.h)
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

  // Render a depth plane to a colourized PNG Blob for the image viewer's depth
  // overlay (a Blob, not a data URL: it crosses to the page by reference and stays
  // off both V8 heaps). Valid depths are normalised to a blue→red ramp (near = red); holes
  // are transparent so the underlying image shows through.
  async function depthToPng(depth, w, h) {
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
    return canvas.convertToBlob({ type: 'image/png' })
  }

  // Stage A — Build Depth Maps. Rasterises each registered image (and its source
  // neighbours), runs PatchMatch MVS, and returns one depth map per reference image
  // (raw depth/cost planes + colours for fusion, plus a display PNG). Pure compute
  // lives in core/dense/mvs.js; pixel decoding is worker-only (OffscreenCanvas).
  async function computeDepthMaps([input], { emit }) {
    // `sparse`: the packed sparse model (core/dense/sparseInput.js), transferred.
    const { images, sparse, settings = {} } = input
    // Every knob through the engine-boundary checks (core/dense/mvs.js depthMapSettings):
    // a blank / non-finite / out-of-range value takes its default.
    const {
      maxDim, maxSources: maxSourcesReq, minAngleDeg, window, iterations, bestK,
      speckleFilter, filterRadius, filterRelTol, coarseLong,
      // Resolved here (not left to the filter's own defaults) so the run record below
      // states the values the filter actually used, also for a recipe saved before a knob existed.
      geomConsistency, maxGeomCost, minConsistent, minNcc, minGeomAngleDeg,
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

    // Median / p95 of the matching cost over the pixels with depth. A histogram, not a
    // sort: costs live in [0, 2], and copying + comparator-sorting the ~20 M costs of a
    // 4570² map took most of the per-image tail on Casa Grande's 1978 scans (62 s in
    // node for 19 M values). 4096 bins resolve 0.0005, below the logged 2 decimals.
    const COST_BINS = 4096, COST_MAX = 2
    const costStat = (depth, cost) => {
      const hist = new Uint32Array(COST_BINS)
      let n = 0
      for (let k = 0; k < depth.length; k++) {
        if (!(depth[k] > 0)) continue
        const c = cost[k]
        hist[c >= COST_MAX ? COST_BINS - 1 : c > 0 ? Math.floor(c * (COST_BINS / COST_MAX)) : 0]++
        n++
      }
      if (!n) return { median: 0, p95: 0, valid: 0 }
      const at = (q) => {
        const target = Math.min(n - 1, Math.round(q * (n - 1)))
        let acc = 0
        for (let b = 0; b < COST_BINS; b++) { acc += hist[b]; if (acc > target) return (b + 0.5) * (COST_MAX / COST_BINS) }
        return COST_MAX
      }
      return { median: at(0.5), p95: at(0.95), valid: n }
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
    // tab mid-run (Safari can't be observed or intercepted). Working dims from each
    // image's own size (maxDim² when unknown); source count uses maxSources.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    const proj = projectDensePeakBytes({
      nImages: images.length, maxDim, nSources: maxSources, backend: backend ? 'gpu' : 'wasm',
      // A fisheye's widened canvas (undistortRaster) at the photo's working scale.
      pixels: images.map((im) => {
        const px = workingPixels(im.width, im.height, maxDim)
        const c = !im.fid && !hasDistortion(im.selfCal) ? fisheyeCanvas(im.K, im.dist, im.width, im.height) : null
        return c ? Math.round(px * (c.width * c.height) / (im.width * im.height)) : px
      }),
      retainedMaps: streamMaps ? 1 : images.length,
      // The in-memory cross-view filter below; streamed maps are filtered by its own pass.
      filterMaps: geomConsistency && !streamMaps ? images.length : 0,
    })
    emit('log', [`Dense: projected peak memory ≈ ${formatBytes(proj.total)} `
      + `(store ${formatBytes(proj.store)} + raster ${formatBytes(proj.raster)}`
      + `${proj.gpu ? ` + GPU ${formatBytes(proj.gpu)}` : ''}${proj.filter ? ` + filter masks ${formatBytes(proj.filter)}` : ''}) vs budget ${formatBytes(budget)}`,
      proj.total > budget ? 'error' : 'info', 'Dense'])
    if (proj.total > budget) {
      emit('log', ['Dense: aborting before start — projected memory exceeds the budget. '
        + 'Lower Quality (e.g. Medium) or raise the memory budget, then retry.', 'error', 'Dense'])
      throw new Error(`dense pre-flight: projected ${formatBytes(proj.total)} exceeds budget ${formatBytes(budget)}`)
    }

    // Precompute each image's source views once (also drives the raster refcounts),
    // so the cache can evict a raster the moment it's no longer needed — keeping the
    // resident working set small instead of holding every image's pixels at once.
    const sparseIndex = viewIndex(sparse) // image → the points it sees, once per run
    const srcUuidsByImg = images.map((img) =>
      selectSourceViews(cameras, sparse, img.uuid, { maxSources, minAngleDeg }, sparseIndex))
    const urlByUuid = new Map(images.map((im) => [im.uuid, im.url]))
    // Per-url intrinsics + distortion, so getRaster can undistort each source once
    // (url↔image is 1:1, and undistortion is independent of ref/source role).
    const metaByUrl = new Map(images.map((im) =>
      [im.url, { K: im.K, dist: im.dist || null, selfCal: im.selfCal || null, fid: im.fid || null,
        photo: im.width > 0 && im.height > 0 ? { width: im.width, height: im.height } : null }]))
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
          r = undistortRaster(r, meta.K, meta.dist, meta.selfCal, meta.photo)
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
        K: scaleK(paddedK(img.K, rRef), gridScale(rRef)),
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
        // A widened fisheye canvas also excludes its pixels off the photo.
        const srcMask = rs.fid ? (s.mask ? await filmMaskLut(s.mask, rs) : null) : await undistortedMask(s.mask, rs)
        sources.push({
          gray: rgbaToGray(rs.data, rs.width, rs.height),
          w: rs.width, h: rs.height,
          K: scaleK(paddedK(s.K, rs), gridScale(rs)),
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
        dm = await depthMapForImage(ref, sources, sparse.pos, { window, iterations, bestK: imgBestK, coarseLong, region: settings.region ?? null }, backend, hooks)
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
          dm = await depthMapForImage(ref, sources, sparse.pos, { window, iterations, bestK: imgBestK, coarseLong, region: settings.region ?? null }, backend, { onLog: hooks.onLog, onProgress: hooks.onProgress })
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
      // The mask moves with the raster (undistortion, or the fisheye canvas, whose pixels
      // off the photo are dropped too).
      const maskLut = rRef.fid
        ? (img.mask ? await filmMaskLut(img.mask, rRef) : null)
        : await undistortedMask(img.mask, rRef)
      if (maskLut && maskLut.length === dm.depth.length) {
        for (let k = 0; k < dm.depth.length; k++) if (maskLut[k]) dm.depth[k] = 0
      }
      const rgb = rgbFromRgba(rRef.data, rRef.width, rRef.height)
      const displayBlob = await depthToPng(dm.depth, dm.width, dm.height)
      // F4: for film images the depth preview is in the canonical frame, not scan
      // space, so it won't line up with the scan in the viewer (v1 limitation).
      if (rRef.fid) {
        emit('log', [`Depth maps: ${img.name} — preview is in the canonical fiducial frame `
          + `(${dm.width}×${dm.height}), not scan space`, 'debug', 'Dense'])
      }
      if (rRef.pad) {
        emit('log', [`Depth maps: ${img.name} — fisheye resampled onto a ${dm.width}×${dm.height} pinhole canvas `
          + `(up to ${FISHEYE_DENSE_MAX_DEG}° off-axis); its preview is in that frame, not the photo's`, 'debug', 'Dense'])
      }
      // Per-pixel diagnostics: how many pixels got a depth, and the matching-cost
      // distribution over those pixels (low cost = confident; high = likely junk
      // that fusion's maxCost gate will drop — the key signal for dense quality).
      const cs = costStat(dm.depth, dm.cost)
      const valid = cs.valid
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

      const map = {
        uuid: img.uuid, name: img.name, width: dm.width, height: dm.height,
        K: ref.K, R: img.R, t: img.t,
        // Per-pixel converged plane normals (camera-frame, unit, nz<0). Kept
        // alongside depth for fusion → Poisson meshing. Holes are defined by
        // depth<=0 everywhere downstream, so stale normals under a zeroed depth are
        // harmless and deliberately NOT cleaned up.
        depth: dm.depth, cost: dm.cost, normals: dm.normals || null, rgb, displayBlob,
      }
      pxDone += dm.width * dm.height
      const planes = [dm.depth.buffer, dm.cost.buffer, rgb.buffer, ...(dm.normals ? [dm.normals.buffer] : [])]
      if (streamMaps) {
        emit('map', [map], planes)
        streamed++
      } else {
        maps.push(map)
        transfer.push(...planes)
      }
      releaseAfter(i) // evict rasters this image was the last consumer of
    }

    emit('log', [`Depth maps: ${streamMaps ? streamed : maps.length}/${images.length} computed in ${((performance.now() - t0) / 1000).toFixed(1)}s; `
      + `raster cache peak ${formatBytes(ledger.peak())}`, 'success', 'Dense'])

    // Cross-view geometric consistency — the only filter that sees sky/vegetation for
    // what it is (both have high NCC; only their cross-view *disagreement* gives them
    // away). Runs here, after the loop, because it needs every map's depth at once; it
    // zeroes rejected pixels in `maps`, so what we persist and hand to the ortho is the
    // filtered plane. The display PNGs above were rendered pre-filter and are only a
    // preview, so they intentionally still show the raw plane.
    let geomFilterMs = null
    if (geomConsistency && maps.length && !streamMaps) {
      updateLoopShare(images.length)
      const LOOP_SHARE = loopShare
      const loopMs = performance.now() - tLoop
      emit('progress', [0, maps.length, 'Filtering depth maps…', LOOP_SHARE])
      const tFilt = performance.now()
      filterDepthMapsGeometric(maps, { maxGeomCost, minConsistent, minNcc, minGeomAngleDeg },
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

    // Streaming: the caller's filter pass owns the rest of the bar, from `loopShare`.
    if (!streamMaps) emit('progress', [images.length, images.length, 'Depth maps complete', 1])
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
    if (geomConsistency && streamMaps) updateLoopShare(images.length)
    return { result: { maps, summary, loopShare: streamMaps && geomConsistency ? loopShare : 1 }, transfer }
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
        emit('filtered', [{ uuid: entries[i].uuid, depth, coverage: depthCoverage(depth), filterStats: apply.stats?.[k] }], [depth.buffer])
        emit('progress', [k + 1, apply.refs.length, 'Writing filtered depth maps…'])
      }
      return { result: { written: apply.refs.length }, transfer: [] }
    }
    const partial = !!refs
    const opts = {
      ...filterSettings(settings),
      // A share of the run's memory budget for cached candidate planes.
      cacheBytes: Math.max(64 * 1024 ** 2, Math.min(2 * 1024 ** 3, (settings.memBudgetBytes || DEFAULT_BUDGET_BYTES) / 4)) / workers,
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
    const { masks, stats, totals, loads, hits, nCand } = await filterDepthMapsGeometricStreamed(metas, io, opts,
      (m, l, c) => emit('log', [m, l, c]),
      { onProgress: (d, t, lbl) => emit('progress', [d, t, `Cross-view filter: ${lbl}`, at(judgeShare * (t > 0 ? d / t : 0))]) })
    const judgeMs = performance.now() - t0
    if (partial) {
      const own = refs.map((i) => masks[i])
      return { result: { stats, totals, loads, hits, nCand, judgeMs, ms: performance.now() - t0, cacheBytes: opts.cacheBytes, masks: own },
        transfer: own.map((m) => m.buffer) }
    }
    for (let k = 0; k < own.length; k++) {
      const i = own[k]
      const depth = applyPackedMask((await readDepthOnly(entries[i])).depth, masks[i])
      masks[i] = null
      emit('filtered', [{ uuid: entries[i].uuid, depth, coverage: depthCoverage(depth), filterStats: stats[i] }], [depth.buffer])
      emit('progress', [k + 1, own.length, 'Writing filtered depth maps…', at(judgeShare + (1 - judgeShare) * (k + 1) / own.length)])
    }
    const marginal = metas.map((m, i) => ({ m, s: stats[i] })).filter(({ s }) => s.considered > 0 && s.keptPct < 1)
    if (marginal.length) {
      const names = marginal.slice(0, 12).map(({ m, s }) => `${m.name || m.uuid} ${s.keptPct.toFixed(1)}%`).join('; ')
      emit('log', [`Depth filter: ${marginal.length} marginal map(s) kept <1% after cross-view filtering — `
        + `${names}${marginal.length > 12 ? `; +${marginal.length - 12} more` : ''}. `
        + 'They remain cached for diagnostics/orthophoto use but will contribute little to fusion.', 'warn', 'Dense'])
    }
    const ms = performance.now() - t0
    let px = 0
    for (const m of metas) px += m.width * m.height
    emit('log', [`Depth filter: cross-view consistency in ${(ms / 1000).toFixed(1)}s (streamed from saved maps; `
      + `${(judgeMs * 1000 / Math.max(1, px)).toFixed(2)} µs/px judging)`, 'info', 'Dense'])
    emit('progress', [entries.length, entries.length, 'Depth maps complete', 1])
    return { result: { stats, totals, ms }, transfer: [] }
  }

  // Stage B — Build Point Cloud (dense). Fuses the depth maps from Stage A into a
  // single coloured point cloud (pure compute in core/dense/mvs.js).
  // Parallel fusion over saved maps (the store drives it): `mode: 'plan'` runs the
  // pre-passes and returns the slab plan; `mode: 'slab'` fuses one slab of `plan` and
  // returns it in the cloud's layout with its counters. Without a mode, one call does
  // it all (with `settings.plan`, it skips the pre-passes).
  async function densify([input], { emit }) {
    const { maps, streamed = false, settings = {}, mode = null, plan = null, slab = null } = input
    if (mode) {
      const log = (m, l, c) => emit('log', [m, l, c])
      const load = (i) => readDepthFiles(maps[i])
      const loadDepth = (i) => readDepthOnly(maps[i])
      if (mode === 'plan') {
        const res = await fuseDepthMapsStreamed(maps, load, { ...settings, planOnly: true }, log, { loadDepth })
        return { result: res.refused ? { plan: null, refused: res.refused } : { plan: res, refused: null }, transfer: [] }
      }
      const parts = []
      const run = await fuseDepthMapsStreamed(maps, load, { ...settings, plan, slabIndices: [slab] }, log, {
        loadDepth, onTile: (f) => parts.push(denseFromFlat(f)),
        onProgress: (d, t, lbl) => emit('progress', [d, t, lbl]),
      })
      const part = parts[0]
      return { result: { part, counters: run.counters, stream: run.stream }, transfer: [part.pos.buffer, part.col.buffer, part.nrm.buffer] }
    }
    const total = Math.max(1, maps.length)
    emit('progress', [0, total, 'Fusing depth maps…'])
    const tFuse = performance.now()
    // fuseDepthMaps streams kept pixels straight into the voxel merge and returns the
    // packed flat buffer [x,y,z,r,g,b] per point — no per-point object list (the OOM).
    const fuse = streamed
      ? (ms, options, log, hooks) => fuseDepthMapsStreamed(ms, i => readDepthFiles(ms[i]), options, log,
        { ...hooks, loadDepth: i => readDepthOnly(ms[i]) })
      : fuseDepthMaps
    // Each finished slab (one, unless fusion tiles to fit the budget) is converted at
    // once to the cloud's own layout, so its flat [x,y,z,r,g,b] buffer is dropped
    // before the next slab's accumulator exists; the slabs are joined at the end.
    const parts = []
    const flat = await fuse(maps, settings,
      (m, l, c) => emit('log', [m, l, c]),
      { onProgress: (d, t, lbl) => emit('progress', [d, t, lbl]), onTile: (f) => parts.push(denseFromFlat(f)) })
    const cloud = joinDenseParts(parts)
    const nPoints = cloud.count
    // The fusion pre-flight refused (already logged with its numbers): no cloud, but
    // the transferred planes still go home below.
    if (!flat.refused) emit('log', [`Dense cloud: fused ${maps.length} depth maps → ${nPoints} points `
      + `in ${((performance.now() - tFuse) / 1000).toFixed(1)}s`
      + (nPoints === 0 ? ' — no pixels survived cross-view consistency; check intrinsics/distortion, Quality, or fusion gates (maxCost / minViews / parallax)' : ''),
      nPoints === 0 ? 'error' : 'success', 'Dense'])
    emit('progress', [total, total, 'Done'])
    // The store transfers each map's depth/cost/rgb/normals buffers in (no clone), so
    // return them so they round-trip home and the store can re-attach them to its
    // depthMaps cache (ortho reuses them). dims/K/R/t never left the main thread.
    const mapBuffers = (streamed ? [] : maps).map((m) => ({ uuid: m.uuid, depth: m.depth, cost: m.cost, rgb: m.rgb, normals: m.normals || null }))
    const transfer = [cloud.pos.buffer, cloud.col.buffer, cloud.nrm.buffer]
    for (const m of streamed ? [] : maps) {
      transfer.push(m.depth.buffer, m.cost.buffer, m.rgb.buffer)
      if (m.normals) transfer.push(m.normals.buffer)
    }
    return { result: { cloud, summary: flat.summary ?? null, refused: flat.refused ?? null, mapBuffers }, transfer }
  }

  // One fused slab → the dense cloud's split Float32 position / Uint8 colour / Float32
  // normal arrays.
  function denseFromFlat(flat) {
    const n = flat.length / 6
    const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3)
    for (let i = 0; i < n; i++) {
      const s = i * 6, d = i * 3
      pos[d] = flat[s]; pos[d + 1] = flat[s + 1]; pos[d + 2] = flat[s + 2]
      col[d] = flat[s + 3]; col[d + 1] = flat[s + 4]; col[d + 2] = flat[s + 5]
    }
    return { count: n, pos, col, nrm: flat.nrm ?? new Float32Array(n * 3) }
  }
  function joinDenseParts(parts) {
    if (parts.length === 1) return parts[0]
    const n = parts.reduce((s, p) => s + p.count, 0)
    const out = { count: n, pos: new Float32Array(n * 3), col: new Uint8Array(n * 3), nrm: new Float32Array(n * 3) }
    let o = 0
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      out.pos.set(p.pos, o * 3); out.col.set(p.col, o * 3); out.nrm.set(p.nrm, o * 3)
      o += p.count
      parts[i] = null // each slab can be collected once copied
    }
    return out
  }

  return { computeDepthMaps, filterDepthMaps, densify }
}

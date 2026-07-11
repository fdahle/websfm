import {
  selectSourceViews, scaleK, rgbaToGray, depthMapForImage, fuseDepthMaps, filterDepthMap, autoBestK,
} from '../../core/dense/mvs.js'
import { buildMaskLookup } from '../../core/mask.js'
import { distortPixel, hasDistortion } from '../../core/sfm/distortion.js'
import { canonicalToScan } from '../../core/sfm/fiducials.js'
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
  // Bilinear-sample an RGBA buffer at (x,y); clamps to the edge. Writes into `out`
  // at offset `oi` (4 bytes). Used by the raster undistortion below.
  function sampleRgbaBilinear(data, w, h, x, y, out, oi) {
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)))
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1)
    const fx = x - x0, fy = y - y0
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4
    const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4
    for (let c = 0; c < 4; c++) {
      const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx
      const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx
      out[oi + c] = top * (1 - fy) + bot * fy
    }
  }

  // Remove lens distortion from a working-resolution raster: for each output (ideal
  // pinhole) pixel, sample the source at the distorted pixel the lens recorded there
  // (closed-form forward map + bilinear). Kfull is the native-resolution K; the map
  // runs in working-res K = scaleK(Kfull, scale). Returns a new raster; a no-op when
  // dist is empty. This is what keeps depth maps / fusion / DEM / ortho pinhole.
  function undistortRaster(r, Kfull, dist) {
    if (!hasDistortion(dist)) return r
    const { data, width: w, height: h, scale } = r
    const Kw = scaleK(Kfull, scale)
    const out = new Uint8ClampedArray(data.length)
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const { x: ud, y: vd } = distortPixel(u, v, Kw, dist)
        sampleRgbaBilinear(data, w, h, ud, vd, out, (v * w + u) * 4)
      }
    }
    return { ...r, data: out }
  }

  // Undistort a boolean mask LUT with the same forward map (nearest sample) so a
  // distorted-space film-frame mask lines up with the now-undistorted raster.
  function undistortMaskLut(lut, w, h, Kfull, dist, scale) {
    if (!hasDistortion(dist)) return lut
    const Kw = scaleK(Kfull, scale)
    const out = new Uint8Array(lut.length)
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const { x: ud, y: vd } = distortPixel(u, v, Kw, dist)
        const su = Math.max(0, Math.min(w - 1, Math.round(ud)))
        const sv = Math.max(0, Math.min(h - 1, Math.round(vd)))
        out[v * w + u] = lut[sv * w + su]
      }
    }
    return out
  }

  // ── Film scan → canonical warp (F4) ─────────────────────────────────────────
  // A film image's sparse cameras use the canonical K, so its dense reference
  // raster must live in the canonical pixel frame too. We warp the scan raster
  // into that frame with the SAME transform chain the sparse ingest applied, only
  // inverted (output canonical px → sample the scan): canonical px →(distort, in
  // canonical, which equals distort in mm)→ distorted canonical →(canonicalToScan)
  // → scan full-res → ×scanScale → scan working px. The canonical working grid is
  // sized so its long side ≈ maxDim (matching non-film rasters). Returns a raster
  // carrying the info the mask warp needs (scanDims, fid, canonK, dist).
  function canonWorkingToScan(u, v, cScale, canonK, dist, fid, scanScale) {
    const cx = u / cScale, cy = v / cScale                       // full-res canonical px
    const d = dist ? distortPixel(cx, cy, canonK, dist) : { x: cx, y: cy }
    const s = canonicalToScan(d.x, d.y, fid.A, fid.frame)        // scan full-res px
    return { x: s.x * scanScale, y: s.y * scanScale }            // scan working px
  }

  function warpFilmRaster(r, canonK, dist, fid, maxDim) {
    const { data, width: sw, height: sh, scale: scanScale } = r
    const { frame } = fid
    const cScale = maxDim / Math.max(frame.width, frame.height)
    const ow = Math.max(1, Math.round(frame.width * cScale))
    const oh = Math.max(1, Math.round(frame.height * cScale))
    const out = new Uint8ClampedArray(ow * oh * 4)
    const useDist = hasDistortion(dist) ? dist : null
    for (let v = 0; v < oh; v++) {
      for (let u = 0; u < ow; u++) {
        const s = canonWorkingToScan(u, v, cScale, canonK, useDist, fid, scanScale)
        sampleRgbaBilinear(data, sw, sh, s.x, s.y, out, (v * ow + u) * 4)
      }
    }
    return {
      data: out, width: ow, height: oh, scale: cScale,
      fid, canonK, dist: useDist, scanDims: { w: sw, h: sh, scale: scanScale },
    }
  }

  // Warp a scan-space mask LUT (built at scan working size) into the canonical
  // working grid of raster `r` (a warpFilmRaster output). Nearest sample.
  async function filmMaskLut(maskDataUrl, r) {
    const sd = r.scanDims
    const scanLut = await buildMaskLookup(maskDataUrl, sd.w, sd.h)
    const out = new Uint8Array(r.width * r.height)
    for (let v = 0; v < r.height; v++) {
      for (let u = 0; u < r.width; u++) {
        const s = canonWorkingToScan(u, v, r.scale, r.canonK, r.dist, r.fid, sd.scale)
        const su = Math.max(0, Math.min(sd.w - 1, Math.round(s.x)))
        const sv = Math.max(0, Math.min(sd.h - 1, Math.round(s.y)))
        out[v * r.width + u] = scanLut[sv * sd.w + su]
      }
    }
    return out
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
    const metaByUrl = new Map(images.map((im) => [im.url, { K: im.K, dist: im.dist || null, fid: im.fid || null }]))
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
          // Film scan: warp into the canonical frame (composes any distortion).
          r = warpFilmRaster(r, meta.K, meta.dist, meta.fid, maxDim)
        } else if (meta?.dist) {
          r = undistortRaster(r, meta.K, meta.dist)
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
    for (let i = 0; i < images.length; i++) {
      const img = images[i]
      emit('progress', [i, images.length, img.name])

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
            if (s.dist) srcMask = undistortMaskLut(srcMask, rs.width, rs.height, s.K, s.dist, rs.scale)
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
        validate: backend && i === 0,
      }
      let dm
      try {
        dm = await depthMapForImage(ref, sources, points, { window, iterations, bestK: imgBestK, coarseLong }, backend, hooks)
      } catch (err) {
        // A GPU failure mid-run must not abort the whole batch: log it, drop to WASM
        // for this image and every image after, and retry once on the CPU path.
        if (backend) {
          emit('log', [`Depth maps: GPU error on ${img.name} (${err?.message ?? err}) — falling back to WASM`,
            'warn', 'Dense'])
          backend = undefined
          // Keep streaming the coarse-to-fine plan log on the retry (validate no
          // longer applies once we've dropped off the GPU path).
          dm = await depthMapForImage(ref, sources, points, { window, iterations, bestK: imgBestK, coarseLong }, backend, { onLog: hooks.onLog })
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
      const seedPct = (100 * dm.seeded / dm.depth.length).toFixed(1)
      emit('log', [`Depth maps: ${img.name} — ${srcUuids.length} sources (best-${imgBestK}), ${dm.width}×${dm.height}, `
        + `depth ${dm.depthMin.toFixed(2)}–${dm.depthMax.toFixed(2)} (${dm.seeded} seeds, ${seedPct}%), `
        + `${(100 * valid / dm.depth.length).toFixed(0)}% with depth, `
        + `cost median ${cs.median.toFixed(2)} / p95 ${cs.p95.toFixed(2)}, ${(imgMs / 1000).toFixed(1)}s`,
        'info', 'Dense'])

      maps.push({
        uuid: img.uuid, width: dm.width, height: dm.height,
        K: ref.K, R: img.R, t: img.t,
        depth: dm.depth, cost: dm.cost, rgb, displayDataUrl,
      })
      transfer.push(dm.depth.buffer, dm.cost.buffer, rgb.buffer)
      releaseAfter(i) // evict rasters this image was the last consumer of
    }

    emit('progress', [images.length, images.length, 'Done'])
    emit('log', [`Depth maps: ${maps.length}/${images.length} computed in ${((performance.now() - t0) / 1000).toFixed(1)}s; `
      + `raster cache peak ${formatBytes(ledger.peak())}`, 'success', 'Dense'])
    return { result: { maps }, transfer }
  }

  // Stage B — Build Point Cloud (dense). Fuses the depth maps from Stage A into a
  // single coloured point cloud (pure compute in core/dense/mvs.js).
  async function densify([input], { emit }) {
    const { maps, settings = {} } = input
    emit('progress', [0, 1, 'Fusing depth maps…'])
    const tFuse = performance.now()
    const points = fuseDepthMaps(maps, settings, (m, l, c) => emit('log', [m, l, c]))
    emit('log', [`Dense cloud: fused ${maps.length} depth maps → ${points.length} points `
      + `in ${((performance.now() - tFuse) / 1000).toFixed(1)}s`, 'success', 'Dense'])
    emit('progress', [1, 1, 'Done'])
    // Pack points into a transferable flat buffer: [x,y,z,r,g,b] per point.
    const flat = new Float32Array(points.length * 6)
    points.forEach((p, i) => {
      flat.set([p.x, p.y, p.z, p.color[0], p.color[1], p.color[2]], i * 6)
    })
    return { result: { points: flat, summary: points.summary ?? null }, transfer: [flat.buffer] }
  }

  return { computeDepthMaps, densify }
}

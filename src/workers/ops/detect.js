import { detectSift } from '../../core/features/sift.js'
import { detectLearned, rgbaToPlanar } from '../../core/features/learnedDetect.js'
import { learnedDetector, detectorLabel } from '../../core/features/learnedDetectors.js'
import {
  planTiles, tileOwns, sliceRaster, nmsByPosition, autoTileSize,
  SIFT_TILE_ALIGN, SEAM_NMS_RADIUS,
} from '../../core/features/tiling.js'
import { capOrder, capBoundary } from '../../core/features/keypointCap.js'
import { SIFT_DESC_NORM, rootSiftInPlace } from '../../core/features/siftDescriptors.js'
import { buildMaskLookup } from '../../core/mask.js'
import { fromScaledPx } from '../../core/sfm/geometry.js'
import {
  FIDUCIAL_DETECT_TUNING, grayFromRgba, detectFiducialsInImage,
} from '../../core/sfm/fiducialDetect.js'
import {
  FIDUCIAL_DETECTION_TUNING, detectFiducialSpots as detectFiducialSpotsCore,
  refineDetectionSpot, nativeRefinePlan,
} from '../../core/sfm/fiducialDetection.js'

// Detection ops (SIFT / learned: SuperPoint, DISK). `rasterize` (OffscreenCanvas pixel decode)
// stays in the worker and is injected; the STRIDE parse + shared feature-bundle
// shape live here next to the two detector runners.
export function makeDetectOps({ rasterize }) {
  // Must match STRIDE in crates/sift/src/lib.rs: [x, y, scale, response, angle, d0..d127]
  const STRIDE = 133
  const DESC_LEN = 128
  // GPU storage-buffer binding limit, queried once for auto tile sizing (0 once we
  // know there's no adapter; undefined = not yet asked).
  let gpuBindingBytes

  // Percentile helper over a value array (sorted ascending in place by caller).
  function percentile(sorted, q) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] : 0
  }

  // SIFT detector → a uniform feature bundle (see detect() for the shared shape):
  // count, per-keypoint accessors, a descriptor-row view, and detector-specific diag.
  // UNCAPPED: the cap is a selection rule (core/features/keypointCap.js) applied by
  // the caller after masking and, when tiled, after the seam merge. The crate builds
  // every descriptor before truncating anyway, so this costs only the copy out.
  async function runSift(data, width, height, { contrastThreshold, maxOrientations }) {
    // wasm init + detect_sift now live in core/features/sift.js; the STRIDE parse
    // into the shared feature bundle (below) stays worker-side.
    const { flat, ms } = await detectSift(data, width, height, { contrastThreshold, maxKeypoints: 0, maxOrientations })

    // Layout: STRIDE floats per keypoint [x,y,scale,response,angle,d0..d127], then two
    // trailing scalars — rawFound (survivors of near-duplicate suppression) and
    // suppressed. Empty (degenerate input) ⇒ 0.
    const suppressed = flat.length >= 2 ? flat[flat.length - 1] : 0
    const n = flat.length >= 2 ? Math.floor((flat.length - 2) / STRIDE) : 0
    return {
      descLen: DESC_LEN, ms, count: n,
      at: (i) => ({ x: flat[i * STRIDE], y: flat[i * STRIDE + 1], scale: flat[i * STRIDE + 2], response: flat[i * STRIDE + 3] }),
      desc: (i) => flat.subarray(i * STRIDE + 5, i * STRIDE + 5 + DESC_LEN),
      diag: { rawFound: n, suppressed },
    }
  }

  // Mask, then cap, an uncapped SIFT bundle. Masking first means masked regions
  // never take cap slots (a masked film border can otherwise eat ~20 % of them).
  function capSift(bundle, { maxKeypoints, capRule, maskLut, width, height }) {
    const items = []
    const src = []
    let maskedPreCap = 0
    for (let i = 0; i < bundle.count; i++) {
      const f = bundle.at(i)
      if (maskLut) {
        const px = Math.min(width - 1, Math.max(0, Math.round(f.x)))
        const py = Math.min(height - 1, Math.max(0, Math.round(f.y)))
        if (maskLut[py * width + px]) { maskedPreCap++; continue }
      }
      items.push(f); src.push(i)
    }
    const keep = capOrder(items, maxKeypoints, capRule)
    const { minResponse, minScale } = capBoundary(items, keep)
    const keptResp = keep.map((k) => items[k].response).sort((a, b) => a - b)
    return {
      descLen: bundle.descLen, ms: bundle.ms, count: keep.length,
      at: (i) => items[keep[i]],
      desc: (i) => bundle.desc(src[keep[i]]),
      diag: {
        ...bundle.diag, maskedPreCap, capRule,
        capHit: maxKeypoints > 0 && items.length > maxKeypoints, minResponse, minScale,
        respP50: percentile(keptResp, 0.5), respP95: percentile(keptResp, 0.95),
      },
    }
  }

  // Learned detector (ONNX via core/features/learnedDetect.js) → the same feature
  // bundle. Descriptor width is the spec's (SuperPoint 256, DISK 128) — carried
  // through as descLen so persistence and matching read the width off the buffer
  // rather than a hardcoded const.
  async function runLearned(spec, data, width, height, { maxKeypoints, onLog }) {
    // Planar float [0,1]: luma for SuperPoint, RGB for DISK.
    const pixels = rgbaToPlanar(data, width, height, spec.channels)
    const t0 = performance.now()
    const { keypoints, descriptors, dim } = await detectLearned(spec, pixels, width, height, { maxKeypoints, onLog })
    const ms = performance.now() - t0

    const n = keypoints.length
    const scores = keypoints.map((k) => k.score).sort((a, b) => a - b)
    return {
      descLen: dim, ms, count: n,
      // No blob scale from a learned detector — report score as the "response".
      at: (i) => ({ x: keypoints[i].x, y: keypoints[i].y, scale: 0, response: keypoints[i].score }),
      desc: (i) => descriptors.subarray(i * dim, (i + 1) * dim),
      diag: {
        capHit: maxKeypoints > 0 && n >= maxKeypoints,
        scoreP50: percentile(scores, 0.5), scoreP95: percentile(scores, 0.95),
      },
    }
  }

  // Query the adapter's storage-buffer binding limit once (just the adapter — no
  // device, so we don't spin up a second WebGPU device competing with ORT's for
  // memory). 0 when there's no adapter.
  async function queryGpuBindingBytes() {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return 0
      const adapter = await navigator.gpu.requestAdapter()
      return adapter?.limits?.maxStorageBufferBindingSize ?? 0
    } catch { return 0 }
  }

  // Resolve the working tile size for a run: an explicit `manual` size, else auto.
  // Learned detectors run on ORT's WebGPU EP, whose real allocation ceiling is well below
  // the adapter's *reported* binding limit (Apple/unified-memory GPUs advertise
  // multiple GB but OOM'd at 1200px here), so the reported limit only *lowers* the
  // tile on constrained GPUs — the effective cap is a conservative SP_GPU_TILE_MAX
  // that stays under that empirical failure point. SIFT is CPU, so memory isn't the
  // constraint and it gets the larger default.
  const SP_GPU_TILE_MAX = 1024
  async function resolveTileSize(detector, tiling, tileSize) {
    if (tiling === 'manual' && tileSize > 0) return tileSize
    if (!learnedDetector(detector)) return autoTileSize({ maxBindingBytes: 0 })
    if (gpuBindingBytes === undefined) gpuBindingBytes = await queryGpuBindingBytes()
    return autoTileSize({ maxBindingBytes: gpuBindingBytes, max: SP_GPU_TILE_MAX })
  }

  // Run the detector tile-by-tile over an already-rasterised full raster and merge
  // into ONE feature bundle in full detect-space coords — the shared shape, so the
  // caller's mask/colour/back-map loop consumes it unchanged. Each tile keeps only
  // the keypoints in its core (see core/features/tiling.js: ownership, not dedup),
  // a cross-tile NMS removes a blob localised on both sides of a core boundary, and
  // ONE global cap (SIFT: `capRule`; learned: score) runs over the merge. Each
  // tile is pre-capped by the same rule only to bound memory, and that cannot drop a
  // keypoint the global cap would keep: one ranked below maxKeypoints others in its
  // own tile has at least that many distinct better-ranked keypoints in the image.
  // SIFT pre-caps after ownership and masking; a learned detector's top-K is applied per tile.
  async function runTiled(raster, detector, tileSize, { contrastThreshold, maxKeypoints, maxOrientations, capRule, overlap, maskLut, onLog }) {
    const { data, width, height } = raster
    const spec = learnedDetector(detector)
    const align = spec ? spec.tileAlign : SIFT_TILE_ALIGN
    const tiles = planTiles(width, height, tileSize, overlap, { align })
    const label = detectorLabel(detector)
    const sizes = [...new Set(tiles.map((t) => `${t.w}×${t.h}`))].join(', ')
    onLog?.(`${label}: tiling ${width}×${height} → ${tiles.length} tile(s) of ${sizes} (max ${tileSize}px, overlap ≥ ${overlap}px)`)

    const xs = [], ys = [], scales = [], resps = [], tileIds = [], descChunks = []
    let descLen = spec ? spec.descDim : DESC_LEN
    let totalMs = 0
    let maskedPreCap = 0
    let outsideCore = 0
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti]
      const sub = sliceRaster(data, width, height, tile)
      const bundle = spec
        ? await runLearned(spec, sub, tile.w, tile.h, { maxKeypoints, onLog })
        : await runSift(sub, tile.w, tile.h, { contrastThreshold, maxOrientations })
      descLen = bundle.descLen
      totalMs += bundle.ms
      const owned = []
      for (let i = 0; i < bundle.count; i++) {
        const f = bundle.at(i)
        const gx = f.x + tile.x, gy = f.y + tile.y
        // A neighbour owns it, and sees it with more context.
        if (!tileOwns(tile, gx, gy)) { outsideCore++; continue }
        // Drop masked keypoints BEFORE the global top-K, so masked regions don't
        // consume cap slots (a masked border can otherwise eat ~20% of the budget;
        // the caller's post-cap mask check then finds nothing left to drop).
        if (maskLut) {
          const px = Math.min(width - 1, Math.max(0, Math.round(gx)))
          const py = Math.min(height - 1, Math.max(0, Math.round(gy)))
          if (maskLut[py * width + px]) { maskedPreCap++; continue }
        }
        owned.push({ i, gx, gy, scale: f.scale, response: f.response })
      }
      // Bound memory with the global rule applied per tile: an owned, unmasked keypoint
      // ranked below maxKeypoints others of its own tile cannot survive the global cap.
      const pick = spec ? owned.map((_, k) => k) : capOrder(owned, maxKeypoints, capRule)
      for (const k of pick) {
        const o = owned[k]
        xs.push(o.gx); ys.push(o.gy)
        scales.push(o.scale); resps.push(o.response); tileIds.push(ti)
        descChunks.push(bundle.desc(o.i).slice()) // detach from the tile bundle's buffer
      }
    }

    const rawFound = xs.length
    // SIFT items carry scale so orientation siblings survive the seam dedup
    // (nmsByPosition); a learned detector has no siblings. `tile` limits suppression to
    // pairs from different tiles.
    const items = xs.map((x, i) => (spec
      ? { x, y: ys[i], response: resps[i], tile: tileIds[i] }
      : { x, y: ys[i], scale: scales[i], response: resps[i], tile: tileIds[i] }))
    const nmsIdx = nmsByPosition(items, SEAM_NMS_RADIUS) // seam dupes gone
    const afterNms = nmsIdx.length
    const rule = spec ? 'response' : capRule
    const keep = capOrder(nmsIdx.map((i) => items[i]), maxKeypoints, rule).map((k) => nmsIdx[k])
    onLog?.(`${label}: tiles kept ${rawFound} keypoints in their own cores (${outsideCore} left to a neighbour), `
      + `−${rawFound - afterNms} seam duplicates`)

    const keptResp = keep.map((i) => resps[i]).sort((a, b) => a - b)
    const { minResponse, minScale } = capBoundary(items, keep)
    const diag = {
      tiles: tiles.length, tileSize, overlap, maskedPreCap, outsideCore,
      rawFound, suppressed: rawFound - afterNms, capRule: rule,
      capHit: maxKeypoints > 0 && afterNms > keep.length, minResponse, minScale,
      respP50: percentile(keptResp, 0.5), respP95: percentile(keptResp, 0.95),
      scoreP50: percentile(keptResp, 0.5), scoreP95: percentile(keptResp, 0.95),
    }
    return {
      descLen, ms: totalMs, count: keep.length,
      at: (i) => ({ x: xs[keep[i]], y: ys[keep[i]], scale: scales[keep[i]], response: resps[keep[i]] }),
      desc: (i) => descChunks[keep[i]],
      diag,
    }
  }

  // Detect keypoints + descriptors for one image. Coords map back to original-image
  // pixels; descriptors return as a transferable Float32Array (N×descDim, row-major).
  // The detector (SIFT or a learned one) only produces the raw feature bundle — the
  // mask filter, colour sampling, back-map to original px, and trim are shared here.
  async function detect([url, options = {}], { emit } = {}) {
    const {
      detector = 'sift', maxDim = 1200, contrastThreshold = 0.01, maxKeypoints = 5000, mask = null,
      maxOrientations = 1, capRule = 'response',
      tiling = 'off', tileSize = 0, overlap = 64,
    } = options
    const raster = await rasterize(url, maxDim)
    const { data, width, height, scale, natW, natH } = raster
    // The resize's actual per-axis factors (the raster size is rounded).
    const sx = natW ? width / natW : scale, sy = natH ? height / natH : scale

    // Masked regions are excluded: keypoints landing on a masked pixel are dropped.
    const maskLut = mask ? await buildMaskLookup(mask, width, height) : null

    // Learned detectors stream init/backend lines (first-run runtime load is slow)
    // so the UI shows progress instead of a silent stall.
    const onLog = emit ? (msg) => emit('log', [msg]) : undefined

    // Tiling kicks in only when it'd actually split — a raster ≤ tile size runs the
    // plain single-pass path (identical to the pre-tiling behaviour).
    const resolvedTile = tiling !== 'off' ? await resolveTileSize(detector, tiling, tileSize) : 0
    const tilingActive = tiling !== 'off' && (width > resolvedTile || height > resolvedTile)

    const spec = learnedDetector(detector)
    const feats = tilingActive
      ? await runTiled(raster, detector, resolvedTile, { contrastThreshold, maxKeypoints, maxOrientations, capRule, overlap, maskLut, onLog })
      : spec
        ? await runLearned(spec, data, width, height, { maxKeypoints, onLog })
        : capSift(await runSift(data, width, height, { contrastThreshold, maxOrientations }),
          { maxKeypoints, capRule, maskLut, width, height })

    const keypoints = []
    // Upper bound; the descriptor buffer is trimmed to the kept count below.
    const descBuf = new Float32Array(feats.count * feats.descLen)
    let kept = 0
    for (let i = 0; i < feats.count; i++) {
      const { x: dx, y: dy, scale: kscale, response } = feats.at(i)
      // Sample the source RGB at the keypoint (detect-space pixel) so the sparse
      // cloud can be coloured later. Clamp to the raster bounds; single-pixel
      // nearest sample is plenty for per-track median aggregation.
      const px = Math.min(width - 1, Math.max(0, Math.round(dx)))
      const py = Math.min(height - 1, Math.max(0, Math.round(dy)))
      if (maskLut && maskLut[py * width + px]) continue
      const o = (py * width + px) * 4
      keypoints.push({
        // Back to native pixels, centre-aligned (core/sfm/geometry.js fromScaledPx),
        // per axis with the factor the resize actually used (rounded raster size).
        x: fromScaledPx(dx, sx), y: fromScaledPx(dy, sy),
        nx: dx / width, ny: dy / height,
        scale: kscale / scale, response,
        color: [data[o], data[o + 1], data[o + 2]],
      })
      descBuf.set(feats.desc(i), kept * feats.descLen)
      kept++
    }
    // Trim to the kept keypoints (copy so the transferred buffer is exactly sized).
    const descriptors = kept === feats.count ? descBuf : descBuf.slice(0, kept * feats.descLen)
    // SIFT is stored and matched as RootSIFT (core/features/siftDescriptors.js); the
    // stamp travels with the image so legacy L2 projects convert on load.
    const descNorm = spec ? null : SIFT_DESC_NORM.ROOT
    if (descNorm === SIFT_DESC_NORM.ROOT) rootSiftInPlace(descriptors, feats.descLen)

    const diag = {
      detectWidth: width, detectHeight: height, natW, natH, scale,
      capped: feats.count, kept, maskedDropped: feats.count - kept,
      ...feats.diag,
    }

    return {
      result: {
        keypoints, descriptors, descDim: feats.descLen, descNorm, detector,
        width: natW, height: natH, detectWidth: width, detectHeight: height, ms: feats.ms, diag,
      },
      transfer: [descriptors.buffer],
    }
  }

  // ── fiducial template matching (F4 auto-measurement) ─────────────────────
  //
  // These two ops deliberately do NOT use `rasterize`: a film scan is routinely
  // 10k×10k, and one full-resolution RGBA raster of that is ~400 MB. Instead we
  // decode to an ImageBitmap ONCE per op and pull only the small rectangles we
  // actually correlate over, via source-rect drawImage into a tiny canvas. Peak
  // memory is the bitmap plus a (2·half+1)² window.

  async function decodeBitmap(url) {
    const blob = await (await fetch(url)).blob()
    return await createImageBitmap(blob)
  }

  // Read one axis-aligned window out of `bmp` as a grayscale float image. The
  // requested rect is CLAMPED into the bitmap rather than left to drawImage's
  // clip-and-rescale behaviour (which leaves the uncovered part transparent
  // black and would correlate the template against a phantom border), so the
  // returned `originX/originY` is the true native-px position of pixel (0,0)
  // and may differ from what was asked for near an edge.
  function cropGray(bmp, sx, sy, sw, sh) {
    const w = Math.min(sw, bmp.width), h = Math.min(sh, bmp.height)
    const x = Math.max(0, Math.min(bmp.width - w, Math.round(sx)))
    const y = Math.max(0, Math.min(bmp.height - h, Math.round(sy)))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    const gray = grayFromRgba(data, w, h)
    return { ...gray, originX: x, originY: y }
  }

  // Cut one full-resolution template per marked fiducial out of the reference
  // image. Called once per run; the templates are then reused for every target.
  async function prepareFiducialTemplates([url, obs, options = {}], { emit } = {}) {
    const templateHalf = options.templateHalf ?? FIDUCIAL_DETECT_TUNING.templateHalf
    const size = 2 * templateHalf + 1
    const bmp = await decodeBitmap(url)
    try {
      if (bmp.width < size || bmp.height < size) {
        throw new Error(`reference image ${bmp.width}×${bmp.height} is smaller than the ${size}px template`)
      }
      const templates = []
      const transfer = []
      for (const o of obs) {
        const win = cropGray(bmp, o.px - templateHalf, o.py - templateHalf, size, size)
        templates.push({ fidId: o.fidId, size, data: win.data })
        transfer.push(win.data.buffer)
      }
      emit?.('log', [`Fiducial: cut ${templates.length} template(s) @ ${size}px from the reference image (${bmp.width}×${bmp.height})`])
      return { result: { templates, natW: bmp.width, natH: bmp.height }, transfer }
    } finally {
      bmp.close()
    }
  }

  // Find every template in one target image. `templates` arrive structured-cloned
  // per call (they are reused across images, so the CLIENT must not transfer them
  // — transferring would detach the buffers after the first image).
  async function detectFiducials([url, templates, predictions, options = {}], { emit } = {}) {
    const cfg = { ...FIDUCIAL_DETECT_TUNING, ...options }
    const t0 = performance.now()
    const bmp = await decodeBitmap(url)
    try {
      const natW = bmp.width, natH = bmp.height
      // Whole image at coarse scale, for the rotation probe + the coarse peak.
      const cw = Math.max(1, Math.round(natW * cfg.coarseScale))
      const ch = Math.max(1, Math.round(natH * cfg.coarseScale))
      const canvas = new OffscreenCanvas(cw, ch)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bmp, 0, 0, cw, ch)
      const gray = grayFromRgba(ctx.getImageData(0, 0, cw, ch).data, cw, ch)
      // The ACTUAL drawn scale, not the requested `coarseScale` — drawImage
      // rounds to whole pixels. (x and y can differ by up to half a coarse
      // pixel, i.e. a few full-res px — far inside the ±refineHalf window the
      // coarse peak only has to land in, so one scale is enough.)
      const coarse = { ...gray, scale: cw / natW, natW, natH }

      const results = detectFiducialsInImage({
        coarse,
        templates: templates.map((t) => ({ fidId: t.fidId, patch: { data: t.data, size: t.size } })),
        predictions,
        cfg,
        // Synchronous by design: OffscreenCanvas drawImage/getImageData are sync,
        // which is what lets the pure orchestrator call back into the worker.
        cropWindow: (cx, cy, half) => cropGray(bmp, cx - half, cy - half, 2 * half + 1, 2 * half + 1),
        onLog: emit ? (msg) => emit('log', [`Fiducial: ${msg}`]) : undefined,
      })
      return { result: { results, ms: performance.now() - t0 } }
    } finally {
      bmp.close()
    }
  }

  // The coarse thumbnail rasterize() would make, drawn from an already-decoded
  // bitmap — same scale and rounding — so one detection decodes the scan once.
  // (A 97 MP PNG decode dominates this op; rasterize + decodeBitmap paid it twice.)
  function downscaleBitmap(bmp, maxDim) {
    const natW = bmp.width, natH = bmp.height
    const scale = Math.min(1, maxDim / Math.max(natW, natH))
    const width = Math.round(natW * scale), height = Math.round(natH * scale)
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bmp, 0, 0, width, height)
    return { data: ctx.getImageData(0, 0, width, height).data, width, height, scale, natW, natH }
  }

  async function detectFiducialSpots([url, options = {}], { emit } = {}) {
    const cfg = { ...FIDUCIAL_DETECTION_TUNING, ...options }
    const t0 = performance.now()
    const bmp = await decodeBitmap(url)
    try {
      const rgba = downscaleBitmap(bmp, cfg.maxDim)
      const gray = { ...grayFromRgba(rgba.data, rgba.width, rgba.height), scale: rgba.scale, natW: rgba.natW, natH: rgba.natH }
      const coarse = detectFiducialSpotsCore(gray, cfg)
      const refine = (d) => {
        const plan = nativeRefinePlan(d, gray.scale, cfg)
        if (!plan) return { ...d, px: d.px / gray.scale, py: d.py / gray.scale }
        const { px0, py0, half } = plan
        const win = cropGray(bmp, px0 - half, py0 - half, 2 * half + 1, 2 * half + 1)
        const hit = refineDetectionSpot(win, px0 - win.originX, py0 - win.originY, plan.radius,
          { ...cfg, prototypeSizes: plan.sizes, variants: plan.variants, polarity: plan.polarity ?? cfg.polarity })
        // Keep the coarse peakMargin: it was measured over the whole slot search,
        // while the refine window is too small to hold a distinct runner-up.
        return hit ? { ...d, px: win.originX + hit.x, py: win.originY + hit.y, score: hit.score }
          : { ...d, px: px0, py: py0 }
      }
      const accepted = coarse.accepted.map(refine), drafts = coarse.drafts.map(refine)
      const frame = coarse.frame ? {
        ...coarse.frame,
        left: coarse.frame.left / gray.scale, right: coarse.frame.right / gray.scale,
        top: coarse.frame.top / gray.scale, bottom: coarse.frame.bottom / gray.scale,
      } : null
      emit?.('log', [`Fiducial detection: ${accepted.length}/${coarse.requested} accepted, ${drafts.length} draft(s) on ${bmp.width}×${bmp.height}`])
      return { result: { ...coarse, accepted, drafts, frame, natW: bmp.width, natH: bmp.height, ms: performance.now() - t0 } }
    } finally { bmp.close() }
  }

  return { detect, prepareFiducialTemplates, detectFiducials, detectFiducialSpots }
}

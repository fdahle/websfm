// Detection ops (SIFT / learned: SuperPoint, DISK, ALIKED) and the photo-quality score.
// `rasterize` (OffscreenCanvas pixel decode) stays in the worker and is injected; the
// STRIDE parse + shared feature-bundle shape live here next to the two detector runners.

import { detectSift } from '../../core/features/sift.js'
import { detectLearned, rgbaToPlanar } from '../../core/features/learnedDetect.js'
import { learnedDetector, detectorLabel } from '../../core/features/learnedDetectors.js'
import {
  planTiles,
  tileOwns,
  sliceRaster,
  nmsByPosition,
  autoTileSize,
  SIFT_TILE_ALIGN,
  SEAM_NMS_RADIUS,
} from '../../core/features/tiling.js'
import { capOrder, capBoundary } from '../../core/features/keypointCap.js'
import { SIFT_DESC_NORM, rootSiftInPlace, rootSiftToU8 } from '../../core/features/siftDescriptors.js'
import { buildMaskLookup } from '../../utils/maskCanvas.js'
import { analyzeImageQuality } from '../../core/features/imageQuality.js'
import { fromScaledPx } from '../../core/sfm/geometry.js'
import { KP_STRIDE } from '../../core/features/keypoints.js'
import { turnRaster, unturnPoint } from '../../core/features/turn.js'
import { matchDescriptors } from '../../core/features/bruteforce.js'
import { estimateHomographyRansac } from '../../core/features/guidedTiles.js'
import { homographyRotation } from '../../core/sfm/referenceLook.js'
import { pluralize } from '../../core/textFormat.js'
import { IMAGE_QUALITY_TUNING } from '../../core/tuning.js'
import { DETECT_SIFT_DEFAULTS } from '../../core/defaults.user.js'
import { faintRetry } from '../../core/features/faintRetry.js'
import { quantileNearest } from '../../core/stats.js'

export function makeKeypointOps({ rasterize }) {
  // Must match STRIDE in crates/sift/src/lib.rs: [x, y, scale, response, angle, d0..d127]
  const STRIDE = 133
  const DESC_LEN = 128
  // GPU storage-buffer binding limit, queried once for auto tile sizing (0 once we
  // know there's no adapter; undefined = not yet asked).
  let gpuBindingBytes

  // Percentile helper over a value array (sorted ascending in place by caller).
  const percentile = (sorted, q) => (sorted.length ? quantileNearest(sorted, q) : 0)

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
      descLen: DESC_LEN,
      ms,
      count: n,
      at: (i) => ({
        x: flat[i * STRIDE],
        y: flat[i * STRIDE + 1],
        scale: flat[i * STRIDE + 2],
        response: flat[i * STRIDE + 3],
      }),
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
        if (maskLut[py * width + px]) {
          maskedPreCap++
          continue
        }
      }
      items.push(f)
      src.push(i)
    }
    const keep = capOrder(items, maxKeypoints, capRule)
    const { minResponse, minScale } = capBoundary(items, keep)
    const keptResp = keep.map((k) => items[k].response).sort((a, b) => a - b)
    return {
      descLen: bundle.descLen,
      ms: bundle.ms,
      count: keep.length,
      at: (i) => items[keep[i]],
      desc: (i) => bundle.desc(src[keep[i]]),
      diag: {
        ...bundle.diag,
        maskedPreCap,
        capRule,
        capHit: maxKeypoints > 0 && items.length > maxKeypoints,
        minResponse,
        minScale,
        respP50: percentile(keptResp, 0.5),
        respP95: percentile(keptResp, 0.95),
      },
    }
  }

  // SIFT on one raster, capped; a faint image is detected again at a lower contrast
  // threshold (core/features/faintRetry.js) and keeps the second set if it is larger.
  async function siftWithRetry(
    data,
    width,
    height,
    { contrastThreshold, maxOrientations, faintRetry: enabled, ...cap },
  ) {
    const opts = { ...cap, width, height }
    const first = capSift(await runSift(data, width, height, { contrastThreshold, maxOrientations }), opts)
    const retry = faintRetry(first.count, { contrastThreshold, maxKeypoints: cap.maxKeypoints, enabled })
    if (!retry) return first
    const second = capSift(
      await runSift(data, width, height, { contrastThreshold: retry.contrast, maxOrientations }),
      opts,
    )
    if (second.count <= first.count) return first
    second.ms += first.ms
    second.diag = { ...second.diag, faintRetry: { ...retry, before: first.count } }
    return second
  }

  // Learned detector (ONNX via core/features/learnedDetect.js) → the same feature
  // bundle. Descriptor width is the spec's (SuperPoint 256, DISK and ALIKED 128) — carried
  // through as descLen so persistence and matching read the width off the buffer
  // rather than a hardcoded const.
  async function runLearned(spec, data, width, height, { maxKeypoints, onLog }) {
    // Planar float [0,1]: luma for SuperPoint, RGB for DISK and ALIKED.
    const pixels = rgbaToPlanar(data, width, height, spec.channels)
    const t0 = performance.now()
    const { keypoints, descriptors, dim } = await detectLearned(spec, pixels, width, height, { maxKeypoints, onLog })
    const ms = performance.now() - t0

    const n = keypoints.length
    const scores = keypoints.map((k) => k.score).sort((a, b) => a - b)
    return {
      descLen: dim,
      ms,
      count: n,
      // No blob scale from a learned detector — report score as the "response".
      at: (i) => ({ x: keypoints[i].x, y: keypoints[i].y, scale: 0, response: keypoints[i].score }),
      desc: (i) => descriptors.subarray(i * dim, (i + 1) * dim),
      diag: {
        capHit: maxKeypoints > 0 && n >= maxKeypoints,
        scoreP50: percentile(scores, 0.5),
        scoreP95: percentile(scores, 0.95),
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
    } catch {
      return 0
    }
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
  async function runTiled(
    raster,
    detector,
    tileSize,
    { contrastThreshold, maxKeypoints, maxOrientations, capRule, overlap, maskLut, onLog },
  ) {
    const { data, width, height } = raster
    const spec = learnedDetector(detector)
    const align = spec ? spec.tileAlign : SIFT_TILE_ALIGN
    const tiles = planTiles(width, height, tileSize, overlap, { align })
    const label = detectorLabel(detector)
    const sizes = [...new Set(tiles.map((t) => `${t.w}×${t.h}`))].join(', ')
    onLog?.(
      `${label}: tiling ${width}×${height} → ${pluralize(tiles.length, 'tile')} of ${sizes} (max ${tileSize}px, overlap ≥ ${overlap}px)`,
    )

    const xs = [],
      ys = [],
      scales = [],
      resps = [],
      tileIds = [],
      descChunks = []
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
        const gx = f.x + tile.x,
          gy = f.y + tile.y
        // A neighbour owns it, and sees it with more context.
        if (!tileOwns(tile, gx, gy)) {
          outsideCore++
          continue
        }
        // Drop masked keypoints BEFORE the global top-K, so masked regions don't
        // consume cap slots (a masked border can otherwise eat ~20% of the budget;
        // the caller's post-cap mask check then finds nothing left to drop).
        if (maskLut) {
          const px = Math.min(width - 1, Math.max(0, Math.round(gx)))
          const py = Math.min(height - 1, Math.max(0, Math.round(gy)))
          if (maskLut[py * width + px]) {
            maskedPreCap++
            continue
          }
        }
        owned.push({ i, gx, gy, scale: f.scale, response: f.response })
      }
      // Bound memory with the global rule applied per tile: an owned, unmasked keypoint
      // ranked below maxKeypoints others of its own tile cannot survive the global cap.
      const pick = spec ? owned.map((_, k) => k) : capOrder(owned, maxKeypoints, capRule)
      for (const k of pick) {
        const o = owned[k]
        xs.push(o.gx)
        ys.push(o.gy)
        scales.push(o.scale)
        resps.push(o.response)
        tileIds.push(ti)
        descChunks.push(bundle.desc(o.i).slice()) // detach from the tile bundle's buffer
      }
    }

    const rawFound = xs.length
    // SIFT items carry scale so orientation siblings survive the seam dedup
    // (nmsByPosition); a learned detector has no siblings. `tile` limits suppression to
    // pairs from different tiles.
    const items = xs.map((x, i) =>
      spec
        ? { x, y: ys[i], response: resps[i], tile: tileIds[i] }
        : { x, y: ys[i], scale: scales[i], response: resps[i], tile: tileIds[i] },
    )
    const nmsIdx = nmsByPosition(items, SEAM_NMS_RADIUS) // seam dupes gone
    const afterNms = nmsIdx.length
    const rule = spec ? 'response' : capRule
    const keep = capOrder(
      nmsIdx.map((i) => items[i]),
      maxKeypoints,
      rule,
    ).map((k) => nmsIdx[k])
    onLog?.(
      `${label}: tiles kept ${rawFound} keypoints in their own cores (${outsideCore} left to a neighbour), ` +
        `−${rawFound - afterNms} seam duplicates`,
    )

    const keptResp = keep.map((i) => resps[i]).sort((a, b) => a - b)
    const { minResponse, minScale } = capBoundary(items, keep)
    const diag = {
      tiles: tiles.length,
      tileSize,
      overlap,
      maskedPreCap,
      outsideCore,
      rawFound,
      suppressed: rawFound - afterNms,
      capRule: rule,
      capHit: maxKeypoints > 0 && afterNms > keep.length,
      minResponse,
      minScale,
      respP50: percentile(keptResp, 0.5),
      respP95: percentile(keptResp, 0.95),
      scoreP50: percentile(keptResp, 0.5),
      scoreP95: percentile(keptResp, 0.95),
    }
    return {
      descLen,
      ms: totalMs,
      count: keep.length,
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
      detector = 'sift',
      maxDim = 1200,
      contrastThreshold = 0.01,
      maxKeypoints = 5000,
      mask = null,
      maxOrientations = 1,
      capRule = 'response',
      tiling = 'off',
      tileSize = 0,
      overlap = 64,
      faintRetry = DETECT_SIFT_DEFAULTS.faintRetry,
      // Clockwise quarter turns of the raster before detecting (core/features/turn.js):
      // the keypoints come back in the photo's own pixels, the descriptors as turned.
      turn = 0,
    } = options
    const read = await rasterize(url, maxDim)
    // The resize's actual per-axis factors (the raster size is rounded), unturned.
    const { width: uw, height: uh, scale, natW, natH } = read
    const sx = natW ? uw / natW : scale,
      sy = natH ? uh / natH : scale

    // Masked regions are excluded: keypoints landing on a masked pixel are dropped.
    // The mask turns with the raster, so both stay in the detector's frame.
    const maskRead = mask ? await buildMaskLookup(mask, uw, uh) : null
    const turned = turnRaster(read.data, uw, uh, turn)
    const raster = { ...read, data: turned.data, width: turned.width, height: turned.height }
    const { data, width, height } = raster
    const maskLut = maskRead ? turnRaster(maskRead, uw, uh, turn, 1).data : null

    // Learned detectors stream init/backend lines (first-run runtime load is slow)
    // so the UI shows progress instead of a silent stall.
    const onLog = emit ? (msg, l = 'info') => emit('log', [msg, l, 'Detection']) : undefined

    // Tiling kicks in only when it'd actually split — a raster ≤ tile size runs the
    // plain single-pass path (identical to the pre-tiling behaviour).
    const resolvedTile = tiling !== 'off' ? await resolveTileSize(detector, tiling, tileSize) : 0
    const tilingActive = tiling !== 'off' && (width > resolvedTile || height > resolvedTile)

    const spec = learnedDetector(detector)
    const feats = tilingActive
      ? await runTiled(raster, detector, resolvedTile, {
          contrastThreshold,
          maxKeypoints,
          maxOrientations,
          capRule,
          overlap,
          maskLut,
          onLog,
        })
      : spec
        ? await runLearned(spec, data, width, height, { maxKeypoints, onLog })
        : await siftWithRetry(data, width, height, {
            contrastThreshold,
            maxOrientations,
            maxKeypoints,
            capRule,
            maskLut,
            faintRetry,
          })

    // Keypoints leave as the typed layout the store keeps (core/features/keypoints.js),
    // never one object per keypoint. Upper bounds, trimmed to the kept count below.
    const kpBuf = new Float32Array(feats.count * KP_STRIDE)
    const rgbBuf = new Uint8Array(feats.count * 3)
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
      const k = kept * KP_STRIDE
      // Out of the turned frame into the photo's own detect pixels, then back to native
      // pixels, centre-aligned (core/sfm/geometry.js fromScaledPx), per axis with the
      // factor the resize actually used (rounded raster size).
      const [ux, uy] = unturnPoint(dx, dy, uw, uh, turn)
      kpBuf[k] = fromScaledPx(ux, sx)
      kpBuf[k + 1] = fromScaledPx(uy, sy)
      kpBuf[k + 2] = ux / uw
      kpBuf[k + 3] = uy / uh
      kpBuf[k + 4] = kscale / scale
      kpBuf[k + 5] = response
      rgbBuf[3 * kept] = data[o]
      rgbBuf[3 * kept + 1] = data[o + 1]
      rgbBuf[3 * kept + 2] = data[o + 2]
      descBuf.set(feats.desc(i), kept * feats.descLen)
      kept++
    }
    // Trim to the kept keypoints (copy so the transferred buffer is exactly sized).
    const floatDesc = kept === feats.count ? descBuf : descBuf.slice(0, kept * feats.descLen)
    const keypoints = {
      data: kept === feats.count ? kpBuf : kpBuf.slice(0, kept * KP_STRIDE),
      rgb: kept === feats.count ? rgbBuf : rgbBuf.slice(0, kept * 3),
    }
    // SIFT is stored and matched as RootSIFT, one byte per value (× 512, COLMAP's rule:
    // core/features/siftDescriptors.js); the stamp travels with the image so legacy L2
    // projects convert on load. Learned descriptors stay Float32.
    const descNorm = spec ? null : SIFT_DESC_NORM.ROOT
    const descriptors =
      descNorm === SIFT_DESC_NORM.ROOT ? rootSiftToU8(rootSiftInPlace(floatDesc, feats.descLen)) : floatDesc

    const diag = {
      detectWidth: uw,
      detectHeight: uh,
      turn,
      natW,
      natH,
      scale,
      capped: feats.count,
      kept,
      maskedDropped: feats.count - kept,
      ...feats.diag,
    }

    return {
      result: {
        keypoints,
        descriptors,
        descDim: feats.descLen,
        descNorm,
        detector,
        width: natW,
        height: natH,
        detectWidth: uw,
        detectHeight: uh,
        ms: feats.ms,
        diag,
      },
      transfer: [descriptors.buffer, keypoints.data.buffer, keypoints.rgb.buffer],
    }
  }

  // Tools ▸ Images ▾ ▸ Image quality: sharpness/exposure of one image
  // (core/features/imageQuality.js). Decoded at twice the analysis size so the
  // module's own area filter, not the canvas's bilinear shrink, makes the final
  // fixed-size grid every image is scored on. A mask (1 = masked) excludes sky or
  // the operator's legs from the score, exactly as it does from detection.
  async function imageQuality([url, options = {}]) {
    const analysisMaxDim = options.analysisMaxDim ?? IMAGE_QUALITY_TUNING.analysisMaxDim
    const raster = await rasterize(url, analysisMaxDim * 2)
    let usable = null
    if (options.mask) {
      const masked = await buildMaskLookup(options.mask, raster.width, raster.height)
      usable = new Uint8Array(masked.length)
      for (let i = 0; i < masked.length; i++) usable[i] = masked[i] ? 0 : 1
    }
    const q = analyzeImageQuality(raster, { analysisMaxDim, mask: usable })
    return { result: { ...q, natW: raster.natW, natH: raster.natH } }
  }

  // Turn search (stores/matching/turnSearch.js): a small SIFT look at one photo, to
  // measure how two photos are turned against each other — SIFT does not care, the
  // learned detectors do. → { points (native px, x y interleaved), descriptors, count }.
  async function turnProbeFeatures([url, { maxDim = 1536, maxKeypoints = 2000, mask = null } = {}]) {
    const raster = await rasterize(url, maxDim)
    const { data, width, height, scale, natW, natH } = raster
    const sx = natW ? width / natW : scale,
      sy = natH ? height / natH : scale
    const maskLut = mask ? await buildMaskLookup(mask, width, height) : null
    const { flat } = await detectSift(data, width, height, {
      maxKeypoints,
      contrastThreshold: 0.01,
      maxOrientations: 1,
    })
    const total = Math.max(0, Math.floor((flat.length - 2) / 133))
    const points = new Float32Array(total * 2),
      descriptors = new Float32Array(total * 128)
    let count = 0
    for (let i = 0; i < total; i++) {
      const x = flat[i * 133],
        y = flat[i * 133 + 1]
      const px = Math.min(width - 1, Math.max(0, Math.round(x))),
        py = Math.min(height - 1, Math.max(0, Math.round(y)))
      if (maskLut && maskLut[py * width + px]) continue
      points[2 * count] = fromScaledPx(x, sx)
      points[2 * count + 1] = fromScaledPx(y, sy)
      descriptors.set(flat.subarray(i * 133 + 5, i * 133 + 133), count * 128)
      count++
    }
    const out = { points: points.slice(0, 2 * count), descriptors: descriptors.slice(0, 128 * count), count }
    return { result: out, transfer: [out.points.buffer, out.descriptors.buffer] }
  }

  // How photo B is turned against photo A, from two turnProbeFeatures looks: mutual
  // ratio-test matches, one homography (RANSAC at `threshPx`, native px — loose, it
  // only has to hold the rotation), and the rotation it applies at A's inlier centre
  // (clockwise degrees, 0–360). → { matches, inliers, rotationDeg }.
  async function turnProbeMatch([a, b, { ratioThreshold = 0.8, threshPx = 50 } = {}]) {
    const { matches } = await matchDescriptors(a.descriptors, b.descriptors, { ratioThreshold, crossCheck: true })
    if (matches.length < 8) return { result: { matches: matches.length, inliers: 0, rotationDeg: null } }
    const ptsA = matches.map((m) => [a.points[2 * m.ia], a.points[2 * m.ia + 1]])
    const ptsB = matches.map((m) => [b.points[2 * m.ib], b.points[2 * m.ib + 1]])
    const fit = estimateHomographyRansac(ptsA, ptsB, { threshPx, iters: 1000 })
    if (!fit) return { result: { matches: matches.length, inliers: 0, rotationDeg: null } }
    let cx = 0,
      cy = 0
    for (let i = 0; i < ptsA.length; i++)
      if (fit.inlierMask[i]) {
        cx += ptsA[i][0]
        cy += ptsA[i][1]
      }
    const rotationDeg = homographyRotation(fit.H, cx / fit.inlierCount, cy / fit.inlierCount)
    return { result: { matches: matches.length, inliers: fit.inlierCount, rotationDeg } }
  }

  return {
    detect,
    imageQuality,
    turnProbeFeatures,
    turnProbeMatch,
  }
}

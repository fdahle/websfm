import { detectSift } from '../../core/features/sift.js'
import { detectSuperPoint } from '../../core/features/superpoint.js'
import { planTiles, sliceRaster, nmsByPosition, autoTileSize } from '../../core/features/tiling.js'
import { buildMaskLookup } from '../../core/mask.js'

// Detection ops (SIFT / SuperPoint). `rasterize` (OffscreenCanvas pixel decode)
// stays in the worker and is injected; the STRIDE parse + shared feature-bundle
// shape live here next to the two detector runners.
export function makeDetectOps({ rasterize }) {
  // Must match STRIDE in crates/sift/src/lib.rs: [x, y, scale, response, angle, d0..d127]
  const STRIDE = 133
  const DESC_LEN = 128
  // GPU storage-buffer binding limit, queried once for auto tile sizing (0 once we
  // know there's no adapter; undefined = not yet asked).
  let gpuBindingBytes

  // Detect-space px within which two merged keypoints are the same blob (seam
  // duplicate). ~3 px matches the crate's near-duplicate suppression radius.
  const NMS_RADIUS = 3

  // Percentile helper over a value array (sorted ascending in place by caller).
  function percentile(sorted, q) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] : 0
  }

  // SIFT detector → a uniform feature bundle (see detect() for the shared shape):
  // count, per-keypoint accessors, a descriptor-row view, and detector-specific diag.
  async function runSift(data, width, height, { contrastThreshold, maxKeypoints }) {
    // wasm init + detect_sift now live in core/features/sift.js; the STRIDE parse
    // into the shared feature bundle (below) stays worker-side.
    const { flat, ms } = await detectSift(data, width, height, { contrastThreshold, maxKeypoints })

    // Layout: STRIDE floats per kept keypoint [x,y,scale,response,angle,d0..d127],
    // then two trailing scalars — rawFound (survivors of near-duplicate suppression,
    // before the max_keypoints cap) and suppressed. Empty (degenerate input) ⇒ 0.
    const rawFound = flat.length >= 2 ? flat[flat.length - 2] : 0
    const suppressed = flat.length >= 2 ? flat[flat.length - 1] : 0
    const n = flat.length >= 2 ? Math.floor((flat.length - 2) / STRIDE) : 0
    // Smallest kept response = last entry (crate returns them response-desc); the
    // point at which the max_keypoints cap started discarding features.
    const minResponse = n > 0 ? flat[(n - 1) * STRIDE + 3] : 0
    const responses = []
    for (let i = 0; i < n; i++) responses.push(flat[i * STRIDE + 3])
    responses.sort((a, b) => a - b)

    return {
      descLen: DESC_LEN, ms, count: n,
      at: (i) => ({ x: flat[i * STRIDE], y: flat[i * STRIDE + 1], scale: flat[i * STRIDE + 2], response: flat[i * STRIDE + 3] }),
      desc: (i) => flat.subarray(i * STRIDE + 5, i * STRIDE + 5 + DESC_LEN),
      diag: {
        rawFound, suppressed,
        capHit: maxKeypoints > 0 && rawFound > maxKeypoints, minResponse,
        respP50: percentile(responses, 0.5), respP95: percentile(responses, 0.95),
      },
    }
  }

  // SuperPoint detector (ONNX via core/features/superpoint.js) → the same feature bundle.
  // Descriptors are 256-d here, not 128 — carried through as descLen so persistence
  // and matching read the width off the buffer rather than a hardcoded const.
  async function runSuperPoint(data, width, height, { maxKeypoints, onLog }) {
    // SuperPoint wants single-channel float [0,1]; build it from the RGBA raster
    // (Rec. 601 luma, matching core/sfm/geometry.js rgbaToGray, then /255).
    const gray = new Float32Array(width * height)
    for (let i = 0; i < width * height; i++) {
      const o = i * 4
      gray[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255
    }
    const t0 = performance.now()
    const { keypoints, descriptors, dim } = await detectSuperPoint(gray, width, height, { maxKeypoints, onLog })
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
  // SuperPoint runs on ORT's WebGPU EP, whose real allocation ceiling is well below
  // the adapter's *reported* binding limit (Apple/unified-memory GPUs advertise
  // multiple GB but OOM'd at 1200px here), so the reported limit only *lowers* the
  // tile on constrained GPUs — the effective cap is a conservative SP_GPU_TILE_MAX
  // that stays under that empirical failure point. SIFT is CPU, so memory isn't the
  // constraint and it gets the larger default.
  const SP_GPU_TILE_MAX = 1024
  async function resolveTileSize(detector, tiling, tileSize) {
    if (tiling === 'manual' && tileSize > 0) return tileSize
    if (detector !== 'superpoint') return autoTileSize({ maxBindingBytes: 0 })
    if (gpuBindingBytes === undefined) gpuBindingBytes = await queryGpuBindingBytes()
    return autoTileSize({ maxBindingBytes: gpuBindingBytes, max: SP_GPU_TILE_MAX })
  }

  // Run the detector tile-by-tile over an already-rasterised full raster and merge
  // into ONE feature bundle in full detect-space coords — the shared shape, so the
  // caller's mask/colour/back-map loop consumes it unchanged. Per-tile keypoints are
  // offset by the tile origin, seam duplicates are NMS'd away, and a global top-K by
  // response keeps the strongest (LightGlue caps keypoints anyway, so favour the
  // best overall rather than the union).
  async function runTiled(raster, detector, tileSize, { contrastThreshold, maxKeypoints, overlap, maskLut, onLog }) {
    const { data, width, height } = raster
    const tiles = planTiles(width, height, tileSize, overlap)
    const label = detector === 'superpoint' ? 'SuperPoint' : 'SIFT'
    onLog?.(`${label}: tiling ${width}×${height} → ${tiles.length} tile(s) @ ${tileSize}px, overlap ${overlap}px`)

    const xs = [], ys = [], scales = [], resps = [], descChunks = []
    let descLen = detector === 'superpoint' ? 256 : DESC_LEN
    let totalMs = 0
    let maskedPreCap = 0
    for (const tile of tiles) {
      const sub = sliceRaster(data, width, height, tile)
      const bundle = detector === 'superpoint'
        ? await runSuperPoint(sub, tile.w, tile.h, { maxKeypoints, onLog })
        : await runSift(sub, tile.w, tile.h, { contrastThreshold, maxKeypoints })
      descLen = bundle.descLen
      totalMs += bundle.ms
      for (let i = 0; i < bundle.count; i++) {
        const f = bundle.at(i)
        const gx = f.x + tile.x, gy = f.y + tile.y
        // Drop masked keypoints BEFORE the global top-K, so masked regions don't
        // consume cap slots (a masked border can otherwise eat ~20% of the budget;
        // the caller's post-cap mask check then finds nothing left to drop).
        if (maskLut) {
          const px = Math.min(width - 1, Math.max(0, Math.round(gx)))
          const py = Math.min(height - 1, Math.max(0, Math.round(gy)))
          if (maskLut[py * width + px]) { maskedPreCap++; continue }
        }
        xs.push(gx); ys.push(gy)
        scales.push(f.scale); resps.push(f.response)
        descChunks.push(bundle.desc(i).slice()) // detach from the tile bundle's buffer
      }
    }

    const rawFound = xs.length
    const items = xs.map((x, i) => ({ x, y: ys[i], response: resps[i] }))
    let keep = nmsByPosition(items, NMS_RADIUS) // strongest-first, seam dupes gone
    const afterNms = keep.length
    if (maxKeypoints > 0 && keep.length > maxKeypoints) keep = keep.slice(0, maxKeypoints)

    const keptResp = keep.map((i) => resps[i]).sort((a, b) => a - b)
    const diag = {
      tiles: tiles.length, tileSize, overlap, maskedPreCap,
      rawFound, suppressed: rawFound - afterNms,
      capHit: maxKeypoints > 0 && afterNms > keep.length,
      minResponse: keep.length ? resps[keep[keep.length - 1]] : 0,
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
  // The detector (SIFT or SuperPoint) only produces the raw feature bundle — the
  // mask filter, colour sampling, back-map to original px, and trim are shared here.
  async function detect([url, options = {}], { emit } = {}) {
    const {
      detector = 'sift', maxDim = 1200, contrastThreshold = 0.01, maxKeypoints = 5000, mask = null,
      tiling = 'off', tileSize = 0, overlap = 64,
    } = options
    const raster = await rasterize(url, maxDim)
    const { data, width, height, scale, natW, natH } = raster

    // Masked regions are excluded: keypoints landing on a masked pixel are dropped.
    const maskLut = mask ? await buildMaskLookup(mask, width, height) : null

    // Learned detectors stream init/backend lines (first-run runtime load is slow)
    // so the UI shows progress instead of a silent stall.
    const onLog = emit ? (msg) => emit('log', [msg]) : undefined

    // Tiling kicks in only when it'd actually split — a raster ≤ tile size runs the
    // plain single-pass path (identical to the pre-tiling behaviour).
    const resolvedTile = tiling !== 'off' ? await resolveTileSize(detector, tiling, tileSize) : 0
    const tilingActive = tiling !== 'off' && (width > resolvedTile || height > resolvedTile)

    const feats = tilingActive
      ? await runTiled(raster, detector, resolvedTile, { contrastThreshold, maxKeypoints, overlap, maskLut, onLog })
      : detector === 'superpoint'
        ? await runSuperPoint(data, width, height, { maxKeypoints, onLog })
        : await runSift(data, width, height, { contrastThreshold, maxKeypoints })

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
        x: dx / scale, y: dy / scale,
        nx: dx / width, ny: dy / height,
        scale: kscale / scale, response,
        color: [data[o], data[o + 1], data[o + 2]],
      })
      descBuf.set(feats.desc(i), kept * feats.descLen)
      kept++
    }
    // Trim to the kept keypoints (copy so the transferred buffer is exactly sized).
    const descriptors = kept === feats.count ? descBuf : descBuf.slice(0, kept * feats.descLen)

    const diag = {
      detectWidth: width, detectHeight: height, natW, natH, scale,
      capped: feats.count, kept, maskedDropped: feats.count - kept,
      ...feats.diag,
    }

    return {
      result: {
        keypoints, descriptors, descDim: feats.descLen, detector,
        width: natW, height: natH, detectWidth: width, detectHeight: height, ms: feats.ms, diag,
      },
      transfer: [descriptors.buffer],
    }
  }

  return { detect }
}

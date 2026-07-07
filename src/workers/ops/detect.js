import { detectSift } from '../../core/features/sift.js'
import { detectSuperPoint } from '../../core/features/superpoint.js'
import { buildMaskLookup } from '../../core/mask.js'

// Detection ops (SIFT / SuperPoint). `rasterize` (OffscreenCanvas pixel decode)
// stays in the worker and is injected; the STRIDE parse + shared feature-bundle
// shape live here next to the two detector runners.
export function makeDetectOps({ rasterize }) {
  // Must match STRIDE in crates/sift/src/lib.rs: [x, y, scale, response, angle, d0..d127]
  const STRIDE = 133
  const DESC_LEN = 128

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

  // Detect keypoints + descriptors for one image. Coords map back to original-image
  // pixels; descriptors return as a transferable Float32Array (N×descDim, row-major).
  // The detector (SIFT or SuperPoint) only produces the raw feature bundle — the
  // mask filter, colour sampling, back-map to original px, and trim are shared here.
  async function detect([url, options = {}], { emit } = {}) {
    const { detector = 'sift', maxDim = 1200, contrastThreshold = 0.01, maxKeypoints = 5000, mask = null } = options
    const { data, width, height, scale, natW, natH } = await rasterize(url, maxDim)

    // Masked regions are excluded: keypoints landing on a masked pixel are dropped.
    const maskLut = mask ? await buildMaskLookup(mask, width, height) : null

    // Learned detectors stream init/backend lines (first-run runtime load is slow)
    // so the UI shows progress instead of a silent stall.
    const onLog = emit ? (msg) => emit('log', [msg]) : undefined
    const feats = detector === 'superpoint'
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

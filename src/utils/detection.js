import init, { detect_sift } from '../wasm/detection/sift.js'

// Must match STRIDE in crates/sift/src/lib.rs: [x, y, scale, response, angle, d0..d127]
const STRIDE = 133
const DESC_LEN = 128

let initPromise = null

// Lazily initialize the WASM module exactly once.
function ensureWasm() {
  if (!initPromise) initPromise = init()
  return initPromise
}

/**
 * Draw an image into a canvas, downscaling so the longest side is at most
 * `maxDim`, and return its RGBA pixels plus the scale factor back to the
 * original image.
 */
function rasterize(imgEl, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight))
  const width = Math.round(imgEl.naturalWidth * scale)
  const height = Math.round(imgEl.naturalHeight * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(imgEl, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  return { data, width, height, scale }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

/**
 * Detect SIFT keypoints for an image URL.
 *
 * Detection runs on a downscaled copy (for responsiveness); the returned
 * keypoint coordinates are mapped back to original-image pixels. Coordinates
 * are normalized (0..1) too, so overlays can scale to any display size.
 *
 * @returns {Promise<{ keypoints: Array, width: number, height: number, detectWidth: number, detectHeight: number, ms: number }>}
 */
export async function detectKeypoints(url, options = {}) {
  const { maxDim = 1200, contrastThreshold = 0.01, maxKeypoints = 5000 } = options

  await ensureWasm()
  const img = await loadImage(url)
  const { data, width, height, scale } = rasterize(img, maxDim)

  const t0 = performance.now()
  const flat = detect_sift(new Uint8Array(data.buffer), width, height, contrastThreshold, maxKeypoints)
  const ms = performance.now() - t0

  // detect_sift appends two trailing scalars after the STRIDE-packed keypoints:
  // raw_found (post-dedup, pre-cap) then suppressed (near-duplicate positions
  // dropped), so kept = floor((len - 2) / STRIDE). See crates/sift/src/lib.rs.
  const n = flat.length >= 2 ? Math.floor((flat.length - 2) / STRIDE) : 0
  const keypoints = []
  const descriptors = new Float32Array(n * DESC_LEN)

  for (let i = 0; i < n; i++) {
    const base = i * STRIDE
    const dx = flat[base]
    const dy = flat[base + 1]
    keypoints.push({
      x: dx / scale,
      y: dy / scale,
      nx: dx / width,
      ny: dy / height,
      scale: flat[base + 2] / scale,
      response: flat[base + 3],
    })
    descriptors.set(flat.subarray(base + 5, base + 5 + DESC_LEN), i * DESC_LEN)
  }

  return {
    keypoints,
    descriptors, // Float32Array, N×128 row-major — not stored in image object, persisted to OPFS
    width: img.naturalWidth,
    height: img.naturalHeight,
    detectWidth: width,
    detectHeight: height,
    ms,
  }
}

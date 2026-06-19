import init, { detect_sift } from '../wasm/sift/sift.js'

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
  const { maxDim = 1200, contrastThreshold = 0.03, maxKeypoints = 5000 } = options

  await ensureWasm()
  const img = await loadImage(url)
  const { data, width, height, scale } = rasterize(img, maxDim)

  const t0 = performance.now()
  const flat = detect_sift(data, width, height, contrastThreshold, maxKeypoints)
  const ms = performance.now() - t0

  const keypoints = []
  for (let i = 0; i < flat.length; i += 4) {
    const dx = flat[i] // x in detection space
    const dy = flat[i + 1]
    keypoints.push({
      x: dx / scale, // original-image pixels
      y: flat[i + 1] / scale,
      nx: dx / width, // normalized 0..1
      ny: dy / height,
      scale: flat[i + 2] / scale,
      response: flat[i + 3],
    })
  }

  return {
    keypoints,
    width: img.naturalWidth,
    height: img.naturalHeight,
    detectWidth: width,
    detectHeight: height,
    ms,
  }
}

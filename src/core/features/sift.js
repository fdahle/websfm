import init, { detect_sift } from '../../wasm/detection/sift.js'

// SIFT detector wasm wrapper — the classic counterpart of superpoint.js. Pure:
// takes an RGBA raster (pixel decoding is the caller's job — OffscreenCanvas in
// the worker) and returns the flat detection buffer straight from the crate. The
// caller parses the STRIDE layout ([x,y,scale,response,angle,d0..d127] per kept
// keypoint, then the two trailing sentinels rawFound/suppressed — see
// crates/sift/src/lib.rs and the parse in workers/compute.worker.js runSift).

let initPromise = null

// Lazily initialize the SIFT WASM module exactly once.
function ensureWasm() {
  if (!initPromise) initPromise = init()
  return initPromise
}

/**
 * Run SIFT detection on an RGBA raster.
 *
 * @param {Uint8ClampedArray|Uint8Array} data - RGBA pixels, width*height*4
 * @param {number} width
 * @param {number} height
 * @param {object} options
 * @param {number} [options.contrastThreshold]
 * @param {number} [options.maxKeypoints]
 * @returns {Promise<{ flat: Float32Array, ms: number }>}
 */
export async function detectSift(data, width, height, options = {}) {
  const { contrastThreshold = 0.01, maxKeypoints = 5000 } = options
  await ensureWasm()
  const t0 = performance.now()
  const flat = detect_sift(new Uint8Array(data.buffer), width, height, contrastThreshold, maxKeypoints)
  return { flat, ms: performance.now() - t0 }
}

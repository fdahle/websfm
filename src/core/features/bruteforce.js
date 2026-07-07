import init, { match_descriptors } from '../../wasm/matching/matching.js'

let initPromise = null

function ensureWasm() {
  if (!initPromise) initPromise = init()
  return initPromise
}

/**
 * Brute-force descriptor matching with Lowe's ratio test.
 *
 * @param {Float32Array} descA - N_a × dim descriptors (flat, row-major)
 * @param {Float32Array} descB - N_b × dim descriptors (flat, row-major)
 * @param {object} options
 * @param {number} [options.dim=128] - descriptor width (128 SIFT, 256 SuperPoint).
 *   Wrong dim mis-slices the buffer into 2× phantom rows whose indices overflow the
 *   keypoint arrays downstream (the `reading 'x'` crash in verify).
 * @returns {Promise<{ matches: Array<{ia,ib,dist}>, count: number }>}
 */
export async function matchDescriptors(descA, descB, options = {}) {
  const { ratioThreshold = 0.75, crossCheck = false, dim = 128 } = options
  await ensureWasm()
  const raw = match_descriptors(descA, descB, dim, ratioThreshold, crossCheck)
  const count = raw.length / 3
  const matches = []
  for (let i = 0; i < count; i++) {
    matches.push({ ia: raw[i * 3], ib: raw[i * 3 + 1], dist: raw[i * 3 + 2] })
  }
  return { matches, count }
}

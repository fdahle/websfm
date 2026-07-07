import init, { match_descriptors } from '../../wasm/matching/matching.js'

let initPromise = null

function ensureWasm() {
  if (!initPromise) initPromise = init()
  return initPromise
}

/**
 * Brute-force descriptor matching with Lowe's ratio test.
 *
 * @param {Float32Array} descA - N_a × 128 descriptors (flat, row-major)
 * @param {Float32Array} descB - N_b × 128 descriptors (flat, row-major)
 * @param {object} options
 * @returns {Promise<{ matches: Array<{ia,ib,dist}>, count: number }>}
 */
export async function matchDescriptors(descA, descB, options = {}) {
  const { ratioThreshold = 0.75, crossCheck = false } = options
  await ensureWasm()
  const raw = match_descriptors(descA, descB, ratioThreshold, crossCheck)
  const count = raw.length / 3
  const matches = []
  for (let i = 0; i < count; i++) {
    matches.push({ ia: raw[i * 3], ib: raw[i * 3 + 1], dist: raw[i * 3 + 2] })
  }
  return { matches, count }
}

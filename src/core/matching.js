import init, { match_descriptors, verify_matches } from '../wasm/matching/matching.js'

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

/**
 * RANSAC fundamental matrix estimation on a set of putative matches.
 *
 * @param {Array<{x,y}>} kpsA - keypoints from image A (original pixel coords)
 * @param {Array<{x,y}>} kpsB - keypoints from image B (original pixel coords)
 * @param {Array<{ia,ib}>} matches - putative match pairs (indices into kpsA/kpsB)
 * @param {object} options
 * @returns {Promise<{ F: number[][], inlierMask: Float32Array, inlierCount: number } | null>}
 */
export async function verifyMatches(kpsA, kpsB, matches, options = {}) {
  const { ransacThreshPx = 2.0, maxIters = 1000 } = options
  await ensureWasm()

  const n = matches.length
  if (n < 8) return null

  const ptsA = new Float32Array(n * 2)
  const ptsB = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const { ia, ib } = matches[i]
    ptsA[i * 2]     = kpsA[ia].x
    ptsA[i * 2 + 1] = kpsA[ia].y
    ptsB[i * 2]     = kpsB[ib].x
    ptsB[i * 2 + 1] = kpsB[ib].y
  }

  const raw = verify_matches(ptsA, ptsB, ransacThreshPx, maxIters)
  if (raw.length === 0) return null

  const F = [
    [raw[0], raw[1], raw[2]],
    [raw[3], raw[4], raw[5]],
    [raw[6], raw[7], raw[8]],
  ]
  const inlierMask = raw.slice(9)
  const inlierCount = inlierMask.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0)

  return { F, inlierMask, inlierCount }
}

import init, { match_descriptors, verify_matches_hf } from '../wasm/matching/matching.js'

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
 * @returns {Promise<{ F: number[][], inlierMask: Float32Array, inlierCount: number, hInlierCount: number } | null>}
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

  // Layout: [F00..F22, hInlierCount, inlier_0, inlier_1, …] (see verify_matches_hf).
  const raw = verify_matches_hf(ptsA, ptsB, ransacThreshPx, maxIters)
  if (raw.length === 0) return null

  const F = [
    [raw[0], raw[1], raw[2]],
    [raw[3], raw[4], raw[5]],
    [raw[6], raw[7], raw[8]],
  ]
  const hInlierCount = raw[9]
  const inlierMask = raw.slice(10)
  const inlierCount = inlierMask.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0)

  return { F, inlierMask, inlierCount, hInlierCount }
}

/**
 * Positional spread of the accepted (inlier) correspondences — a geometry check no
 * count/ratio/H-vs-F gate can see. Two failure modes leave a positional fingerprint:
 *
 *   - many-to-one convergence: several distinct points in image A all match keypoints
 *     stacked at ~one location in image B (e.g. duplicate scale/octave SIFT keypoints
 *     on one strong blob — each index-distinct, so cross-check and the ratio test both
 *     pass, and a homography can't fit them so the H/F flag reads healthy). The image-B
 *     positions collapse to a handful of unique spots.
 *   - epipole degeneracy: RANSAC satisfies every epipolar constraint by piling the
 *     inliers into one tiny image region.
 *
 * Returns, over the inlier set: `count`, the number of unique rounded positions in
 * each image (`uniqueA`/`uniqueB`), and the bounding-box diagonal in px (`extentA`/
 * `extentB`). The caller rejects either signature. `matches[i]` must align with
 * `inlierMask[i]` (i.e. the same putative list handed to `verifyMatches`).
 */
export function inlierSpread(kpsA, kpsB, matches, inlierMask, roundPx = 1) {
  const seenA = new Set(), seenB = new Set()
  let minAx = Infinity, minAy = Infinity, maxAx = -Infinity, maxAy = -Infinity
  let minBx = Infinity, minBy = Infinity, maxBx = -Infinity, maxBy = -Infinity
  let count = 0
  for (let i = 0; i < matches.length; i++) {
    if (!(inlierMask[i] > 0.5)) continue
    const a = kpsA[matches[i].ia], b = kpsB[matches[i].ib]
    count++
    seenA.add(`${Math.round(a.x / roundPx)},${Math.round(a.y / roundPx)}`)
    seenB.add(`${Math.round(b.x / roundPx)},${Math.round(b.y / roundPx)}`)
    if (a.x < minAx) minAx = a.x
    if (a.x > maxAx) maxAx = a.x
    if (a.y < minAy) minAy = a.y
    if (a.y > maxAy) maxAy = a.y
    if (b.x < minBx) minBx = b.x
    if (b.x > maxBx) maxBx = b.x
    if (b.y < minBy) minBy = b.y
    if (b.y > maxBy) maxBy = b.y
  }
  return {
    count,
    uniqueA: seenA.size,
    uniqueB: seenB.size,
    extentA: count ? Math.hypot(maxAx - minAx, maxAy - minAy) : 0,
    extentB: count ? Math.hypot(maxBx - minBx, maxBy - minBy) : 0,
  }
}

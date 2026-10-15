// The frame geometric verification runs in (pure).
//
// F-RANSAC assumes straight epipolar lines, which only a pinhole camera has. A mild
// Brown lens bends them by a few pixels and verification has always run on the raw
// keypoints (SfM ingest re-fits F afterwards — ingest.js refitMovedPairs). A fisheye
// bends them by hundreds: on raw keypoints the epipolar fit throws away most good
// matches outside the image centre. So a fisheye image's putatives are undistorted
// into its pinhole frame before RANSAC, with the same K and lens SfM ingest will
// use; a putative too far off-axis for that frame (distortion.js
// FISHEYE_MAX_RAY_DEG) is left out of the fit and counts as an outlier.

import { undistortKeypoint } from '../sfm/distortion.js'

// Pixel map for one image, or null when its putatives are verified as recorded
// (no lens, or a Brown/rational lens). `K` = { fx, fy, cx, cy }, `dist` a lens bag.
export function makeVerifyMapper(K, dist) {
  if (!K || !dist?.fisheye) return null
  return (x, y) => undistortKeypoint(x, y, K, dist)
}

// Map packed putatives (`[x0, y0, x1, y1, …]`, core/features/verify.js
// packMatchedPoints) through the two images' mappers. Returns the arrays to
// verify plus `keep`: the original row of each kept putative, or null when every
// row survived (no mapper drops anything) — then rows line up one to one.
export function mapVerifyPoints(ptsA, ptsB, mapA, mapB) {
  if (!mapA && !mapB) return { ptsA, ptsB, keep: null }
  const n = ptsA.length / 2
  const outA = new Float32Array(n * 2), outB = new Float32Array(n * 2)
  const keep = new Int32Array(n)
  let m = 0
  for (let i = 0; i < n; i++) {
    const a = mapA ? mapA(ptsA[2 * i], ptsA[2 * i + 1]) : { x: ptsA[2 * i], y: ptsA[2 * i + 1] }
    const b = mapB ? mapB(ptsB[2 * i], ptsB[2 * i + 1]) : { x: ptsB[2 * i], y: ptsB[2 * i + 1] }
    if (!(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y))) continue
    outA[2 * m] = a.x; outA[2 * m + 1] = a.y
    outB[2 * m] = b.x; outB[2 * m + 1] = b.y
    keep[m++] = i
  }
  if (m === n) return { ptsA: outA, ptsB: outB, keep: null }
  return { ptsA: outA.slice(0, 2 * m), ptsB: outB.slice(0, 2 * m), keep: keep.slice(0, m) }
}

// Spread an inlier mask over the kept rows back to all `n` putatives (a dropped
// row is an outlier). Returns the mask unchanged when nothing was dropped.
export function expandInlierMask(mask, keep, n) {
  if (!keep || !mask) return mask
  const out = new Float32Array(n)
  for (let j = 0; j < keep.length; j++) out[keep[j]] = mask[j]
  return out
}

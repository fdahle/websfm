// A faint image: SIFT at the set contrast threshold finds fewer than
// DETECT_TUNING.siftFaintRetryShare of the keypoint cap (a white wall, an office, a
// low-sun field). Such an image is detected again at siftFaintRetryContrast × that
// threshold and keeps the second set (workers/ops/detect.js): its matches decide whether
// it registers at all, and the cap still bounds the matching cost. Images that reach
// the floor are detected once, exactly as before.
//
// Measured 2026-10-25 (bench, camera centres vs the reference cameras, 0.01 → 0.005 on
// the faint images): ETH3D six scenes, every scene as many cameras or more (office
// 18 → 20/26, playground 34 → 35/38) and smaller median errors on five (delivery_area
// 4.0 → 2.9 mm, playground 3.6 → 1.3 mm); South Building 6/128 images retried, 4.67 →
// 4.65 mm; quarry 53/347 retried, RTK rms3d without priors 0.766 → 0.738 m, sparse
// points +14 %, exhaustive matching 781 → 1,020 s.

import { DETECT_TUNING } from '../tuning.js'

/**
 * The contrast threshold to detect a faint image again at, or null to keep the first
 * detection.
 * @param {number} count keypoints the first detection kept (after the mask and cap)
 * @param {{ contrastThreshold: number, maxKeypoints: number, enabled?: boolean }} o
 * @returns {{ contrast: number, floor: number } | null}
 */
export function faintRetry(count, { contrastThreshold, maxKeypoints, enabled = DETECT_TUNING.siftFaintRetry }) {
  if (!enabled || !(maxKeypoints > 0) || !(contrastThreshold > 0)) return null
  const floor = Math.round(DETECT_TUNING.siftFaintRetryShare * maxKeypoints)
  if (count >= floor) return null
  return { contrast: contrastThreshold * DETECT_TUNING.siftFaintRetryContrast, floor }
}

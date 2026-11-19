// What Optimize Cameras does (OptimizeCamerasModal.vue): a bundle adjustment of the
// finished model with the chosen intrinsics free (core/sfm/gradualSelection.js
// `optimizeCameras`).
import { plural } from './format.js'

// project: { cameras, points, gcps }
export function optimizeCamerasEffects(s, { cameras = 0, points = 0, gcps = 0 } = {}) {
  const full = s.refine === 'full'
  const what = full
    ? 'focal length, principal point and lens (k1–k3, p1, p2; a fisheye’s k1–k4)'
    : s.refine === 'f,cxcy'
      ? 'focal length and principal point'
      : 'focal length'
  const refine =
    `Bundle adjustment of ${plural(cameras, 'camera')} and ${plural(points, 'point')}, the ${what} free and shared ` +
    `per sensor${gcps ? `, held to ${plural(gcps, 'control point')} where they qualify` : ''}; ` +
    (full ? 'the solved lens replaces the calibrated one.' : 'distortion stays as calibrated.')
  return { refine }
}

// What each step of Align to Reference does (AlignIcpModal.vue): pair points with
// their nearest reference point, then solve the motion, iterating
// (core/products/cloudAlign.js `icpAlign`).
import { fmtCount, fmtLength } from './format.js'

import { STREAMED_ICP_SAMPLE_POINTS } from '../lod/streamed.js'

// project: { sourceName, radius (the auto radius when 0), unit, planar (the
//   reference has normals or is a mesh), streamedPoints (the source's count when it is
//   streamed: aligned on a sample, store ▸ cloudEdits.js) }
export function alignIcpEffects(
  s,
  { sourceName = 'the cloud', autoRadius = 0, unit = 'units', planar = false, streamedPoints = 0 } = {},
) {
  const r = s.maxDistance > 0 ? s.maxDistance : autoRadius
  const pair =
    `${fmtCount(s.sampleCount)} points of "${sourceName}" are paired with the nearest reference point within ` +
    `${r > 0 ? fmtLength(r, unit) : 'ten point spacings'}${s.maxDistance > 0 ? '' : ' (auto)'}; farther pairs are ignored.` +
    (streamedPoints > 0
      ? ` The cloud is streamed: they come from a sample of up to ${fmtCount(STREAMED_ICP_SAMPLE_POINTS)} of its ` +
        `points, and all ${fmtCount(streamedPoints)} move into a new streamed cloud.`
      : '')
  const how = !s.pointToPlane
    ? 'point-to-point'
    : planar
      ? 'point-to-plane'
      : "point-to-plane (the reference's normals estimated where it is matched)"
  const solve =
    `Rotation, translation${s.estimateScale ? ' and scale' : ''} are solved ${how}, up to ${s.maxIterations} ` +
    `iterations; a converged run stops early.`
  return { pair, solve }
}

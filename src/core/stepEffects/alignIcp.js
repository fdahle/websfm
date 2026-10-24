// What each step of Align to Reference does (AlignIcpModal.vue): pair points with
// their nearest reference point, then solve the motion, iterating
// (core/products/cloudAlign.js `icpAlign`).
import { fmtCount, fmtLength } from './format.js'

// project: { sourceName, radius (the auto radius when 0), unit, planar (the
//   reference has normals or is a mesh) }
export function alignIcpEffects(s, { sourceName = 'the cloud', autoRadius = 0, unit = 'units', planar = false } = {}) {
  const r = s.maxDistance > 0 ? s.maxDistance : autoRadius
  const pair =
    `${fmtCount(s.sampleCount)} points of "${sourceName}" are paired with the nearest reference point within ` +
    `${r > 0 ? fmtLength(r, unit) : 'ten point spacings'}${s.maxDistance > 0 ? '' : ' (auto)'}; farther pairs are ignored.`
  const how = s.pointToPlane && planar ? 'point-to-plane' : 'point-to-point'
  const solve =
    `Rotation, translation${s.estimateScale ? ' and scale' : ''} are solved ${how}, up to ${s.maxIterations} ` +
    `iterations; a converged run stops early.`
  return { pair, solve }
}

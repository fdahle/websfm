// What each step of Distance to Reference does (CloudDistanceModal.vue): find each
// point's nearest reference, then sign the distance (core/products/cloudDistance.js).
import { fmtLength, plural } from './format.js'

// project: { count (points measured), mesh (the reference is a mesh), signable, unit }
export function cloudDistanceEffects(s, { count = 0, mesh = false, signable = false, unit = 'units' } = {}) {
  const nearest =
    `Each of the ${plural(count, 'point')} gets its distance to the nearest ${mesh ? 'triangle of the mesh' : 'reference point'}` +
    `${s.maxDistance > 0 ? `; farther than ${fmtLength(s.maxDistance, unit)} it gets none (grey)` : ''}.`
  const sign = !signable
    ? 'Unsigned: the reference cloud has no normals. Estimate normals on it, or use a mesh, to sign it.'
    : s.signed
      ? 'Positive above the reference surface, negative below.'
      : 'Off: distances are unsigned.'
  return { nearest, sign }
}

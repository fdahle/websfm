// What each step of Estimate Normals does (NormalsModal.vue): fit a plane to each
// point's neighbours, then turn every normal to one side (core/products/cloudNormals.js).
import { plural } from './format.js'

const ORIENT = {
  cameras: 'Each normal is turned to face the nearest camera: right for walls and overhangs.',
  up: 'Each normal is turned to face upward (+Z): right for terrain seen from above.',
  existing: 'Each normal keeps the side the cloud’s existing normals face; only the direction is re-estimated.',
}

// project: { count (points of the source), orient (the resolved 'auto') }
export function normalsEffects(s, { count = 0, orient = 'up' } = {}) {
  const fit = `Each of the ${plural(count, 'point')} gets the normal of a plane fitted to its ${s.k} nearest neighbours.`
  return { fit, orient: `${s.orient === 'auto' ? 'Automatic: ' : ''}${ORIENT[orient] ?? ORIENT.up}` }
}

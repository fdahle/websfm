// What Sample Mesh to Points does (SampleMeshModal.vue): area-uniform random samples
// of the surface (core/products/meshEdit.js `sampleMesh`).
import { fmtCount, plural } from './format.js'

// project: { triangles } of the source mesh.
export function sampleMeshEffects(s, { triangles = 0 } = {}) {
  const sample =
    `${fmtCount(Math.round(s.count || 0))} points, spread by area over the ${plural(triangles, 'triangle')}, each ` +
    'with the face normal and the surface colour; the same count always gives the same points.'
  return { sample }
}

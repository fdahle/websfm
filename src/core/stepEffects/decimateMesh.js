// What Decimate Mesh does (DecimateMeshModal.vue): quadric edge collapse
// (core/products/meshDecimate.js), flat areas first.
import { fmtCount } from './format.js'

// project: { triangles (of the source), target (the triangle count the run aims at) }
export function decimateMeshEffects(s, { triangles = 0, target = 0 } = {}) {
  const collapse =
    target < 4 || target >= triangles
      ? `The target must be below the mesh’s ${fmtCount(triangles)} triangles.`
      : `${fmtCount(triangles)} → about ${fmtCount(target)} triangles (${Math.round((100 * target) / triangles)} %), ` +
        `collapsing edges where the surface is flattest first${s.preserveBoundary ? '; the boundary is kept' : ''}.`
  return { collapse }
}

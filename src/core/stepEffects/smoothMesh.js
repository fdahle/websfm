// What Smooth Mesh does (SmoothMeshModal.vue): Taubin λ/μ passes
// (core/products/meshEdit.js `taubinSmooth`).
import { plural } from './format.js'

// project: { triangles } of the source mesh.
export function smoothMeshEffects(s, { triangles = 0 } = {}) {
  const valid = s.lambda > 0 && s.mu < -s.lambda
  const smooth = !valid
    ? 'μ must be more negative than −λ, or each pass shrinks the mesh.'
    : `${plural(s.iterations, 'pass', 'passes')} over the ${plural(triangles, 'triangle')}, each smoothing (λ ${s.lambda}) ` +
      `then re-inflating (μ ${s.mu}) so the surface does not shrink` +
      `${s.fixBoundary ? '; the boundary stays where it is' : ''}.`
  return { smooth }
}

// The step's short fact (a one-step dialog draws no chain; kept for the layout).
export function smoothMeshShorts(s) {
  return { smooth: `${plural(s.iterations, 'pass', 'passes')} · λ ${s.lambda} · μ ${s.mu}` }
}

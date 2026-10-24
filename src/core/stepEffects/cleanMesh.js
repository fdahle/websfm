// What each step of Clean Mesh does (CleanMeshModal.vue): the chain of
// core/products/meshEdit.js `cleanMesh`, in its fixed order, each step on the
// previous one's result.

export function cleanMeshEffects(s, { textured = false } = {}) {
  const on = (id) => s.methods.includes(id)
  const weld = on('weld')
    ? 'Corners at the same place are joined into one vertex, so the triangles connect; a mesh that already shares them is unchanged.'
    : 'Off: vertices stay as they are. An STL-style import, every triangle on its own, then has no pieces, edges or holes to find.'
  const pieces = on('components')
    ? `Pieces with fewer than ${s.minFraction} × the largest piece’s triangles, or fewer than ${s.minTriangles}, are removed.`
    : 'Off: every disconnected piece is kept.'
  const bridges = on('longEdges')
    ? `Triangles with an edge longer than ${s.maxEdgeFactor} × the median edge, stretched across gaps, are removed.`
    : 'Off: long bridging triangles stay.'
  const holes = !on('holes')
    ? 'Off: holes stay open.'
    : `${s.maxHoleEdges > 0 ? `Holes ringed by up to ${s.maxHoleEdges} edges are closed` : 'Every opening is closed, the outer rim included: the result is watertight'}` +
      `${textured ? '; the result has no texture, since no photo covers the patches' : ''}.`
  const compact = on('compact')
    ? 'Vertices no triangle uses and triangles with no area are dropped.'
    : 'Off: unused vertices and flat triangles stay.'
  return { weld, pieces, bridges, holes, compact }
}

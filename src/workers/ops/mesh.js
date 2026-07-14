import init, { poisson_mesh } from '../../wasm/mesh/mesh.js'
import { generateMesh } from '../../core/products/mesh.js'

// Mesh op (screened Poisson). Owns the mesh wasm module (lazy init, like
// reconstruction.js gates its own wasm). Pure meshing lives in core/products/mesh.js;
// the worker just marshals buffers and injects the wasm solver. No rasterise dep.
export function makeMeshOps() {
  let initPromise = null
  const ensureWasm = () => (initPromise ??= init())

  // Build a triangle mesh from the dense cloud. Input carries the dense buffers
  // (transferred in by the store); we round-trip them home (same convention as
  // densify) so the store keeps its dense cloud usable afterwards.
  async function meshify([input], { emit }) {
    await ensureWasm()
    const { dense, settings = {} } = input
    if (!dense?.pos || !(dense.count > 0)) {
      emit('log', ['Mesh: no dense cloud to mesh', 'warn', 'Products'])
      throw new Error('meshify: empty dense cloud')
    }
    emit('progress', [0, 1, 'Poisson solve…'])
    const t0 = performance.now()
    const mesh = generateMesh(dense, poisson_mesh, settings, (m, l, c) => emit('log', [m, l, c]))
    emit('log', [`Mesh: built ${mesh.nVerts} vertices / ${mesh.count} triangles `
      + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'success', 'Products'])
    emit('progress', [1, 1, 'Done'])

    // Transfer the mesh buffers out AND the dense buffers back home.
    const transfer = []
    if (mesh.pos?.buffer) transfer.push(mesh.pos.buffer)
    if (mesh.idx?.buffer) transfer.push(mesh.idx.buffer)
    if (mesh.col?.buffer) transfer.push(mesh.col.buffer)
    const denseHome = { pos: dense.pos, col: dense.col || null, nrm: dense.nrm || null }
    if (dense.pos?.buffer) transfer.push(dense.pos.buffer)
    if (dense.col?.buffer) transfer.push(dense.col.buffer)
    if (dense.nrm?.buffer) transfer.push(dense.nrm.buffer)

    return { result: { mesh, denseHome }, transfer }
  }

  return { meshify }
}

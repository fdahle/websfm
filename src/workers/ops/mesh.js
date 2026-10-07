import init, { PoissonMesher } from '../../wasm/mesh/mesh.js'
import { generateMesh } from '../../core/products/mesh.js'

// Relative cost of the staged phases, for an honest progress fraction. A multigrid
// layer costs ~3× the one before it (nodes grow with the surface area at each level);
// the octree build and the extraction + cleanup scale like a share of the finest
// layer. Measured on the depth-8 bench terrain (crates/mesh/tests/bench_phases.rs,
// 2026-10-07): coarse layers ~0.6 s, finest 6.8 s, build 1.2 s, extraction 2.4 s.
const LAYER_GROWTH = 3
const BUILD_SHARE = 0.15    // × the finest layer's cost
const EXTRACT_SHARE = 0.4   // × the finest layer's cost

// Drive the staged Poisson solve, emitting progress between multigrid layers. Injected
// into core `generateMesh` as its `poissonFn`. Runs synchronously — the worker thread
// blocks here, but each `emit` posts a message that the MAIN thread paints as it
// arrives, so the bar advances per layer instead of freezing on one opaque call. Cancel
// is still a hard `terminateAll` (the worker can't service messages mid-solve); staging
// just bounds each blocking chunk to one layer. `mesher.free()` releases the wasm-side
// octree in a finally. Returns { bytes, stats } (stats: crates/mesh `MeshStats`).
function stagedPoisson(emit) {
  return ({ pos, nrm, wgt, depth, screening, trimDist, densityRatio, holeAreaRatio, minComponentShare }) => {
    emit('progress', [0, 1, `Building octree (depth ${depth})…`, 0])
    const mesher = PoissonMesher.build(pos, nrm, wgt ?? new Float32Array(0), depth >>> 0, screening)
    try {
      const n = mesher.num_layers()
      const finest = Math.pow(LAYER_GROWTH, Math.max(0, n - 1))
      const layerCost = (i) => Math.pow(LAYER_GROWTH, i)
      const total = BUILD_SHARE * finest + (finest * LAYER_GROWTH - 1) / (LAYER_GROWTH - 1) + EXTRACT_SHARE * finest
      let done = BUILD_SHARE * finest
      // Emit each label BEFORE the work it names, not after. A label posted after
      // `solve_step` returns describes work already finished, so the *previous* label
      // stays on screen for the whole solve — which is why a slow run looked like it
      // was stuck in "Building octree" when the octree build is a fraction of a second.
      for (let i = 0; i < n; i++) {
        emit('progress', [i, n + 1, `Solving multigrid layer ${i + 1}/${n}…`, done / total])
        mesher.solve_step()
        done += layerCost(i)
      }
      emit('progress', [n, n + 1, 'Extracting and cleaning up the surface…', done / total])
      const bytes = mesher.finish(trimDist, densityRatio, holeAreaRatio, minComponentShare)
      const stats = mesher.stats()
      emit('progress', [n + 1, n + 1, 'Surface extracted', 1])
      return { bytes, stats }
    } finally {
      mesher.free()
    }
  }
}


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
    const mesh = generateMesh(dense, stagedPoisson(emit), settings, (m, l, c) => emit('log', [m, l, c]))
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

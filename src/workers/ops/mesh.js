import init, * as mesh32 from '../../wasm/mesh/mesh.js'
import { generateMesh, poissonHeapBytes } from '../../core/products/mesh.js'
import { bigArrayCaps } from '../../core/bigArray.js'

// Relative cost of the staged phases, for an honest progress fraction. A multigrid
// layer costs ~3× the one before it (nodes grow with the surface area at each level);
// the octree build and the extraction + cleanup scale like a share of the finest
// layer. Measured on the depth-8 bench terrain (crates/mesh/tests/bench_phases.rs,
// 2026-10-07): coarse layers ~0.6 s, finest 6.8 s, build 1.2 s, extraction 2.4 s.
const LAYER_GROWTH = 3
const BUILD_SHARE = 0.15 // × the finest layer's cost
const EXTRACT_SHARE = 0.4 // × the finest layer's cost

// Drive the staged Poisson solve, emitting progress between multigrid layers. Injected
// into core `generateMesh` as its `poissonFn`. Runs synchronously — the worker thread
// blocks here, but each `emit` posts a message that the MAIN thread paints as it
// arrives, so the bar advances per layer instead of freezing on one opaque call. Cancel
// is still a hard `terminateAll` (the worker can't service messages mid-solve); staging
// just bounds each blocking chunk to one layer. `mesher.free()` releases the wasm-side
// octree in a finally. Returns { bytes, stats } (stats: crates/mesh `MeshStats`).
// `wasm` is the module of the build that runs it (32- or 64-bit). A panic aborts the solve
// as a bare `RuntimeError: unreachable`; the error then carries the crate's own message
// (`last_panic`). After a trap the mesher is still marked borrowed and free() throws: that
// must not hide the error that matters.
// A tile of a tiled solve (`grid`, `tile`: core/products/meshTiles.js) is built on the
// scene's grid, trims against the scene's `medianSupport` (0: its own samples'), and its
// progress is its share of the whole bar.
function stagedPoisson(emit, wasm) {
  return ({
    pos,
    nrm,
    wgt,
    depth,
    screening,
    trimDist,
    densityRatio,
    holeAreaRatio,
    minComponentShare,
    medianSupport = 0,
    grid,
    tile,
  }) => {
    const of = tile ? (f) => (tile.index + f) / tile.count : (f) => f
    const tag = tile ? `Tile ${tile.index + 1}/${tile.count}: ` : ''
    const progress = (d, t, label, f) => emit('progress', [d, t, tag + label, of(f)])
    progress(0, 1, `Building octree (depth ${depth})…`, 0)
    let mesher = null
    try {
      const w = wgt ?? new Float32Array(0)
      mesher = grid
        ? wasm.PoissonMesher.build_on_grid(pos, nrm, w, depth >>> 0, screening, Float64Array.from(grid))
        : wasm.PoissonMesher.build(pos, nrm, w, depth >>> 0, screening)
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
        progress(i, n + 1, `Solving multigrid layer ${i + 1}/${n}…`, done / total)
        mesher.solve_step()
        done += layerCost(i)
      }
      progress(n, n + 1, 'Extracting and cleaning up the surface…', done / total)
      const bytes = mesher.finish(trimDist, densityRatio, holeAreaRatio, minComponentShare, medianSupport)
      const stats = mesher.stats()
      progress(n + 1, n + 1, 'Surface extracted', 1)
      return { bytes, stats }
    } catch (err) {
      const why = err instanceof WebAssembly.RuntimeError ? wasm.last_panic?.() : ''
      if (why) err.message = `${err.message} (${why})`
      throw err
    } finally {
      try {
        mesher?.free()
      } catch {
        /* a trapped mesher stays borrowed; the instance is dropped below */
      }
    }
  }
}

// The 32-bit solver's heap stops at 4 GiB, a little of it taken by the module itself.
const HEAP32_BYTES = 3.5 * 2 ** 30
// The 64-bit one at 16 GiB; a solve projected near it can still fail on the allocator's
// growth (quarry, 208 M points at depth 10: 14.5 GB natively, failed in wasm64), so a
// larger one is tiled.
const HEAP64_BYTES = 12 * 2 ** 30

// Mesh op (screened Poisson). Owns the mesh wasm modules (lazy init, like
// reconstruction.js gates its own wasm). Pure meshing lives in core/products/mesh.js;
// the worker just marshals buffers and injects the wasm solver. No rasterise dep.
// Two builds of the solver: the 32-bit one (crates/mesh), and the Memory64 one
// (src/wasm/mesh-64, heap up to 16 GiB) where the browser has Memory64. The 64-bit one is
// ~17 % slower (Poisson 100 k points 30.2 vs 25.6 s, Chrome 156), so it runs only a solve
// whose projected heap (core/products/mesh.js poissonHeapBytes) passes the 32-bit heap, or
// one the 32-bit build ran out of memory on. A trap leaves a wasm instance unusable, so
// after one this worker keeps to the 64-bit build (and the store starts every mesh run on
// fresh workers). Past the 64-bit heap too, the error says so with the numbers: the
// quarry's 208 M-point cloud at depth 10 needs 14.5 GB (natively), more than the 16 GiB
// heap holds once the allocator's growth is counted (tiled Poisson, plan D5, is the fix).
export function makeMeshOps() {
  let initPromise = null
  const ensureWasm = () => (initPromise ??= init())
  let init64 = null
  const ensureWasm64 = () =>
    (init64 ??= import('../../wasm/mesh-64/mesh.js').then(async (m) => {
      await m.default()
      return m
    }))
  let broken32 = false

  // The solver for one generateMesh call: picks the build when the solve's size is known.
  function poissonFor(emit, wasm64) {
    return (args) => {
      const need = poissonHeapBytes(args.pos.length / 3, args.depth)
      const big = !!wasm64 && (broken32 || need > HEAP32_BYTES)
      if (wasm64) {
        emit('log', [
          `Mesh: ${args.tile ? `tile ${args.tile.index + 1}/${args.tile.count} ` : ''}Poisson heap ≈ ` +
            `${(need / 2 ** 30).toFixed(1)} GB → ${big ? '64-bit (Memory64)' : '32-bit'} solver` +
            (broken32 ? ' (the 32-bit one ran out of memory earlier in this worker)' : ''),
          'info',
          'Products',
        ])
      }
      const run64 = () => {
        try {
          return stagedPoisson(emit, wasm64)(args)
        } catch (err) {
          if (!(err instanceof WebAssembly.RuntimeError) || wasm64.last_panic()) throw err
          throw new Error(
            `the Poisson solve needs more memory than the 16 GB a 64-bit WebAssembly module holds ` +
              `(≈ ${(need / 2 ** 30).toFixed(1)} GB projected, ${(args.pos.length / 3).toLocaleString()} samples at ` +
              `depth ${args.depth}). Lower the quality (depth), or set a Region around part of the scene.`,
          )
        }
      }
      if (big) return run64()
      try {
        return stagedPoisson(emit, mesh32)(args)
      } catch (err) {
        // Out of memory aborts without a panic message; a panic is a bug that the other
        // build would only repeat.
        if (!wasm64 || !(err instanceof WebAssembly.RuntimeError) || mesh32.last_panic()) throw err
        broken32 = true
        emit('log', [
          `Mesh: the 32-bit solver stopped (${err.message}, most likely out of its 4 GB heap) — solving again ` +
            'on the 64-bit one',
          'warn',
          'Products',
        ])
        return run64()
      }
    }
  }

  // Build a triangle mesh from the dense cloud. Input carries the dense buffers
  // (transferred in by the store); we round-trip them home (same convention as
  // densify) so the store keeps its dense cloud usable afterwards.
  async function meshify([input], { emit }) {
    await ensureWasm()
    const wasm64 = bigArrayCaps().memory64 ? await ensureWasm64().catch(() => null) : null
    const { dense, settings = {} } = input
    if (!dense?.pos || !(dense.count > 0)) {
      emit('log', ['Mesh: no dense cloud to mesh', 'warn', 'Products'])
      throw new Error('meshify: empty dense cloud')
    }
    emit('progress', [0, 1, 'Poisson solve…'])
    const t0 = performance.now()
    // What one solve holds here decides whether generateMesh tiles (meshTiles.js).
    const oneSolveBytes = wasm64 ? HEAP64_BYTES : HEAP32_BYTES
    const mesh = generateMesh(dense, poissonFor(emit, wasm64), { ...settings, oneSolveBytes }, (m, l, c) =>
      emit('log', [m, l, c]),
    )
    emit('log', [
      `Mesh: built ${mesh.nVerts} vertices / ${mesh.count} triangles ` +
        `in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      'success',
      'Products',
    ])
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

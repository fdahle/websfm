/* tslint:disable */
/* eslint-disable */

/**
 * Staged, JS-driven wrapper around the screened-Poisson solve. Exposes the phases the
 * worker steps through so it can paint per-layer progress (the whole solve is a single
 * blocking wasm call otherwise — the "stuck at Poisson solve" symptom) and keep the
 * largest uninterruptible unit of work down to one multigrid layer:
 *
 * ```text
 *   let m = PoissonMesher.build(pos, nrm, wgt, depth, screening) // octree + field
 *   for _ in 0..m.num_layers() { m.solve_step() }                 // solve, report progress
 *   let bytes = m.finish(trim, densityRatio, holeRatio, minShare)  // extract + clean + encode
 *   let stats = m.stats()                                          // MeshStats::to_vec
 *   m.free()
 * ```
 */
export class PoissonMesher {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Build the multigrid octree + vector field (no layer solved yet). `pos`/`nrm` are
     * flat `3·N` f32 (world-space; `nrm` unit); `wgt` is one support weight per sample
     * (raw points it stands for) or empty for all-1; `max_depth`/`screening` as in
     * [`poisson_mesh`]. An empty / degenerate input yields a mesher with zero layers
     * whose `finish` returns an empty mesh.
     */
    static build(pos: Float32Array, nrm: Float32Array, wgt: Float32Array, max_depth: number, screening: number): PoissonMesher;
    /**
     * Solve any remaining layers, then extract, clean up (see [`MeshOptions`]; each
     * argument ≤ 0 disables its stage) and encode the mesh to the little-endian wire
     * buffer described on [`poisson_mesh`]. Consumes the internal builder — call once.
     */
    finish(trim_dist: number, density_ratio: number, hole_area_ratio: number, min_component_share: number): Uint8Array;
    /**
     * Number of multigrid layers to solve (`== max_depth + 1`, or 0 for a degenerate
     * build). Drives the caller's progress denominator.
     */
    num_layers(): number;
    /**
     * Solve the next multigrid layer (coarsest first). Returns `true` while more layers
     * remain. A no-op (`false`) once every layer is solved or on a degenerate build.
     */
    solve_step(): boolean;
    /**
     * What the last `finish` did, in [`MeshStats::to_vec`] order.
     */
    stats(): Float64Array;
}

/**
 * Screened Poisson mesh from oriented points, distance trim only. `pos`/`nrm` are flat
 * `3·N` f32 (world-space; `nrm` unit). `max_depth` is the octree depth (detail vs cost),
 * `screening` the point-fitting weight (0 disables), `trim_dist` the world-unit radius
 * past which a triangle entirely far from the input cloud is culled (≤0 disables).
 * Returns ONE byte buffer, little-endian:
 *   header  [u32 nVerts, u32 nTris]
 *   f32     positions  (3·nVerts)
 *   u32     indices    (3·nTris)
 * An empty / degenerate result returns a header of zeros.
 */
export function poisson_mesh(pos: Float32Array, nrm: Float32Array, max_depth: number, screening: number, trim_dist: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_poissonmesher_free: (a: number, b: number) => void;
    readonly poisson_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly poissonmesher_build: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly poissonmesher_finish: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly poissonmesher_num_layers: (a: number) => number;
    readonly poissonmesher_solve_step: (a: number) => number;
    readonly poissonmesher_stats: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

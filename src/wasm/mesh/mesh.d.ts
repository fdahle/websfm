/* tslint:disable */
/* eslint-disable */

/**
 * Screened Poisson mesh from oriented points. `pos`/`nrm` are flat `3·N` f32
 * (world-space; `nrm` unit). `max_depth` is the octree depth (detail vs cost),
 * `screening` the point-fitting weight (0 disables), `trim_dist` the world-unit
 * radius past which a triangle entirely far from the input cloud is culled (≤0
 * disables trimming). Returns ONE byte buffer, little-endian:
 *   header  [u32 nVerts, u32 nTris]
 *   f32     positions  (3·nVerts)
 *   u32     indices    (3·nTris)
 * An empty / degenerate result returns a header of zeros.
 */
export function poisson_mesh(pos: Float32Array, nrm: Float32Array, max_depth: number, screening: number, trim_dist: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly poisson_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
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

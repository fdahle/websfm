/* tslint:disable */
/* eslint-disable */

/**
 * Match descriptors using Lowe's ratio test.
 *
 * `desc_a` / `desc_b`: flat `Float32Array`s — one row of `dim` floats per keypoint
 * (`dim` = 128 for SIFT, 256 for SuperPoint). Returns flat `[idx_a, idx_b, dist,
 * ...]` triples as a `Float32Array`. `cross_check = true` requires mutual
 * nearest-neighbour consistency.
 */
export function match_descriptors(desc_a: Float32Array, desc_b: Float32Array, dim: number, ratio_threshold: number, cross_check: boolean): Float32Array;

/**
 * RANSAC fundamental matrix estimation on a set of putative matches.
 *
 * `pts_a` / `pts_b`: flat `[x0, y0, x1, y1, ...]` pixel coordinates.
 * Returns `[F00..F22, inlier_0, inlier_1, ...]` — first 9 values are the fundamental
 * matrix (row-major, f32), the rest are 1.0/0.0 inlier flags.
 * Returns empty if < 8 correspondences or RANSAC finds no valid solution.
 */
export function verify_matches(pts_a: Float32Array, pts_b: Float32Array, ransac_thresh_px: number, max_iters: number): Float32Array;

/**
 * Like `verify_matches`, but also fits a homography via RANSAC and reports its
 * inlier count so the caller can compute the H-vs-F degeneracy ratio.
 *
 * Output layout: `[F00..F22, h_inlier_count, inlier_0, inlier_1, ...]` — the
 * fundamental matrix (9), then the homography inlier count (1), then the F
 * inlier flags (n). Empty if < 8 correspondences or RANSAC finds no F.
 */
export function verify_matches_hf(pts_a: Float32Array, pts_b: Float32Array, ransac_thresh_px: number, max_iters: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly match_descriptors: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly verify_matches: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly verify_matches_hf: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
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

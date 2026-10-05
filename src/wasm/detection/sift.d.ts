/* tslint:disable */
/* eslint-disable */

/**
 * Detect SIFT keypoints and compute 128-d descriptors.
 *
 * `max_orientations` (1..=4; 0 is treated as 1): every scale-space extremum yields
 * its dominant orientation plus up to `max_orientations - 1` further histogram peaks
 * within ORI_PEAK_RATIO of it, each as a separate keypoint with its own descriptor at
 * the SAME x, y, scale and response ("siblings"). 1 reproduces the single-orientation
 * detector exactly. Siblings count toward `max_keypoints` and the counts below, as in
 * COLMAP (`max_num_orientations`, default 2).
 *
 * Returns a flat `Float32Array` with `STRIDE` (133) values per keypoint:
 * `[x, y, scale, response, angle, d0..d127, ...]`
 * where `x`/`y` are in input-image pixel coordinates, followed by TWO trailing
 * values: `raw_found` = keypoints surviving near-duplicate suppression but *before*
 * the `max_keypoints` cap (so callers can report how many were dropped to the cap),
 * then `suppressed` = keypoints dropped as near-duplicate positions (multiple
 * scale/octave DoG extrema collapsing onto one visual location). A degenerate input
 * (zero-size / short buffer) returns an empty vec; a valid image with no extrema
 * returns `[0.0, 0.0]`. Parse as `kept = floor((len - 2) / STRIDE)`,
 * `raw = flat[len-2]`, `suppressed = flat[len-1]`.
 */
export function detect_sift(rgba: Uint8Array, width: number, height: number, contrast_threshold: number, max_keypoints: number, max_orientations: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly detect_sift: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
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

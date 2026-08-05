/* tslint:disable */
/* eslint-disable */

/**
 * Bundle adjustment by sparse Levenberg–Marquardt with the Schur complement.
 *
 * Jointly refines every camera pose (6-DOF: left-perturbed so(3) rotation +
 * translation) and every 3D point, and — when `refine_mode > 0` — a small set of
 * shared per-sensor intrinsic parameters (self-calibration). Points are always
 * eliminated by the Schur complement; the reduced system holds the camera poses
 * plus the intrinsic groups, solved by dense Cholesky. Huber robustification (an
 * adaptive threshold tracking the residual median) keeps surviving gross
 * mis-triangulations from dragging the solution.
 *
 * Intrinsic self-calibration is opt-in and modest: each sensor group carries a
 * focal **scale** `s` (init 1, multiplying every member camera's fx/fy) and,
 * for `refine_mode == 2`, shared principal-point offsets `dcx, dcy`. Modelling
 * the focal as a scale (not an absolute) preserves any per-camera differences in
 * the seed intrinsics while still sharing one degree of freedom across the group.
 *
 * At large camera counts the dense reduced-camera Cholesky (`chol_solve`) is the
 * only part that needs swapping for an iterative Schur solve.
 *
 * GCP support: `anchor_flat`/`anchor_weight` optionally pull specific 3D points
 * toward a known target position (e.g. a GCP triangulated in this same SfM
 * frame) with an extra quadratic residual `w·‖pt − target‖²`. This only ever
 * touches that point's own 3×3 block (gradient + diagonal Hessian) — no camera
 * Jacobian, no new coupling — so it folds into the existing per-point Schur
 * elimination for free. Empty anchor arrays reduce to today's behaviour exactly.
 * Camera-position support: `camera_prior_flat` optionally pulls camera centres
 * `C = -R^T t` toward known positions in this same SfM frame. Each row carries
 * independent inverse-variance weights for X/Y/Z. Its analytic pose Jacobian is
 * `[-R^T | -R^T[t]_x]` for this solver's `[dt,domega]` update convention.
 *
 * # Inputs
 * - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), …]`
 * - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]` (the seed / base K)
 * - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
 * - `obs_flat`: n_obs × 4 floats `[cam_i, pt_i, pixel_x, pixel_y, …]`
 * - `anchor_flat`: n_anchor × 4 floats `[pt_i, target_x, target_y, target_z, …]`
 * - `anchor_weight`: n_anchor floats, one `1/sigma²` weight per anchor (aligned
 *   with `anchor_flat`'s rows; missing entries default to weight 1)
 * - `camera_prior_flat`: n_prior × 7 floats
 *   `[cam_i, target_x, target_y, target_z, weight_x, weight_y, weight_z, …]`
 * - `max_iters`: outer LM iterations
 * - `sensor_of_cam`: n_cam ints — per-camera sensor id (shared → shared focal);
 *   `< 0` (or a short/empty list) ⇒ that camera is its own group
 * - `refine_mask`: **bitmask** of the shared per-sensor intrinsics to self-calibrate:
 *   1 = focal scale s, 2 = principal point (dcx,dcy), 4 = radial k1, 8 = k2, 16 = k3.
 *   0 ⇒ poses+points only. The per-group param vector is the ordered subset
 *   `[s?, dcx?, dcy?, k1?, k2?, k3?]` (kdim ≤ 6). fy stays locked to fx (single scale).
 *
 * # Output
 * `[cameras_flat(n_cam×12), pts_flat(n_pts×3), intrinsics_flat(n_cam×7),
 *   cost_before, cost_after, anchor_rms_after, camera_prior_rms_after,
 *   cost_trace…]` — the returned
 * intrinsics are the **refined** effective K per camera as `[fx,fy,cx,cy,k1,k2,k3]`
 * (radial coeffs 0 for the bits not set in `refine_mask`, identical to the input K
 * when `refine_mask == 0`); cost_before/cost_after are RMS reprojection error in
 * pixels (anchors do not affect them); anchor_rms_after is the RMS anchor
 * residual in the caller's world units, and camera_prior_rms_after is the RMS
 * camera-centre residual (both 0 when their respective prior list is empty).
 */
export function bundle_adjust(cameras_flat: Float32Array, intrinsics_flat: Float32Array, pts_flat: Float32Array, obs_flat: Float32Array, anchor_flat: Float32Array, anchor_weight: Float32Array, camera_prior_flat: Float32Array, max_iters: number, sensor_of_cam: Int32Array, refine_mask: number): Float32Array;

export function compute_depth_map(ref_gray: Uint8Array, ref_w: number, ref_h: number, ref_k: Float32Array, src_gray: Uint8Array, src_dims: Uint32Array, src_k: Float32Array, src_rel: Float32Array, src_mask: Uint8Array, seed_depth: Float32Array, depth_min: number, depth_max: number, window: number, iterations: number, best_k: number, seed: number): Float32Array;

/**
 * Recover camera pose from the essential matrix E using a cheirality check.
 *
 * # Inputs
 * - `pts_a`: flat N×2 pixel coords [x0,y0,x1,y1,…] for camera A
 * - `pts_b`: flat N×2 pixel coords for camera B
 * - `e_flat`: 9 floats, E matrix row-major
 * - `fx,fy,cx,cy`: intrinsics of camera A (used for back-projection in cheirality)
 *
 * # Output
 * `[R00…R22, tx, ty, tz]` = 12 floats (R for camera B relative to A, t unit vector),
 * or empty Vec on failure.
 */
export function recover_pose(pts_a: Float32Array, pts_b: Float32Array, e_flat: Float32Array, fx: number, fy: number, cx: number, cy: number): Float32Array;

/**
 * Estimate camera pose from 3D-2D correspondences via P3P (Lambda-Twist) inside
 * an MSAC loop, then a Gauss-Newton polish on the inliers.
 *
 * The minimal 3-point P3P sampler is dramatically more stable than the old
 * 6-point DLT on near-planar / aerial scenes (the geometry that previously
 * failed to register), MSAC scoring picks a cleaner consensus than plain inlier
 * counting, and the analytic-Jacobian refinement drives the pose to the true
 * minimum rather than the best minimal-sample estimate.
 *
 * # Inputs
 * - `pts_3d`: flat N×3 world points `[x,y,z,…]`
 * - `pts_2d`: flat N×2 pixel observations `[x,y,…]`
 * - `fx,fy,cx,cy`: camera intrinsics
 * - `ransac_thresh_px`: inlier reprojection threshold (pixels)
 * - `max_iters`: RANSAC iterations
 *
 * # Output
 * `[R00…R22, tx,ty,tz, inlier_0, inlier_1, …, inlier_N]` = 12 + N floats,
 * or empty Vec on failure.
 */
export function solve_pnp(pts_3d: Float32Array, pts_2d: Float32Array, fx: number, fy: number, cx: number, cy: number, ransac_thresh_px: number, max_iters: number): Float32Array;

/**
 * Triangulate N point pairs via linear DLT.
 *
 * # Inputs
 * - `pts_a`: flat N×2 pixel coords (normalised image coords, i.e. after K^{-1})
 * - `pts_b`: flat N×2 pixel coords (normalised)
 * - `p_a`: 12 floats, 3×4 projection matrix for camera A (row-major, in normalised coords)
 * - `p_b`: 12 floats, 3×4 for camera B
 *
 * # Output
 * Flat N×3 `[x,y,z, …]`. NaN triples for degenerate rows.
 */
export function triangulate_dlt(pts_a: Float32Array, pts_b: Float32Array, p_a: Float32Array, p_b: Float32Array): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bundle_adjust: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => [number, number];
    readonly compute_depth_map: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [number, number];
    readonly recover_pose: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly solve_pnp: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly triangulate_dlt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
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

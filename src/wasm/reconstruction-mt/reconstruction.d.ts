/* tslint:disable */
/* eslint-disable */

/**
 * The points every camera may observe, held for the searches of one extension run.
 */
export class GuidedSearch {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `pos`: x, y, z per point; `ref_start`/`refs`: each point's reference descriptors
     * (128 bytes each; n_points + 1 offsets, in descriptors); `view_start`/`view_img`:
     * the images that already observe each point; `cell_start`/`cell_pts`: the points
     * of each cull cell, ascending. `tau2`: the squared distance threshold; `ratio2`:
     * the squared ratio the best must beat the runner-up by.
     */
    constructor(pos: Float64Array, ref_start: Uint32Array, refs: Uint8Array, view_start: Uint32Array, view_img: Uint32Array, cell_start: Uint32Array, cell_pts: Uint32Array, gate_px: number, tau2: number, ratio2: number);
    /**
     * Search a group of cameras. Per camera c: `imgs[c]`, its image index; `p[16c..]`,
     * R (row-major), t, fx, fy, cx, cy; `kp_start`, its keypoints in `xy` (n_cams + 1
     * offsets, in keypoints); `desc_start`, its descriptors in `desc` (in bytes; a
     * keypoint past the camera's share has none); `used`, 1 per keypoint already in a
     * track; `cc_start`/`cc`, the cull cells it may see. Returns [windows, then
     * (point, camera, keypoint, squared distance) per proposal], cameras in order.
     */
    search(imgs: Uint32Array, p: Float64Array, kp_start: Uint32Array, xy: Float64Array, desc_start: Uint32Array, desc: Uint8Array, used: Uint8Array, cc_start: Uint32Array, cc: Uint32Array): Float64Array;
}

/**
 * Bundle adjustment by sparse Levenberg–Marquardt with the Schur complement.
 *
 * Jointly refines every camera pose (6-DOF: left-perturbed so(3) rotation +
 * translation) and every 3D point, and — when `refine_mode > 0` — a small set of
 * shared per-sensor intrinsic parameters (self-calibration). Points are always
 * eliminated by the Schur complement; the reduced system holds the camera poses
 * plus the intrinsic groups, stored block-sparse (a camera couples only with the
 * cameras it shares points with) and solved by block-Jacobi PCG when large, dense
 * Cholesky when small (`solve_reduced_with`, `DENSE_MAX_N`). Huber robustification (an
 * adaptive threshold tracking the residual median) keeps surviving gross
 * mis-triangulations from dragging the solution.
 *
 * Intrinsic self-calibration is opt-in and modest: each sensor group carries a
 * focal **scale** `s` (init 1, multiplying every member camera's fx/fy) and,
 * for `refine_mode == 2`, shared principal-point offsets `dcx, dcy`. Modelling
 * the focal as a scale (not an absolute) preserves any per-camera differences in
 * the seed intrinsics while still sharing one degree of freedom across the group.
 *
 * GCP support: `anchor_flat`/`anchor_weight` optionally pull specific 3D points
 * toward a known target position (e.g. a GCP triangulated in this same SfM
 * frame) with an extra quadratic residual `Σ_axis w_axis·(pt − target)²`. This only ever
 * touches that point's own 3×3 block (gradient + diagonal Hessian) — no camera
 * Jacobian, no new coupling — so it folds into the existing per-point Schur
 * elimination for free. Empty anchor arrays reduce to today's behaviour exactly.
 * Camera-pose support: `camera_prior_flat` optionally pulls camera centres
 * `C = -R^T t` and rotations toward known poses in this same SfM frame. Position
 * rows carry a full 3×3 precision matrix in solver axes: the survey's per-axis σ
 * (E, N, Up) rotated into the SfM frame, `s²·Rᵀ·diag(1/σ²)·R`, so a vertical σ stays
 * vertical whatever pair seeded the model. Orientation uses
 * the tangent residual `Log(R R_target^T)` and a full 3×3 precision matrix,
 * allowing the caller to transform per-OPK uncertainties into solver axes.
 *
 * # Inputs
 * - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), …]`
 * - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]` (the seed / base K)
 * - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
 * - `obs_index`: n_obs × 2 u32 `[cam_i, pt_i, …]` and `obs_px`: n_obs × 2 floats
 *   `[pixel_x, pixel_y, …]`. Indices are integers on purpose: as f32 they were exact
 *   only to 2²⁴, so above 16.7 M points observations silently attached to the wrong
 *   point (TODO ▸ SC-6).
 * - `anchor_flat`: n_anchor × 4 doubles `[pt_i, target_x, target_y, target_z, …]`
 * - `observation_weight`: n_obs × 2 inverse-variance pixel weights (X/Y);
 *   tie points use one detection pixel (1/f², baObservations.js tieWeightOf), GCP
 *   marks their declared pixel variances
 * - `anchor_weight`: n_anchor × 9 floats, row-major 3×3 precision matrices
 * - `camera_prior_flat`: n_prior × 31 floats
 *   `[cam_i, target_x, target_y, target_z, position_precision(9),
 *     target_R(9), orientation_precision(9), …]`, matrices row-major. An all-zero
 *   orientation precision matrix makes the row position-only.
 * - `max_iters`: outer LM iterations
 * - `sensor_of_cam`: n_cam ints — per-camera sensor id (shared → shared focal);
 *   `< 0` (or a short/empty list) ⇒ that camera is its own group
 * - `refine_mask`: **bitmask** of the shared per-sensor intrinsics to self-calibrate:
 *   1 = focal scale s, 2 = principal point (dcx,dcy), 4 = radial k1, 8 = k2, 16 = k3,
 *   32 = k4 (fisheye only). 0 ⇒ poses+points only. The per-group param vector is the
 *   ordered subset `[s?, dcx?, dcy?, k1?, k2?, k3?, k4?, τ?]` (kdim ≤ 8; τ: bundle_adjust_rs). fy stays locked
 *   to fx (single scale). A coefficient a group's lens does not have (k4 on a Brown
 *   group, k3 on a two-term fisheye) is held at its seed.
 * - `fixed_cam`: n_cam bytes, non-zero ⇒ that camera's pose is held fixed (local BA:
 *   the cameras outside the window keep their observations as constraints but are
 *   not variables). Empty ⇒ every camera is free, the original behaviour exactly.
 * - `solver_flat`: solver policy `[pcg_min_n, rel_tol, max_iter, accept_partial,
 *   function_tol, precond, direct, warm, huber]`; empty / NaN slots ⇒
 *   `SolverOpts::DEFAULT` (see there).
 * - `fisheye_flat`: n_cam × 5 floats `[terms, k1, k2, k3, k4, …]`. `terms` 0 ⇒ the
 *   camera is pinhole (+ the Brown self-cal residual) and its observations are in the
 *   undistorted frame; its k1…k3 slots seed that residual (the app passes zeros; the
 *   BAL bench, examples/bal.rs, the problems' own k1, k2); `terms` 1–4 ⇒ a Kannala–Brandt fisheye with those seed
 *   coefficients, observed in the pixels the lens recorded, of which the first `terms`
 *   may be self-calibrated (the k bits then refine the fisheye's own polynomial).
 *   Cameras sharing a sensor group must share a lens. Empty ⇒ every camera pinhole,
 *   the original behaviour exactly.
 *
 * # Output
 * `[cameras_flat(n_cam×12), pts_flat(n_pts×3), intrinsics_flat(n_cam×8),
 *   cost_before, cost_after, anchor_rms_after, camera_prior_rms_after,
 *   solver stats (BA_STATS_LEN), cost_trace…]` — the returned
 * intrinsics are the **refined** effective K per camera as `[fx,fy,cx,cy,k1,k2,k3,k4]`
 * — for a pinhole camera the self-calibrated Brown residual (0 for the bits not set
 * in `refine_mask`, k4 always 0), for a fisheye camera its full refined Kannala–Brandt
 * coefficients (the seed when nothing was refined); cost_before/cost_after are RMS reprojection error in
 * pixels (anchors do not affect them); anchor_rms_after is the RMS anchor
 * residual in the caller's world units, and camera_prior_rms_after is the RMS
 * camera-centre residual (both 0 when their respective prior list is empty).
 */
export function bundle_adjust(cameras_flat: Float32Array, intrinsics_flat: Float32Array, pts_flat: Float32Array, obs_index: Uint32Array, obs_px: Float32Array, observation_weight: Float32Array, anchor_flat: Float64Array, anchor_weight: Float32Array, camera_prior_flat: Float32Array, max_iters: number, sensor_of_cam: Int32Array, refine_mask: number, solver_flat: Float32Array, fixed_cam: Uint8Array, fisheye_flat: Float32Array): Float32Array;

/**
 * `bundle_adjust_rs` for the cameras of a rig (plan-after-0.7 ▸ MSP-1): a multispectral
 * camera's lenses, triggered together. The photos of one capture share one pose, the
 * capture's (its reference lens's), and each lens sees from a fixed offset to it:
 * x_cam = R_o·(R_c·X + t_c) + t_o, the offset the same for every capture. The solver
 * keeps one pose block per capture; with refine bit 128 each sensor group's offset
 * rotation is refined (three slots after τ, ω: R_o = Exp(ω)·R_o⁰), its lever arm t_o
 * kept (a few centimetres, too short to resolve from the photos). A group none of
 * whose cameras has an offset (the reference lens, or photos outside the rig) has no ω.
 *
 * - `capture_of_cam`: n_cam ints; cameras with the same non-negative value share a pose
 *   block, a negative value (or a short list) is a pose of its own.
 * - `offset_flat`: n_cam × 13 floats `[has, R_o(9), t_o(3), …]`; `has` 0 (or a short
 *   list) ⇒ no offset: the camera's pose is its capture's.
 *
 * A capture's pose starts from a camera without an offset where it has one, else from
 * its first camera with the offset taken off; it is held fixed only when every camera
 * in it is. A camera-centre prior acts on the capture's pose: give one per capture.
 * Output: `bundle_adjust_rs`'s, each camera's pose being its composed pose.
 */
export function bundle_adjust_rig(cameras_flat: Float32Array, intrinsics_flat: Float32Array, pts_flat: Float32Array, obs_index: Uint32Array, obs_px: Float32Array, observation_weight: Float32Array, anchor_flat: Float64Array, anchor_weight: Float32Array, camera_prior_flat: Float32Array, max_iters: number, sensor_of_cam: Int32Array, refine_mask: number, solver_flat: Float32Array, fixed_cam: Uint8Array, fisheye_flat: Float32Array, rs_flat: Float32Array, capture_of_cam: Int32Array, offset_flat: Float32Array): Float32Array;

/**
 * `bundle_adjust` with a rolling-shutter model (rsh, plan-after-0.7 ▸ RSH). A camera
 * whose rows are read one after another over the readout time τ sees each row from
 * a slightly different place: from C + τ·s·v, where v is the camera centre's velocity
 * (model units per second) and s = (row − cy)/H the row's time from the principal row
 * as a fraction of the readout. The solver takes the observed row for s (exact to
 * first order) and applies the shift to the point instead: x_cam = R·(X − τ·s·v) + t,
 * so the pose and point Jacobians keep their form and τ adds one column, −s·R·v.
 * The pose is the one at the principal row (what the camera-centre priors constrain).
 *
 * - `rs_flat`: n_cam × 5 floats `[vx, vy, vz, H, τ0, …]`; H ≤ 0 (or a short list) ⇒
 *   that camera reads all rows at once. τ0 is the readout time in seconds; with refine
 *   bit 64 the group's τ is refined from its first camera's τ0 (the slot follows k4).
 *
 * Output: `bundle_adjust`'s, with n_cam floats — each camera's τ after the solve —
 * between the solver stats and the cost trace.
 */
export function bundle_adjust_rs(cameras_flat: Float32Array, intrinsics_flat: Float32Array, pts_flat: Float32Array, obs_index: Uint32Array, obs_px: Float32Array, observation_weight: Float32Array, anchor_flat: Float64Array, anchor_weight: Float32Array, camera_prior_flat: Float32Array, max_iters: number, sensor_of_cam: Int32Array, refine_mask: number, solver_flat: Float32Array, fixed_cam: Uint8Array, fisheye_flat: Float32Array, rs_flat: Float32Array): Float32Array;

export function compute_depth_map(ref_gray: Uint8Array, ref_w: number, ref_h: number, ref_k: Float32Array, src_gray: Uint8Array, src_dims: Uint32Array, src_k: Float32Array, src_rel: Float32Array, src_mask: Uint8Array, seed_depth: Float32Array, depth_min: number, depth_max: number, window: number, iterations: number, best_k: number, seed: number, perturb_start: number, sigma_spatial: number, sigma_color: number, view_selection: number, window_step: number, seed_normals: Float32Array, prior: Float32Array, prior_alpha: number, prior_gamma: number, prior_sig_d: number, prior_sig_n: number, src_depth: Float32Array, geom_weight: number, geom_max: number): Float32Array;

export function initThreadPool(num_threads: number): Promise<any>;

export function plane_costs(ref_gray: Uint8Array, ref_w: number, ref_h: number, ref_k: Float32Array, src_gray: Uint8Array, src_dims: Uint32Array, src_k: Float32Array, src_rel: Float32Array, src_mask: Uint8Array, window: number, best_k: number, sigma_spatial: number, sigma_color: number, window_step: number, hyps: Float32Array): Float32Array;

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

/**
 * Undistort the pixels of several images through one Brown bag.
 *
 * `xy`: every image's keypoints, [x0, y0, x1, y1, …], image after image; `starts`: the
 * first point of each image, plus the total (n_images + 1 entries); `k`: [fx, fy, cx, cy]
 * per image, the K each image's pixels are normalised about; `d`: [k1, k2, k3, k4, k5,
 * k6, p1, p2]; `iters`: the Newton step cap. A point whose x is NaN (a missing
 * keypoint) stays NaN. The images run on the thread pool in the threaded build.
 */
export function undistort_brown_pixels(xy: Float64Array, starts: Uint32Array, k: Float64Array, d: Float64Array, iters: number): Float64Array;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_guidedsearch_free: (a: number, b: number) => void;
    readonly bundle_adjust: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number) => [number, number];
    readonly bundle_adjust_rig: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number, e1: number, f1: number, g1: number, h1: number) => [number, number];
    readonly bundle_adjust_rs: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number) => [number, number];
    readonly compute_depth_map: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number, e1: number, f1: number, g1: number, h1: number, i1: number, j1: number, k1: number, l1: number, m1: number, n1: number, o1: number) => [number, number];
    readonly guidedsearch_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => number;
    readonly guidedsearch_search: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number) => [number, number];
    readonly plane_costs: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number) => [number, number];
    readonly recover_pose: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly solve_pnp: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly triangulate_dlt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly undistort_brown_pixels: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;

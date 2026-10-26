/* @ts-self-types="./reconstruction.d.ts" */
import { startWorkers } from './snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js';


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
 * rows carry independent inverse-variance weights for X/Y/Z. Orientation uses
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
 *   feature observations use 1, GCP marks use their declared pixel variances
 * - `anchor_weight`: n_anchor × 9 floats, row-major 3×3 precision matrices
 * - `camera_prior_flat`: n_prior × 25 floats
 *   `[cam_i, target_x, target_y, target_z, weight_x, weight_y, weight_z,
 *     target_R(9), orientation_precision(9), …]`. An all-zero orientation
 *   precision matrix makes the row position-only.
 * - `max_iters`: outer LM iterations
 * - `sensor_of_cam`: n_cam ints — per-camera sensor id (shared → shared focal);
 *   `< 0` (or a short/empty list) ⇒ that camera is its own group
 * - `refine_mask`: **bitmask** of the shared per-sensor intrinsics to self-calibrate:
 *   1 = focal scale s, 2 = principal point (dcx,dcy), 4 = radial k1, 8 = k2, 16 = k3,
 *   32 = k4 (fisheye only). 0 ⇒ poses+points only. The per-group param vector is the
 *   ordered subset `[s?, dcx?, dcy?, k1?, k2?, k3?, k4?]` (kdim ≤ 7). fy stays locked
 *   to fx (single scale). A coefficient a group's lens does not have (k4 on a Brown
 *   group, k3 on a two-term fisheye) is held at its seed.
 * - `fixed_cam`: n_cam bytes, non-zero ⇒ that camera's pose is held fixed (local BA:
 *   the cameras outside the window keep their observations as constraints but are
 *   not variables). Empty ⇒ every camera is free, the original behaviour exactly.
 * - `solver_flat`: reduced-system policy `[pcg_min_n, rel_tol, max_iter, accept_partial]`;
 *   empty / NaN slots ⇒ `SolverOpts::DEFAULT` (see there).
 * - `fisheye_flat`: n_cam × 5 floats `[terms, k1, k2, k3, k4, …]`. `terms` 0 ⇒ the
 *   camera is pinhole (+ the Brown self-cal residual) and its observations are in the
 *   undistorted frame; `terms` 1–4 ⇒ a Kannala–Brandt fisheye with those seed
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
 * @param {Float32Array} cameras_flat
 * @param {Float32Array} intrinsics_flat
 * @param {Float32Array} pts_flat
 * @param {Uint32Array} obs_index
 * @param {Float32Array} obs_px
 * @param {Float32Array} observation_weight
 * @param {Float64Array} anchor_flat
 * @param {Float32Array} anchor_weight
 * @param {Float32Array} camera_prior_flat
 * @param {number} max_iters
 * @param {Int32Array} sensor_of_cam
 * @param {number} refine_mask
 * @param {Float32Array} solver_flat
 * @param {Uint8Array} fixed_cam
 * @param {Float32Array} fisheye_flat
 * @returns {Float32Array}
 */
export function bundle_adjust(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px, observation_weight, anchor_flat, anchor_weight, camera_prior_flat, max_iters, sensor_of_cam, refine_mask, solver_flat, fixed_cam, fisheye_flat) {
    const ptr0 = passArrayF32ToWasm0(cameras_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(intrinsics_flat, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(pts_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(obs_index, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF32ToWasm0(obs_px, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF32ToWasm0(observation_weight, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArrayF64ToWasm0(anchor_flat, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArrayF32ToWasm0(anchor_weight, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArrayF32ToWasm0(camera_prior_flat, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ptr9 = passArray32ToWasm0(sensor_of_cam, wasm.__wbindgen_malloc);
    const len9 = WASM_VECTOR_LEN;
    const ptr10 = passArrayF32ToWasm0(solver_flat, wasm.__wbindgen_malloc);
    const len10 = WASM_VECTOR_LEN;
    const ptr11 = passArray8ToWasm0(fixed_cam, wasm.__wbindgen_malloc);
    const len11 = WASM_VECTOR_LEN;
    const ptr12 = passArrayF32ToWasm0(fisheye_flat, wasm.__wbindgen_malloc);
    const len12 = WASM_VECTOR_LEN;
    const ret = wasm.bundle_adjust(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, max_iters, ptr9, len9, refine_mask, ptr10, len10, ptr11, len11, ptr12, len12);
    var v14 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v14;
}

/**
 * @param {Uint8Array} ref_gray
 * @param {number} ref_w
 * @param {number} ref_h
 * @param {Float32Array} ref_k
 * @param {Uint8Array} src_gray
 * @param {Uint32Array} src_dims
 * @param {Float32Array} src_k
 * @param {Float32Array} src_rel
 * @param {Uint8Array} src_mask
 * @param {Float32Array} seed_depth
 * @param {number} depth_min
 * @param {number} depth_max
 * @param {number} window
 * @param {number} iterations
 * @param {number} best_k
 * @param {number} seed
 * @param {number} perturb_start
 * @param {number} sigma_spatial
 * @param {number} sigma_color
 * @returns {Float32Array}
 */
export function compute_depth_map(ref_gray, ref_w, ref_h, ref_k, src_gray, src_dims, src_k, src_rel, src_mask, seed_depth, depth_min, depth_max, window, iterations, best_k, seed, perturb_start, sigma_spatial, sigma_color) {
    const ptr0 = passArray8ToWasm0(ref_gray, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(ref_k, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(src_gray, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(src_dims, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF32ToWasm0(src_k, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF32ToWasm0(src_rel, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray8ToWasm0(src_mask, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArrayF32ToWasm0(seed_depth, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ret = wasm.compute_depth_map(ptr0, len0, ref_w, ref_h, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, depth_min, depth_max, window, iterations, best_k, seed, perturb_start, sigma_spatial, sigma_color);
    var v9 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v9;
}

/**
 * @param {number} num_threads
 * @returns {Promise<any>}
 */
export function initThreadPool(num_threads) {
    const ret = wasm.initThreadPool(num_threads);
    return ret;
}

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
 * @param {Float32Array} pts_a
 * @param {Float32Array} pts_b
 * @param {Float32Array} e_flat
 * @param {number} fx
 * @param {number} fy
 * @param {number} cx
 * @param {number} cy
 * @returns {Float32Array}
 */
export function recover_pose(pts_a, pts_b, e_flat, fx, fy, cx, cy) {
    const ptr0 = passArrayF32ToWasm0(pts_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(pts_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(e_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.recover_pose(ptr0, len0, ptr1, len1, ptr2, len2, fx, fy, cx, cy);
    var v4 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

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
 * @param {Float32Array} pts_3d
 * @param {Float32Array} pts_2d
 * @param {number} fx
 * @param {number} fy
 * @param {number} cx
 * @param {number} cy
 * @param {number} ransac_thresh_px
 * @param {number} max_iters
 * @returns {Float32Array}
 */
export function solve_pnp(pts_3d, pts_2d, fx, fy, cx, cy, ransac_thresh_px, max_iters) {
    const ptr0 = passArrayF32ToWasm0(pts_3d, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(pts_2d, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.solve_pnp(ptr0, len0, ptr1, len1, fx, fy, cx, cy, ransac_thresh_px, max_iters);
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

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
 * @param {Float32Array} pts_a
 * @param {Float32Array} pts_b
 * @param {Float32Array} p_a
 * @param {Float32Array} p_b
 * @returns {Float32Array}
 */
export function triangulate_dlt(pts_a, pts_b, p_a, p_b) {
    const ptr0 = passArrayF32ToWasm0(pts_a, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(pts_b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(p_a, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF32ToWasm0(p_b, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.triangulate_dlt(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    var v5 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v5;
}

/**
 * Undistort the pixels of several images through one Brown bag.
 *
 * `xy`: every image's keypoints, [x0, y0, x1, y1, …], image after image; `starts`: the
 * first point of each image, plus the total (n_images + 1 entries); `k`: [fx, fy, cx, cy]
 * per image, the K each image's pixels are normalised about; `d`: [k1, k2, k3, k4, k5,
 * k6, p1, p2]; `iters`: the Newton step cap. A point whose x is NaN (a missing
 * keypoint) stays NaN. The images run on the thread pool in the threaded build.
 * @param {Float64Array} xy
 * @param {Uint32Array} starts
 * @param {Float64Array} k
 * @param {Float64Array} d
 * @param {number} iters
 * @returns {Float64Array}
 */
export function undistort_brown_pixels(xy, starts, k, d, iters) {
    const ptr0 = passArrayF64ToWasm0(xy, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(starts, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(k, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(d, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.undistort_brown_pixels(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, iters);
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

export class wbg_rayon_PoolBuilder {
    static __wrap(ptr) {
        const obj = Object.create(wbg_rayon_PoolBuilder.prototype);
        obj.__wbg_ptr = ptr;
        wbg_rayon_PoolBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        wbg_rayon_PoolBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 0);
    }
    build() {
        wasm.wbg_rayon_poolbuilder_build(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    numThreads() {
        const ret = wasm.wbg_rayon_poolbuilder_numThreads(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    receiver() {
        const ret = wasm.wbg_rayon_poolbuilder_receiver(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) wbg_rayon_PoolBuilder.prototype[Symbol.dispose] = wbg_rayon_PoolBuilder.prototype.free;

/**
 * @param {number} receiver
 */
export function wbg_rayon_start_worker(receiver) {
    wasm.wbg_rayon_start_worker(receiver);
}
function __wbg_get_imports(memory) {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_undefined_721f8decd50c87a3: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_memory_9751d9a3017e7c25: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_module_f86f28f0f85995dd: function() {
            const ret = wasmModule;
            return ret;
        },
        __wbg___wbindgen_throw_ea4887a5f8f9a9db: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_instanceof_Window_0d356b88a2f77c42: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_startWorkers_8b582d57e92bd2d4: function(arg0, arg1, arg2) {
            const ret = startWorkers(arg0, arg1, wbg_rayon_PoolBuilder.__wrap(arg2));
            return ret;
        },
        __wbg_static_accessor_GLOBAL_THIS_2fee5048bcca5938: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_ce44e66a4935da8c: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_44f6e0cb5e67cdad: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_168f178805d978fe: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
        memory: memory || new WebAssembly.Memory({initial:18,maximum:65536,shared:true}),
    };
    return {
        __proto__: null,
        "./reconstruction_bg.js": import0,
    };
}

const wbg_rayon_PoolBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : undefined);
if (cachedTextDecoder) cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module, thread_stack_size) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    if (typeof thread_stack_size !== 'undefined' && (typeof thread_stack_size !== 'number' || thread_stack_size === 0 || thread_stack_size % 65536 !== 0)) {
        throw new Error('invalid stack size');
    }

    wasm.__wbindgen_start(thread_stack_size);
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module, memory, thread_stack_size} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports(memory);
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module, thread_stack_size);
}

async function __wbg_init(module_or_path, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path, memory, thread_stack_size} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('reconstruction_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports(memory);

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

export { initSync, __wbg_init as default };

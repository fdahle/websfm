/* @ts-self-types="./reconstruction.d.ts" */

/**
 * Simplified bundle adjustment via alternating minimisation.
 *
 * Outer loop: fix cameras → refine each 3D point (linear DLT).
 *             fix points  → refine each camera pose (gradient descent, finite differences).
 *
 * # Inputs
 * - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), R(9)|t(3), …]`
 * - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]`
 * - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
 * - `obs_flat`: n_obs × 4 floats `[cam_i, pt_i, pixel_x, pixel_y, …]`
 * - `max_iters`: outer iterations (typically 20–50)
 *
 * # Output
 * `[cameras_flat(n_cam×12), pts_flat(n_pts×3)]`
 * @param {Float32Array} cameras_flat
 * @param {Float32Array} intrinsics_flat
 * @param {Float32Array} pts_flat
 * @param {Float32Array} obs_flat
 * @param {number} max_iters
 * @returns {Float32Array}
 */
export function bundle_adjust(cameras_flat, intrinsics_flat, pts_flat, obs_flat, max_iters) {
    const ptr0 = passArrayF32ToWasm0(cameras_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(intrinsics_flat, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(pts_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF32ToWasm0(obs_flat, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.bundle_adjust(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, max_iters);
    var v5 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v5;
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
 * Estimate camera pose from 3D-2D correspondences via RANSAC + DLT PnP.
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
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./reconstruction_bg.js": import0,
    };
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    wasm.__wbindgen_start();
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

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('reconstruction_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

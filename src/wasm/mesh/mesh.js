/* @ts-self-types="./mesh.d.ts" */

/**
 * Staged, JS-driven wrapper around the screened-Poisson solve. Exposes the phases the
 * worker steps through so it can paint per-layer progress (the whole solve is a single
 * blocking wasm call otherwise — the "stuck at Poisson solve" symptom) and keep the
 * largest uninterruptible unit of work down to one multigrid layer:
 *
 * ```text
 *   let m = PoissonMesher.build(pos, nrm, depth, screening)   // build octree + field
 *   for _ in 0..m.num_layers() { m.solve_step() }             // solve, report progress
 *   let bytes = m.finish(trim_dist)                            // extract + trim + encode
 *   m.free()
 * ```
 *
 * The one-shot [`poisson_mesh`] free function is kept for the Rust tests (which run
 * natively and cannot construct a JS driver).
 */
export class PoissonMesher {
    static __wrap(ptr) {
        const obj = Object.create(PoissonMesher.prototype);
        obj.__wbg_ptr = ptr;
        PoissonMesherFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PoissonMesherFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_poissonmesher_free(ptr, 0);
    }
    /**
     * Build the multigrid octree + vector field (no layer solved yet). `pos`/`nrm` are
     * flat `3·N` f32 (world-space; `nrm` unit); `max_depth`/`screening` as in
     * [`poisson_mesh`]. An empty / degenerate input yields a mesher with zero layers
     * whose `finish` returns an empty mesh.
     * @param {Float32Array} pos
     * @param {Float32Array} nrm
     * @param {number} max_depth
     * @param {number} screening
     * @returns {PoissonMesher}
     */
    static build(pos, nrm, max_depth, screening) {
        const ptr0 = passArrayF32ToWasm0(pos, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(nrm, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.poissonmesher_build(ptr0, len0, ptr1, len1, max_depth, screening);
        return PoissonMesher.__wrap(ret);
    }
    /**
     * Solve any remaining layers, then extract, trim (world-unit `trim_dist`; ≤0
     * disables), and encode the mesh to the little-endian wire buffer described on
     * [`poisson_mesh`]. Consumes the internal builder — call once.
     * @param {number} trim_dist
     * @returns {Uint8Array}
     */
    finish(trim_dist) {
        const ret = wasm.poissonmesher_finish(this.__wbg_ptr, trim_dist);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Number of multigrid layers to solve (`== max_depth + 1`, or 0 for a degenerate
     * build). Drives the caller's progress denominator.
     * @returns {number}
     */
    num_layers() {
        const ret = wasm.poissonmesher_num_layers(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Solve the next multigrid layer (coarsest first). Returns `true` while more layers
     * remain. A no-op (`false`) once every layer is solved or on a degenerate build.
     * @returns {boolean}
     */
    solve_step() {
        const ret = wasm.poissonmesher_solve_step(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) PoissonMesher.prototype[Symbol.dispose] = PoissonMesher.prototype.free;

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
 * @param {Float32Array} pos
 * @param {Float32Array} nrm
 * @param {number} max_depth
 * @param {number} screening
 * @param {number} trim_dist
 * @returns {Uint8Array}
 */
export function poisson_mesh(pos, nrm, max_depth, screening, trim_dist) {
    const ptr0 = passArrayF32ToWasm0(pos, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(nrm, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.poisson_mesh(ptr0, len0, ptr1, len1, max_depth, screening, trim_dist);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_ea4887a5f8f9a9db: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
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
    };
    return {
        __proto__: null,
        "./mesh_bg.js": import0,
    };
}

const PoissonMesherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_poissonmesher_free(ptr, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
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
        module_or_path = new URL('mesh_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

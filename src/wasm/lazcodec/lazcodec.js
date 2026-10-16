/* @ts-self-types="./lazcodec.d.ts" */

/**
 * Compressed points plus the LASzip VLR payload that describes them. Both are
 * moved out to JS by value (`data()` / `vlr()` consume nothing but clone the
 * smaller VLR; `data()` takes the big buffer).
 */
export class CompressedPoints {
    static __wrap(ptr) {
        const obj = Object.create(CompressedPoints.prototype);
        obj.__wbg_ptr = ptr;
        CompressedPointsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedPointsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedpoints_free(ptr, 0);
    }
    /**
     * Move the compressed point block out to JS (consumes the handle).
     * @returns {Uint8Array}
     */
    data() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.compressedpoints_data(ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The LASzip VLR record payload — JS writes it into the LAS header's VLR
     * area as user id "laszip encoded", record id 22204.
     * @returns {Uint8Array}
     */
    get vlr() {
        const ret = wasm.compressedpoints_vlr(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedPoints.prototype[Symbol.dispose] = CompressedPoints.prototype.free;

/**
 * Streaming decoder: a LAZ file's points a run of chunks at a time, so a file larger
 * than memory can be read (plan-lod ▸ L4). JS reads the chunk table's bytes from the
 * file and asks for each chunk's point and byte counts; it then slices a run of whole
 * chunks out of the file and decodes them here. Each LASzip chunk restarts the
 * arithmetic coder, so a chunk decodes on its own: each is wrapped as a small stream
 * (chunk-table offset, the chunk, a one-entry chunk table) and handed to the same
 * decompressor a whole file goes through.
 */
export class LazDecoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LazDecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lazdecoder_free(ptr, 0);
    }
    /**
     * Compressed bytes of chunk `i`.
     * @param {number} i
     * @returns {number}
     */
    chunk_bytes(i) {
        const ret = wasm.lazdecoder_chunk_bytes(this.__wbg_ptr, i);
        return ret;
    }
    /**
     * @returns {number}
     */
    chunk_count() {
        const ret = wasm.lazdecoder_chunk_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Points in chunk `i` (fixed-size chunks: the nominal size).
     * @param {number} i
     * @returns {number}
     */
    chunk_points(i) {
        const ret = wasm.lazdecoder_chunk_points(this.__wbg_ptr, i);
        return ret;
    }
    /**
     * Decode `num_points` points from the chunks `first .. first + count`, whose
     * compressed bytes are `compressed` (back to back, as in the file).
     * @param {Uint8Array} compressed
     * @param {number} first
     * @param {number} count
     * @param {number} num_points
     * @returns {Uint8Array}
     */
    decode(compressed, first, count, num_points) {
        const ptr0 = passArray8ToWasm0(compressed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lazdecoder_decode(this.__wbg_ptr, ptr0, len0, first, count, num_points);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * `chunk_table`: the file's bytes from the chunk table's offset on (trailing bytes
     * such as EVLRs are ignored). Fixed-size chunks get the VLR's chunk size as their
     * point count; the last one may hold fewer, which the caller knows from the header.
     * @param {Uint8Array} vlr_data
     * @param {Uint8Array} chunk_table
     */
    constructor(vlr_data, chunk_table) {
        const ptr0 = passArray8ToWasm0(vlr_data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(chunk_table, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.lazdecoder_new(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        LazDecoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    point_size() {
        const ret = wasm.lazdecoder_point_size(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) LazDecoder.prototype[Symbol.dispose] = LazDecoder.prototype.free;

/**
 * Incremental encoder: owns one continuous LASzip stream across JS chunks.
 */
export class LazEncoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LazEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lazencoder_free(ptr, 0);
    }
    /**
     * @returns {CompressedPoints}
     */
    finish() {
        const ret = wasm.lazencoder_finish(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedPoints.__wrap(ret[0]);
    }
    /**
     * @param {number} point_format
     * @param {number} point_size
     */
    constructor(point_format, point_size) {
        const ret = wasm.lazencoder_new(point_format, point_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        LazEncoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} points
     */
    push(points) {
        const ptr0 = passArray8ToWasm0(points, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lazencoder_push(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) LazEncoder.prototype[Symbol.dispose] = LazEncoder.prototype.free;

/**
 * Compress raw LAS point records.
 *
 * `points` is `num_points × point_size` interleaved bytes, exactly the on-disk
 * layout. `point_size` must match the format's record length (the caller may add
 * "extra bytes", which LASzip carries verbatim — but we reject a size *smaller*
 * than the format requires, which would mean the caller mis-sized its records).
 * @param {Uint8Array} points
 * @param {number} point_format
 * @param {number} point_size
 * @returns {CompressedPoints}
 */
export function compress_points(points, point_format, point_size) {
    const ptr0 = passArray8ToWasm0(points, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compress_points(ptr0, len0, point_format, point_size);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return CompressedPoints.__wrap(ret[0]);
}

/**
 * Decompress a LAZ point block back to raw LAS point records.
 *
 * `vlr_data` is the LASzip VLR payload read from the file — **not** reconstructed
 * from the point format. A LAZ file records its own chunking and item layout
 * there, and assuming ours would mis-decode anything another writer produced.
 * @param {Uint8Array} vlr_data
 * @param {Uint8Array} compressed
 * @param {number} num_points
 * @param {number} point_size
 * @returns {Uint8Array}
 */
export function decompress_points(vlr_data, compressed, num_points, point_size) {
    const ptr0 = passArray8ToWasm0(vlr_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(compressed, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.decompress_points(ptr0, len0, ptr1, len1, num_points, point_size);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_fdd633d4bb5dd76a: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
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
        "./lazcodec_bg.js": import0,
    };
}

const CompressedPointsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedpoints_free(ptr, 1));
const LazDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lazdecoder_free(ptr, 1));
const LazEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lazencoder_free(ptr, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
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

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
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
        module_or_path = new URL('lazcodec_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

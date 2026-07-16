/* tslint:disable */
/* eslint-disable */

/**
 * A decoded TIFF as interleaved 8-bit RGBA. `width`/`height` are plain getters;
 * `rgba()` **consumes** the handle to move the pixel buffer to JS without a copy
 * (these buffers are ~390 MB for a 97 MP image — do not clone). JS reads
 * `width`/`height` first, then calls `rgba()` last.
 */
export class DecodedTiff {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Move the RGBA buffer out to JS (consumes `self`; the handle is freed).
     */
    rgba(): Uint8Array;
    readonly height: number;
    readonly width: number;
}

/**
 * Decode a TIFF byte buffer to interleaved 8-bit RGBA.
 *
 * Errors (unsupported color type / bit depth, corrupt data) surface as a
 * `JsError` so the JS worker can fall back to the geotiff.js path.
 */
export function decode_tiff(bytes: Uint8Array): DecodedTiff;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decodedtiff_free: (a: number, b: number) => void;
    readonly decode_tiff: (a: number, b: number) => [number, number, number];
    readonly decodedtiff_height: (a: number) => number;
    readonly decodedtiff_rgba: (a: number) => [number, number];
    readonly decodedtiff_width: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
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

/* tslint:disable */
/* eslint-disable */

/**
 * Compressed points plus the LASzip VLR payload that describes them. Both are
 * moved out to JS by value (`data()` / `vlr()` consume nothing but clone the
 * smaller VLR; `data()` takes the big buffer).
 */
export class CompressedPoints {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Move the compressed point block out to JS (consumes the handle).
     */
    data(): Uint8Array;
    /**
     * The LASzip VLR record payload — JS writes it into the LAS header's VLR
     * area as user id "laszip encoded", record id 22204.
     */
    readonly vlr: Uint8Array;
}

/**
 * Compress raw LAS point records.
 *
 * `points` is `num_points × point_size` interleaved bytes, exactly the on-disk
 * layout. `point_size` must match the format's record length (the caller may add
 * "extra bytes", which LASzip carries verbatim — but we reject a size *smaller*
 * than the format requires, which would mean the caller mis-sized its records).
 */
export function compress_points(points: Uint8Array, point_format: number, point_size: number): CompressedPoints;

/**
 * Decompress a LAZ point block back to raw LAS point records.
 *
 * `vlr_data` is the LASzip VLR payload read from the file — **not** reconstructed
 * from the point format. A LAZ file records its own chunking and item layout
 * there, and assuming ours would mis-decode anything another writer produced.
 */
export function decompress_points(vlr_data: Uint8Array, compressed: Uint8Array, num_points: number, point_size: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_compressedpoints_free: (a: number, b: number) => void;
    readonly compress_points: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly compressedpoints_data: (a: number) => [number, number];
    readonly compressedpoints_vlr: (a: number) => [number, number];
    readonly decompress_points: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
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

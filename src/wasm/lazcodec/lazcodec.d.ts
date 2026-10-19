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
 * Streaming decoder: a LAZ file's points a run of chunks at a time, so a file larger
 * than memory can be read (plan-lod ▸ L4). JS reads the chunk table's bytes from the
 * file and asks for each chunk's point and byte counts; it then slices a run of whole
 * chunks out of the file and decodes them here. Each LASzip chunk restarts the
 * arithmetic coder, so a chunk decodes on its own: each is wrapped as a small stream
 * (chunk-table offset, the chunk, a one-entry chunk table) and handed to the same
 * decompressor a whole file goes through.
 */
export class LazDecoder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Compressed bytes of chunk `i`.
     */
    chunk_bytes(i: number): number;
    chunk_count(): number;
    /**
     * Points in chunk `i` (fixed-size chunks: the nominal size).
     */
    chunk_points(i: number): number;
    /**
     * Decode `num_points` points from the chunks `first .. first + count`, whose
     * compressed bytes are `compressed` (back to back, as in the file).
     */
    decode(compressed: Uint8Array, first: number, count: number, num_points: number): Uint8Array;
    /**
     * Decode one whole chunk of `num_points` points from its compressed bytes.
     */
    decode_chunk(compressed: Uint8Array, num_points: number): Uint8Array;
    /**
     * A decoder with no chunk table, for chunks the caller locates itself: a COPC
     * file's hierarchy gives every node's byte range and point count, and each node
     * is one chunk (`decode_chunk`).
     */
    static forChunks(vlr_data: Uint8Array): LazDecoder;
    /**
     * `chunk_table`: the file's bytes from the chunk table's offset on (trailing bytes
     * such as EVLRs are ignored). Fixed-size chunks get the VLR's chunk size as their
     * point count; the last one may hold fewer, which the caller knows from the header.
     */
    constructor(vlr_data: Uint8Array, chunk_table: Uint8Array);
    point_size(): number;
}

/**
 * Incremental encoder: owns one continuous LASzip stream across JS chunks.
 */
export class LazEncoder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The compressed bytes written since the last drain, past the first 8 (see
     * DrainSink). `finish` then returns those 8 bytes followed by the rest.
     */
    drain(): Uint8Array;
    finish(): CompressedPoints;
    constructor(point_format: number, point_size: number);
    push(points: Uint8Array): void;
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
    readonly __wbg_lazdecoder_free: (a: number, b: number) => void;
    readonly __wbg_lazencoder_free: (a: number, b: number) => void;
    readonly compress_points: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly compressedpoints_data: (a: number) => [number, number];
    readonly compressedpoints_vlr: (a: number) => [number, number];
    readonly decompress_points: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly lazdecoder_chunk_bytes: (a: number, b: number) => number;
    readonly lazdecoder_chunk_count: (a: number) => number;
    readonly lazdecoder_chunk_points: (a: number, b: number) => number;
    readonly lazdecoder_decode: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly lazdecoder_decode_chunk: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly lazdecoder_forChunks: (a: number, b: number) => [number, number, number];
    readonly lazdecoder_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly lazdecoder_point_size: (a: number) => number;
    readonly lazencoder_drain: (a: number) => [number, number, number, number];
    readonly lazencoder_finish: (a: number) => [number, number, number];
    readonly lazencoder_new: (a: number, b: number) => [number, number, number];
    readonly lazencoder_push: (a: number, b: number, c: number) => [number, number];
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

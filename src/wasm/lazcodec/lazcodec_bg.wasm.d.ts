/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const __wbg_compressedpoints_free: (a: number, b: number) => void;
export const __wbg_lazdecoder_free: (a: number, b: number) => void;
export const __wbg_lazencoder_free: (a: number, b: number) => void;
export const compress_points: (a: number, b: number, c: number, d: number) => [number, number, number];
export const compressedpoints_data: (a: number) => [number, number];
export const compressedpoints_vlr: (a: number) => [number, number];
export const decompress_points: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const lazdecoder_chunk_bytes: (a: number, b: number) => number;
export const lazdecoder_chunk_count: (a: number) => number;
export const lazdecoder_chunk_points: (a: number, b: number) => number;
export const lazdecoder_decode: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const lazdecoder_decode_chunk: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const lazdecoder_forChunks: (a: number, b: number) => [number, number, number];
export const lazdecoder_new: (a: number, b: number, c: number, d: number) => [number, number, number];
export const lazdecoder_point_size: (a: number) => number;
export const lazencoder_drain: (a: number) => [number, number, number, number];
export const lazencoder_finish: (a: number) => [number, number, number];
export const lazencoder_new: (a: number, b: number) => [number, number, number];
export const lazencoder_push: (a: number, b: number, c: number) => [number, number];
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;

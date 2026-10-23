// Typed arrays past the browser's ArrayBuffer limits, held in WebAssembly memory.
//
// Chrome caps one ArrayBuffer at 2 GiB − 2 MiB and holds 16 GiB of them per tab
// (core/bufferLimit.js). Neither limit applies to a WebAssembly.Memory: one memory holds
// 4 GiB (wasm32) or 16 GiB (Memory64), views over it run at a plain array's speed, and
// memories are not drawn from the 16 GiB pool (Chrome 156, probed 2026-10-23: the page
// held 15 GiB of ArrayBuffers and 20 GiB of wasm memory beside them; page and a worker
// 40 GiB of wasm memory together; dev/planning/plan-past-browser-limits.md). So an array
// that would hit either wall gets a memory of its own, sized to it.
//
// Two kinds, by where the array goes:
// - `localArray`: stays in the worker that made it (an accumulator, a cache). From
//   `LOCAL_MIN_BYTES` it lives in a non-shared memory, which takes it out of the pool in
//   every browser. Such a buffer cannot be transferred, and posting it copies it.
// - `shareableArray`: crosses to the page or another worker (a fused cloud). It stays a
//   plain typed array up to MAX_BUFFER_BYTES, exactly as before, and only past that
//   lives in a SHARED memory, which postMessage hands over without a copy. Shared
//   memory needs a cross-origin isolated page; without one the plain limit stays.
//
// What code holding a wasm-backed array must know:
// - Its `.buffer` is longer than the array (a memory is whole 64 KiB pages): use the
//   view (`byteOffset`, `byteLength`), never `new T(arr.buffer)`.
// - A SharedArrayBuffer must not be in a transfer list (DataCloneError): build lists
//   with `transferList`.
// - Some APIs refuse shared views (Blob, file writes, TextDecoder): copy through with
//   `chunksOf`.
// - It is freed by GC like any array; a memory never shrinks, so it is never reused.
//
// Pure: WebAssembly is part of the language, so this runs in the page, a worker and Node.

import { MAX_BUFFER_BYTES } from './bufferLimit.js'

const PAGE = 65536
const GiB = 2 ** 30
// Below this a local array stays plain: a memory per small array buys nothing.
export const LOCAL_MIN_BYTES = 64 * 2 ** 20

let caps = null

// What this realm offers, probed once: wasm memories at all, Memory64 (and its largest
// memory), shared memories (cross-origin isolated), shared Memory64.
export function bigArrayCaps() {
  if (caps) return caps
  const W = globalThis.WebAssembly
  const ok = (desc, i64) => {
    try {
      const m = new W.Memory(desc)
      // An engine without Memory64 ignores `address` and makes a wasm32 memory, whose
      // grow() refuses a BigInt.
      if (i64) m.grow(0n)
      return true
    } catch {
      return false
    }
  }
  const wasm = !!W?.Memory && ok({ initial: 0, maximum: 1 }, false)
  const isolated = globalThis.crossOriginIsolated !== false && typeof SharedArrayBuffer !== 'undefined'
  // The largest Memory64 memory the engine accepts (V8: 2^18 pages, 16 GiB). Asking for
  // a maximum reserves address space only; nothing is committed.
  const max64Pages = (shared) => {
    for (const pages of [2 ** 18, 2 ** 17]) {
      if (ok({ address: 'i64', initial: 0n, maximum: BigInt(pages), shared }, true)) return pages
    }
    return 0
  }
  const local64 = wasm ? max64Pages(false) : 0
  const shared32 = wasm && isolated && ok({ initial: 0, maximum: 1, shared: true }, false)
  const shared64 = shared32 ? max64Pages(true) : 0
  caps = {
    wasm,
    memory64: local64 > 0,
    shared: shared32,
    maxLocalBytes: local64 ? local64 * PAGE : wasm ? 4 * GiB : MAX_BUFFER_BYTES,
    maxShareableBytes: shared64 ? shared64 * PAGE : shared32 ? 4 * GiB : MAX_BUFFER_BYTES,
  }
  return caps
}

// Tests only: probe again (after stubbing globals), or pin the answer.
export function setBigArrayCaps(next = null) {
  caps = next
}

// The browser's own refusal, so callers' existing messages (bufferFailureText) apply.
const refused = (bytes) =>
  new RangeError(`Array buffer allocation failed (${bytes.toLocaleString()} bytes in one array)`)

// Address space, not bytes, is what wasm memories run out of. V8 reserves ~8 GiB for each
// wasm32 memory (its guard region) and 16 GiB for each Memory64 one, out of ~1 TiB for
// the process, page and workers together: Chrome 156 made 125 wasm32 or 62 Memory64
// memories of 64 MiB, then refused ("could not allocate memory"), and the app's own wasm
// modules hold some. So arrays made together share one memory (`localArrays`,
// `shareableArrays`, `sharedArrays`): a memory is freed once all its arrays are
// unreachable. A refused memory falls back to plain arrays where they fit.
const wasmBuffers = new WeakSet() // non-shared wasm memories: cannot be transferred
const ALIGN = 16
const sizeOf = ([T, n]) => n * T.BYTES_PER_ELEMENT
const padded = (bytes) => Math.ceil(bytes / ALIGN) * ALIGN
const totalOf = (specs) => specs.reduce((t, s) => t + padded(sizeOf(s)), 0)

// The arrays of `specs` ([[T, n], …]) in one new memory, or null when the engine refuses it.
function wasmGroup(specs, shared) {
  const bytes = totalOf(specs)
  const pages = Math.max(1, Math.ceil(bytes / PAGE))
  let mem
  try {
    mem =
      pages > 65536
        ? new WebAssembly.Memory({ address: 'i64', initial: BigInt(pages), maximum: BigInt(pages), shared })
        : new WebAssembly.Memory({ initial: pages, maximum: pages, shared })
  } catch {
    return null
  }
  if (mem.buffer.byteLength < bytes) return null // `address` ignored: no Memory64
  if (!shared) wasmBuffers.add(mem.buffer)
  let off = 0
  return specs.map(([T, n]) => {
    const a = new T(mem.buffer, off, n)
    off += padded(n * T.BYTES_PER_ELEMENT)
    return a
  })
}

const plainAll = (specs) =>
  specs.map(([T, n]) => {
    if (n * T.BYTES_PER_ELEMENT > MAX_BUFFER_BYTES) throw refused(n * T.BYTES_PER_ELEMENT)
    return new T(n)
  })

// One memory for the group where it fits one, else one per array; plain arrays where the
// engine refuses a memory (and they fit a plain buffer).
function inWasm(specs, shared, maxBytes) {
  if (totalOf(specs) <= maxBytes) return wasmGroup(specs, shared) ?? plainAll(specs)
  if (specs.length > 1) return specs.map((s) => inWasm([s], shared, maxBytes)[0])
  throw refused(sizeOf(specs[0]))
}

/** Typed arrays ([[T, n], …], zeroed) that stay in this worker: from LOCAL_MIN_BYTES
 *  together, they share one wasm memory, outside the ArrayBuffer pool. */
export function localArrays(specs, { minBytes = LOCAL_MIN_BYTES } = {}) {
  const c = bigArrayCaps()
  if (!c.wasm || totalOf(specs) < minBytes) return plainAll(specs)
  return inWasm(specs, false, c.maxLocalBytes)
}

/** Typed arrays that may be posted to the page or another worker: plain while each fits
 *  `maxPlainBytes` (MAX_BUFFER_BYTES, as before), else together in shared wasm memory. */
export function shareableArrays(specs, { maxPlainBytes = MAX_BUFFER_BYTES } = {}) {
  if (specs.every((s) => sizeOf(s) <= maxPlainBytes)) return plainAll(specs)
  const c = bigArrayCaps()
  if (!c.shared) return plainAll(specs)
  return inWasm(specs, true, c.maxShareableBytes)
}

/** Typed arrays in shared memory from LOCAL_MIN_BYTES together, whatever their size, where
 *  the page is cross-origin isolated: posted uncopied and outside the ArrayBuffer pool.
 *  As shareableArrays where shared memory is not available. */
export function sharedArrays(specs) {
  const c = bigArrayCaps()
  if (!c.shared || totalOf(specs) < LOCAL_MIN_BYTES) return shareableArrays(specs)
  return inWasm(specs, true, c.maxShareableBytes)
}

/** One typed array of `n` zeroed elements; see localArrays. */
export const localArray = (T, n, opts) => localArrays([[T, n]], opts)[0]
/** One typed array of `n` zeroed elements; see shareableArrays. */
export const shareableArray = (T, n, opts) => shareableArrays([[T, n]], opts)[0]
/** One typed array of `n` zeroed elements; see sharedArrays. */
export const sharedArray = (T, n) => sharedArrays([[T, n]])[0]

/** The largest single array `localArray` / `shareableArray` can make here, in bytes. */
export const maxLocalArrayBytes = () => bigArrayCaps().maxLocalBytes
export const maxShareableArrayBytes = () => bigArrayCaps().maxShareableBytes

const isShared = (buf) => typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer

/** True when `arr` lives in shared memory (posted without a copy, never transferred). */
export const isSharedArray = (arr) => !!arr && isShared(arr.buffer)

/** `arr`'s first `n` elements to post to a worker: a shared array as a view (no copy,
 *  nothing to transfer), anything else as a disposable copy the caller transfers, so
 *  ending the worker cannot detach the caller's own array. */
export const postableCopy = (arr, n = arr.length) => (isSharedArray(arr) ? arr.subarray(0, n) : arr.slice(0, n))

/** A postMessage transfer list from buffers, typed arrays, other transferables (ports,
 *  bitmaps) or nulls: views by their buffer, each item once. Shared buffers are left out
 *  (they cannot be transferred, and are shared anyway), and so are local arrays' wasm
 *  memories, which cannot be detached: those are copied. */
export function transferList(items) {
  const out = new Set()
  for (const x of items ?? []) {
    const b = ArrayBuffer.isView(x) ? x.buffer : x
    if (b && !isShared(b) && !wasmBuffers.has(b)) out.add(b)
  }
  return [...out]
}

/** `arr` (any typed array) as plain Uint8Array pieces of at most `chunkBytes`, for the
 *  APIs that refuse a shared or a very large view (Blob parts, file writes). A plain
 *  array no larger than one chunk is yielded as it is, uncopied. */
export function* chunksOf(arr, chunkBytes = 64 * 2 ** 20) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  if (!isSharedArray(arr) && bytes.byteLength <= chunkBytes) {
    yield bytes
    return
  }
  for (let off = 0; off < bytes.byteLength; off += chunkBytes) {
    yield bytes.slice(off, Math.min(bytes.byteLength, off + chunkBytes))
  }
}

/** `src` (an ArrayBuffer, SharedArrayBuffer or any typed array) viewed as `T`, without
 *  a copy. `new T(view)` would copy, and `new T(view.buffer)` would take a wasm-backed
 *  view's whole memory. */
export function viewAs(T, src) {
  if (src instanceof ArrayBuffer || isShared(src)) return new T(src)
  return new T(src.buffer, src.byteOffset, src.byteLength / T.BYTES_PER_ELEMENT)
}

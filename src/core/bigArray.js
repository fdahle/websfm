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

function wasmBacked(T, n, bytes, shared) {
  const pages = Math.max(1, Math.ceil(bytes / PAGE))
  let mem
  try {
    mem =
      pages > 65536
        ? new WebAssembly.Memory({ address: 'i64', initial: BigInt(pages), maximum: BigInt(pages), shared })
        : new WebAssembly.Memory({ initial: pages, maximum: pages, shared })
  } catch {
    throw refused(bytes)
  }
  if (mem.buffer.byteLength < bytes) throw refused(bytes) // `address` ignored: no Memory64
  return new T(mem.buffer, 0, n)
}

/** A typed array of `n` zeroed elements that stays in this worker; from LOCAL_MIN_BYTES
 *  it is wasm memory, outside the ArrayBuffer pool. */
export function localArray(T, n, { minBytes = LOCAL_MIN_BYTES } = {}) {
  const bytes = n * T.BYTES_PER_ELEMENT
  const c = bigArrayCaps()
  if (!c.wasm || bytes < minBytes) {
    if (bytes > MAX_BUFFER_BYTES) throw refused(bytes)
    return new T(n)
  }
  if (bytes > c.maxLocalBytes) throw refused(bytes)
  return wasmBacked(T, n, bytes, false)
}

/** A typed array of `n` zeroed elements that may be posted to the page or another
 *  worker: plain up to MAX_BUFFER_BYTES (as before), shared wasm memory past it. */
export function shareableArray(T, n, { maxPlainBytes = MAX_BUFFER_BYTES } = {}) {
  const bytes = n * T.BYTES_PER_ELEMENT
  if (bytes <= maxPlainBytes) return new T(n)
  const c = bigArrayCaps()
  if (!c.shared || bytes > c.maxShareableBytes) throw refused(bytes)
  return wasmBacked(T, n, bytes, true)
}

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
 *  bitmaps) or nulls: views by their buffer, shared buffers left out (they cannot be
 *  transferred, and are shared anyway), each item once. */
export function transferList(items) {
  const out = new Set()
  for (const x of items ?? []) {
    const b = ArrayBuffer.isView(x) ? x.buffer : x
    if (b && !isShared(b)) out.add(b)
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

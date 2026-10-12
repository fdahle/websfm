// Chunked export output. A writer here yields bounded PARTS (strings or
// Uint8Arrays) instead of one string or one buffer, and the caller folds them into
// a Blob (utils/blobParts.js `partsToBlob`). Two V8 limits make this load-bearing
// at dense scale: a string tops out at ~512 M chars (an ASCII PLY of ~10 M points),
// and every string lives on the ~4 GB isolate heap. A part is a few MB; the Blob
// holds the rest outside the heap. Pure: no Blob/DOM here.
//
// Parts never split a token, a line or a record, so concatenating them is
// byte-identical to the single-string/single-buffer writers they replaced.

export const PART_CHARS = 4 * 1024 * 1024 // text: chars ≈ bytes (the formats are ASCII)
export const PART_BYTES = 8 * 1024 * 1024 // binary

// Collects short strings; `add` reports when a part's worth is buffered, `take`
// returns it joined. Usage inside a generator: `if (buf.add(s)) yield buf.take()`.
export function textBuffer(limit = PART_CHARS) {
  let pieces = [], size = 0
  return {
    add(s) { pieces.push(s); size += s.length; return size >= limit },
    take() { const s = pieces.join(''); pieces = []; size = 0; return s },
    get size() { return size },
  }
}

// `head`, then `lineAt(i) + '\n'` for i < count; `emptyBody` when count is 0
// (several writers historically emitted a lone '\n' for an empty body —
// `lines.join('\n') + '\n'` — and the bytes must not change).
export function* lineParts(head, count, lineAt, { emptyBody = '', partChars = PART_CHARS } = {}) {
  const buf = textBuffer(partChars)
  if (buf.add(head)) yield buf.take()
  for (let i = 0; i < count; i++) if (buf.add(lineAt(i) + '\n')) yield buf.take()
  if (!count && emptyBody) buf.add(emptyBody)
  if (buf.size) yield buf.take()
}

// Fixed-stride binary records in whole-record chunks: `write(dv, offset, i, bytes)`
// fills record i at `offset` of the chunk.
export function* recordParts(count, stride, write, partBytes = PART_BYTES) {
  if (!count || !stride) return
  const per = Math.max(1, Math.floor(partBytes / stride))
  for (let start = 0; start < count; start += per) {
    const len = Math.min(per, count - start)
    const out = new Uint8Array(len * stride)
    const dv = new DataView(out.buffer)
    for (let k = 0; k < len; k++) write(dv, k * stride, start + k, out)
    yield out
  }
}

// A little-endian byte writer for variable-length records (COLMAP .bin). Values
// never straddle parts: a write that does not fit closes the current part.
export function chunkedByteWriter(partBytes = PART_BYTES) {
  const parts = []
  let buf = new Uint8Array(0), dv = new DataView(buf.buffer), len = 0
  const ensure = (extra) => {
    if (len + extra <= buf.length) return
    if (len) parts.push(buf.subarray(0, len))
    buf = new Uint8Array(Math.max(partBytes, extra)); dv = new DataView(buf.buffer); len = 0
  }
  return {
    u8(v) { ensure(1); dv.setUint8(len, v); len += 1 },
    i32(v) { ensure(4); dv.setInt32(len, v, true); len += 4 },
    u64(v) { ensure(8); dv.setBigUint64(len, BigInt(v), true); len += 8 },
    i64(v) { ensure(8); dv.setBigInt64(len, BigInt(v), true); len += 8 },
    f64(v) { ensure(8); dv.setFloat64(len, v, true); len += 8 },
    bytes(arr) { ensure(arr.length); buf.set(arr, len); len += arr.length },
    // The parts written so far plus the open one; the writer is finished after this.
    done() { if (len) parts.push(buf.subarray(0, len)); buf = new Uint8Array(0); len = 0; return parts },
  }
}

// Concatenate parts: a string when every part is one, else a Uint8Array (strings
// UTF-8 encoded). For small outputs and tests — an export goes through a Blob.
export function joinParts(parts) {
  const list = [...parts]
  if (list.every((p) => typeof p === 'string')) return list.join('')
  const enc = new TextEncoder()
  const bytes = list.map((p) => (typeof p === 'string' ? enc.encode(p) : p))
  const out = new Uint8Array(bytes.reduce((s, b) => s + b.length, 0))
  let o = 0
  for (const b of bytes) { out.set(b, o); o += b.length }
  return out
}

// ── Streaming JSON ───────────────────────────────────────────────────────────
// `jsonParts(v, { space })` yields exactly `JSON.stringify(v, null, space)` in
// bounded parts. A `lazyArray(length, at)` serializes as the array of `at(i)`, so
// an export whose size scales with points/keypoints/matches never materializes
// one object per item — each element exists only while it is written.

const LAZY = Symbol('lazyJsonArray')
export function lazyArray(length, at) { return { [LAZY]: true, length, at } }
export const isLazyArray = (v) => v != null && v[LAZY] === true

// A container of primitives this small goes to JSON.stringify whole (re-indented):
// the per-element walk is for the containers that scale.
const FLAT_LIMIT = 4096

const gapOf = (space) => (typeof space === 'number' ? ' '.repeat(Math.max(0, Math.min(10, Math.floor(space))))
  : typeof space === 'string' ? space.slice(0, 10) : '')

// `indent`: the value's nesting prefix, so a caller can write a container's elements
// one at a time (jsonArrayItemParts) and get the bytes the whole container would give.
export function* jsonParts(value, { space = 2, partChars = PART_CHARS, indent = '' } = {}) {
  const gap = gapOf(space)
  const buf = textBuffer(partChars)
  const open = new Set() // containers being written, for cycle detection
  const top = resolve(value, '', { '': value })
  if (!serializable(top)) return // JSON.stringify returns undefined
  yield* write(top, indent)
  if (buf.size) yield buf.take()

  function* write(v, indent) {
    if (v === null) { if (buf.add('null')) yield buf.take(); return }
    if (typeof v !== 'object') { if (buf.add(primitive(v))) yield buf.take(); return }
    const lazy = isLazyArray(v)
    const isArr = lazy || Array.isArray(v)
    const keys = isArr ? null : Object.keys(v)
    const n = isArr ? v.length : keys.length
    if (!lazy && n <= FLAT_LIMIT && isFlat(v, keys)) {
      const s = JSON.stringify(v, null, gap)
      if (buf.add(gap ? s.replace(/\n/g, `\n${indent}`) : s)) yield buf.take()
      return
    }
    if (open.has(v)) throw new TypeError('Converting circular structure to JSON')
    open.add(v)
    const inner = indent + gap
    const sep = gap ? `\n${inner}` : ''
    if (isArr) {
      if (!n) { if (buf.add('[]')) yield buf.take() } else {
        buf.add('[')
        for (let i = 0; i < n; i++) {
          if (buf.add(i ? `,${sep}` : sep)) yield buf.take()
          const el = resolve(lazy ? v.at(i) : v[i], String(i), v)
          if (serializable(el)) yield* write(el, inner)
          else if (buf.add('null')) yield buf.take()
        }
        if (buf.add(gap ? `\n${indent}]` : ']')) yield buf.take()
      }
    } else {
      buf.add('{')
      let first = true
      for (const k of keys) {
        const el = resolve(v[k], k, v)
        if (!serializable(el)) continue
        if (buf.add(`${first ? '' : ','}${sep}${JSON.stringify(k)}:${gap ? ' ' : ''}`)) yield buf.take()
        first = false
        yield* write(el, inner)
      }
      if (buf.add(first ? '}' : (gap ? `\n${indent}}` : '}'))) yield buf.take()
    }
    open.delete(v)
  }
}

// A top-level array written one element at a time, for elements whose data is read
// asynchronously in between (an image's keypoints, a pair's matches): element `index`
// with its separator, then `jsonArrayEnd(count)`. Concatenated, the parts are exactly
// `JSON.stringify(array, null, space)` — for elements JSON keeps (objects, here).
export function* jsonArrayItemParts(value, index, { space = 2, partChars = PART_CHARS } = {}) {
  const gap = gapOf(space)
  yield `${index ? ',' : '['}${gap ? `\n${gap}` : ''}`
  yield* jsonParts(value, { space, partChars, indent: gap })
}
export const jsonArrayEnd = (count, { space = 2 } = {}) => (count ? (gapOf(space) ? '\n]' : ']') : '[]')

// SerializeJSONProperty's value steps: toJSON, then unbox Number/String/Boolean.
function resolve(v, key) {
  if (v != null && (typeof v === 'object' || typeof v === 'bigint') && typeof v.toJSON === 'function') v = v.toJSON(key)
  if (v instanceof Number) return Number(v)
  if (v instanceof String) return String(v)
  if (v instanceof Boolean) return v.valueOf()
  return v
}
const serializable = (v) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol'
function primitive(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'bigint') throw new TypeError('Do not know how to serialize a BigInt')
  return 'null'
}
// Every child a primitive (or something JSON drops), and no toJSON on the container.
function isFlat(v, keys) {
  if (typeof v.toJSON === 'function') return false
  if (keys) { for (const k of keys) { const c = v[k]; if (c !== null && typeof c === 'object') return false } return true }
  for (let i = 0; i < v.length; i++) { const c = v[i]; if (c !== null && typeof c === 'object') return false }
  return true
}

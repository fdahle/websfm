// One octree node's points on disk (plan-lod ▸ L1). Pure.
//
// Layout, each section padded to 4 bytes:
//   positions  Int32 × 3n   round((p − offset) / scale): exact for LAS (its own scale
//                           and offset), sub-millimetre for a computed cloud
//   colour     Uint8 × 3n   when the cloud has colour
//   attributes one typed array per attribute, in the layout's order
// The point count lives in the hierarchy, not in the node.

const TYPES = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
}
const pad4 = (n) => (n + 3) & ~3

/** The attribute type name of a typed array (for the layout). */
export function typeName(arr) {
  for (const [name, T] of Object.entries(TYPES)) if (arr instanceof T) return name
  throw new Error(`unsupported attribute array ${arr?.constructor?.name}`)
}

/** Bytes of one node of `count` points under `layout`. */
export function nodeBytes(count, layout) {
  let b = pad4(12 * count)
  if (layout.colour) b += pad4(3 * count)
  for (const a of layout.attributes ?? []) b += pad4(TYPES[a.type].BYTES_PER_ELEMENT * count)
  return b
}

/**
 * Encode the points `idx` of a cloud { pos: Float64Array(3n) absolute or in any frame,
 * col?, attributes? } under layout { offset: [x,y,z], scale: [sx,sy,sz], colour,
 * attributes: [{ name, type }] }. → Uint8Array
 */
export function encodeNode(cloud, idx, layout) {
  const n = idx.length
  const out = new Uint8Array(nodeBytes(n, layout))
  const dv = new DataView(out.buffer)
  const [ox, oy, oz] = layout.offset,
    [sx, sy, sz] = layout.scale
  for (let k = 0; k < n; k++) {
    const i = idx[k],
      o = 12 * k
    dv.setInt32(o, Math.round((cloud.pos[3 * i] - ox) / sx), true)
    dv.setInt32(o + 4, Math.round((cloud.pos[3 * i + 1] - oy) / sy), true)
    dv.setInt32(o + 8, Math.round((cloud.pos[3 * i + 2] - oz) / sz), true)
  }
  let off = pad4(12 * n)
  if (layout.colour) {
    const col = cloud.col
    for (let k = 0; k < n; k++) {
      const i = idx[k]
      out[off + 3 * k] = col ? col[3 * i] : 0
      out[off + 3 * k + 1] = col ? col[3 * i + 1] : 0
      out[off + 3 * k + 2] = col ? col[3 * i + 2] : 0
    }
    off += pad4(3 * n)
  }
  for (const a of layout.attributes ?? []) {
    const T = TYPES[a.type],
      src = cloud.attributes?.[a.name]
    const dst = new T(out.buffer, off, n)
    if (src) for (let k = 0; k < n; k++) dst[k] = src[idx[k]]
    off += pad4(T.BYTES_PER_ELEMENT * n)
  }
  return out
}

/**
 * Decode a node. `as`: 'render' → positions Float32 relative to the layout's offset
 * (the viewer places the layer at the offset); 'absolute' → Float64 in the cloud's
 * frame. → { count, pos, col: Uint8Array | null, attributes: { name: TypedArray } }
 */
export function decodeNode(bytes, count, layout, { as = 'render' } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  // A fresh copy keeps every view aligned and independent of the source buffer.
  const buf = u8.slice().buffer
  const q = new Int32Array(buf, 0, 3 * count)
  const [ox, oy, oz] = layout.offset,
    [sx, sy, sz] = layout.scale
  const absolute = as === 'absolute'
  const pos = absolute ? new Float64Array(3 * count) : new Float32Array(3 * count)
  for (let k = 0; k < count; k++) {
    pos[3 * k] = q[3 * k] * sx + (absolute ? ox : 0)
    pos[3 * k + 1] = q[3 * k + 1] * sy + (absolute ? oy : 0)
    pos[3 * k + 2] = q[3 * k + 2] * sz + (absolute ? oz : 0)
  }
  let off = pad4(12 * count)
  let col = null
  if (layout.colour) {
    col = new Uint8Array(buf, off, 3 * count)
    off += pad4(3 * count)
  }
  const attributes = {}
  for (const a of layout.attributes ?? []) {
    const T = TYPES[a.type]
    attributes[a.name] = new T(buf, off, count)
    off += pad4(T.BYTES_PER_ELEMENT * count)
  }
  return { count, pos, col, attributes }
}

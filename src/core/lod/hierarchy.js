// The octree's hierarchy record (plan-lod ▸ L1). Pure.
//
// One 32-byte little-endian entry per node, parents before children:
//   level, x, y, z   Uint8 + 3 × Uint32 (packed after 3 pad bytes)
//   count            Uint32  points in the node (0: an empty interior node)
//   offset           Float64 byte offset in the cloud's data file (files pass 4 GB)
//   length           Uint32  bytes
// Read back as a Map keyString → { key, count, offset, length }.

import { keyString, childKey } from './octree.js'

const ENTRY = 32

/** nodes [{ key, count, offset, length }] → Uint8Array */
export function encodeHierarchy(nodes) {
  const out = new Uint8Array(ENTRY * nodes.length)
  const dv = new DataView(out.buffer)
  nodes.forEach(({ key, count, offset, length }, k) => {
    const o = ENTRY * k
    dv.setUint8(o, key[0])
    dv.setUint32(o + 4, key[1], true)
    dv.setUint32(o + 8, key[2], true)
    dv.setUint32(o + 12, key[3], true)
    dv.setUint32(o + 16, count, true)
    dv.setFloat64(o + 20, offset, true)
    dv.setUint32(o + 28, length, true)
  })
  return out
}

/** Uint8Array → Map keyString → { key, count, offset, length } (in file order) */
export function decodeHierarchy(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const nodes = new Map()
  for (let o = 0; o + ENTRY <= u8.byteLength; o += ENTRY) {
    const key = [dv.getUint8(o), dv.getUint32(o + 4, true), dv.getUint32(o + 8, true), dv.getUint32(o + 12, true)]
    nodes.set(keyString(key), {
      key,
      count: dv.getUint32(o + 16, true),
      offset: dv.getFloat64(o + 20, true),
      length: dv.getUint32(o + 28, true),
    })
  }
  return nodes
}

/** The children of `key` present in a decoded hierarchy. */
export function childrenOf(nodes, key) {
  const out = []
  for (let o = 0; o < 8; o++) {
    const c = nodes.get(keyString(childKey(key, o)))
    if (c) out.push(c)
  }
  return out
}

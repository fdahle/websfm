// COPC node reads for the 3D view (core/lod/copc.js): a node is one LASzip chunk, and
// decoding it is too slow for the main thread at a view's pace (tens of ms per node).
// Its own worker, not the compute pool: a long job there (an edit, a DEM) would hold
// the view's nodes behind it.
//   in:  { id, data: File, node: { offset, length, count }, lod (copc, layout), as }
//   out: { id, ok: true, result: { count, pos, col, attributes } } (buffers transferred)

import init, { LazDecoder } from '../wasm/lazcodec/lazcodec.js'
import { decodeCopcRecords } from '../core/lod/copc.js'

let ready = null
// The file's LASzip VLR (base64) → decoder, the most recently used last. A decoder holds
// WASM memory, and the view may open many COPC files in a session: only the last few
// are kept, an older one is freed.
const decoders = new Map()
const MAX_DECODERS = 4

self.onmessage = async (e) => {
  const { id, data, node, lod, as } = e.data
  try {
    await (ready ??= init())
    let d = decoders.get(lod.copc.lazVlr)
    if (d) decoders.delete(lod.copc.lazVlr)
    else d = LazDecoder.forChunks(Uint8Array.from(atob(lod.copc.lazVlr), (c) => c.charCodeAt(0)))
    decoders.set(lod.copc.lazVlr, d)
    while (decoders.size > MAX_DECODERS) {
      const [oldest, dec] = decoders.entries().next().value
      decoders.delete(oldest)
      dec.free?.()
    }
    const bytes = new Uint8Array(await data.slice(node.offset, node.offset + node.length).arrayBuffer())
    const pts = decodeCopcRecords(d.decode_chunk(bytes, node.count), node.count, lod, { as })
    const transfer = [
      pts.pos.buffer,
      ...(pts.col ? [pts.col.buffer] : []),
      ...new Set(Object.values(pts.attributes).map((a) => a.buffer)),
    ]
    self.postMessage({ id, ok: true, result: pts }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) })
  }
}

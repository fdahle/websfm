// COPC node reads for the 3D view (core/lod/copc.js): a node is one LASzip chunk, and
// decoding it is too slow for the main thread at a view's pace (tens of ms per node).
// Its own worker, not the compute pool: a long job there (an edit, a DEM) would hold
// the view's nodes behind it.
//   in:  { id, data: File, node: { offset, length, count }, lod (copc, layout), as }
//   out: { id, ok: true, result: { count, pos, col, attributes } } (buffers transferred)

import init, { LazDecoder } from '../wasm/lazcodec/lazcodec.js'
import { decodeCopcRecords } from '../core/lod/copc.js'

let ready = null
const decoders = new Map() // the file's LASzip VLR (base64) → decoder

self.onmessage = async (e) => {
  const { id, data, node, lod, as } = e.data
  try {
    await (ready ??= init())
    let d = decoders.get(lod.copc.lazVlr)
    if (!d) {
      d = LazDecoder.forChunks(Uint8Array.from(atob(lod.copc.lazVlr), (c) => c.charCodeAt(0)))
      decoders.set(lod.copc.lazVlr, d)
    }
    const bytes = new Uint8Array(await data.slice(node.offset, node.offset + node.length).arrayBuffer())
    const pts = decodeCopcRecords(d.decode_chunk(bytes, node.count), node.count, lod, { as })
    const transfer = [pts.pos.buffer, ...(pts.col ? [pts.col.buffer] : []), ...new Set(Object.values(pts.attributes).map((a) => a.buffer))]
    self.postMessage({ id, ok: true, result: pts }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) })
  }
}

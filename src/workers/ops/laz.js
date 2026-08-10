import init, { compress_points, decompress_points } from '../../wasm/lazcodec/lazcodec.js'
import { cloudToLaz } from '../../core/io/laz.js'

// LAZ codec ownership (lazy wasm init, like workers/ops/mesh.js gates the mesh
// module). Two consumers share one instance: the export op below and the cloud
// *import* op in workers/ops/io.js, which needs the decompressor injected into
// core/io/cloudImport.js.
//
// LAZ runs off the main thread for the same reason LAS parsing does — a 30 M-point
// cloud is ~780 MB of point records, and the arithmetic coder is not fast.
export function makeLazCodec() {
  let initPromise = null
  const ensure = () => (initPromise ??= init())

  // Matches core/io/laz.js's injected-codec contract exactly, so the pure module
  // never learns that a wasm boundary exists.
  //   compress:   (pointBytes, format, size) → { vlr, data }
  //   decompress: (vlrData, compressed, count, size) → Uint8Array
  const compress = (pointBytes, format, size) => {
    const packed = compress_points(pointBytes, format, size)
    // `vlr` is a getter and `data()` consumes the handle — read the VLR first or
    // it is gone.
    const vlr = packed.vlr
    return { vlr, data: packed.data() }
  }
  const decompress = (vlrData, compressed, count, size) =>
    decompress_points(vlrData, compressed, count, size)

  return { ensure, compress, decompress }
}

export function makeLazOps(codec) {
  // args: [{ cloud: { count, pos, col? }, crsCode, geographic }]
  // → { bytes } (transferred). The cloud buffers are transferred IN by the caller
  // and round-tripped home under `home`, the same convention densify/mesh use, so
  // a store's cloud is never left detached by an export.
  async function exportLaz([{ cloud, crsCode = null, geographic = false }], { emit }) {
    await codec.ensure()
    const log = (m, l = 'info') => emit('log', [m, l, 'Export'])
    const bytes = cloudToLaz(cloud, {
      crsCode, geographic, compress: codec.compress, onLog: (m, l) => log(m, l),
    })
    const transfer = [bytes.buffer, cloud.pos.buffer]
    if (cloud.col) transfer.push(cloud.col.buffer)
    return { result: { bytes, home: cloud }, transfer }
  }

  return { exportLaz }
}

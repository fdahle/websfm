import init, { compress_points, decompress_points, LazEncoder } from '../../wasm/lazcodec/lazcodec.js'

// LAZ codec ownership (lazy wasm init, like workers/ops/mesh.js gates the mesh
// module). Two consumers share one instance: the cloud export op
// (workers/ops/export.js) and the cloud *import* op in workers/ops/io.js, which
// need the codec injected into core/io/laz.js.
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

  const createCompressor = (format, size) => {
    const encoder = new LazEncoder(format, size)
    return {
      push: bytes => encoder.push(bytes),
      finish: () => {
        const packed = encoder.finish()
        const vlr = packed.vlr
        return { vlr, data: packed.data() }
      },
      free: () => encoder.free(),
    }
  }
  return { ensure, compress, decompress, createCompressor }
}

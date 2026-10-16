import init, { compress_points, decompress_points, LazEncoder, LazDecoder } from '../../wasm/lazcodec/lazcodec.js'

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
      // Compressed bytes so far, past the first 8 (finish() returns those 8 + the rest):
      // a long export hands its output over as it goes instead of holding it all.
      drain: () => encoder.drain(),
      finish: () => {
        const packed = encoder.finish()
        const vlr = packed.vlr
        return { vlr, data: packed.data() }
      },
      free: () => encoder.free(),
    }
  }
  // The streaming decoder's contract (core/io/lasStream.js): a run of chunks per call.
  const createDecoder = (vlrData, chunkTable) => {
    const d = new LazDecoder(vlrData, chunkTable)
    return {
      chunkCount: () => d.chunk_count(), chunkPoints: (i) => d.chunk_points(i), chunkBytes: (i) => d.chunk_bytes(i),
      pointSize: () => d.point_size(), decode: (bytes, first, count, n) => d.decode(bytes, first, count, n),
      free: () => d.free(),
    }
  }
  return { ensure, compress, decompress, createCompressor, createDecoder }
}

import init, { decode_tiff } from '../../wasm/imagecodec/imagecodec.js'
import { tiffToDisplayBlob } from '../../utils/tiff.js'

// TIFF transcode (decode + JPEG/PNG re-encode) runs here so a batch of large
// TIFFs decodes across the worker pool instead of blocking the main thread;
// `tiffToDisplayBlob` has no DOM dependency (OffscreenCanvas works in a worker
// too), so it's reused unchanged.
//
// Decode is ~87% of ingest time on 97 MP aerial scans (pure-JS geotiff), so we
// inject a native (Rust/WASM) `tiff`-crate decoder that returns interleaved
// 8-bit RGBA directly. Owns its wasm module (lazy init, like the mesh op). On
// any wasm decode failure (exotic/JPEG-in-TIFF/float variants), `tiffToDisplayBlob`
// falls back to geotiff.js — so no input regresses. See TODO ▸ TC.
export function makeTiffOps() {
  let initPromise = null
  const ensureWasm = () => (initPromise ??= init())

  // Native decode: read the blob bytes, decode to RGBA in wasm, hand the buffer
  // back. Reads `width`/`height` before `rgba()` (which consumes the wasm handle
  // and moves the ~390 MB buffer out without a copy).
  async function decodeNative(blob) {
    await ensureWasm()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const decoded = decode_tiff(bytes) // throws on unsupported variants → geotiff fallback
    const width = decoded.width
    const height = decoded.height
    // Source shape + the 16-bit percentile stretch (−1 for an 8-bit source).
    const bitsPerSample = decoded.bitsPerSample
    const samplesPerPixel = decoded.samplesPerPixel
    const stretch = decoded.stretchLo >= 0 ? { lo: decoded.stretchLo, hi: decoded.stretchHi } : null
    const rgba = decoded.rgba() // consumes `decoded` — read every getter before this
    return { width, height, rgba, bitsPerSample, samplesPerPixel, stretch }
  }

  async function transcodeTiff([blob, jpegQuality], { emit } = {}) {
    const { displayBlob, computeBlob, width, height, timings, srcInfo } = await tiffToDisplayBlob(blob, {
      jpegQuality,
      decoder: decodeNative,
      onThumbnail: emit ? (thumbBlob, tw, th) => emit('thumbnail', [thumbBlob, tw, th]) : undefined,
      // Stream the full-res display JPEG as soon as it's encoded, before the
      // slower compute PNG — lets the main thread make the viewer fully usable
      // while the PNG (returned in the final result) is still encoding.
      onDisplay: emit ? (dispBlob) => emit('display', [dispBlob]) : undefined,
    })
    return { result: { displayBlob, computeBlob, width, height, timings, srcInfo } }
  }
  return { transcodeTiff }
}

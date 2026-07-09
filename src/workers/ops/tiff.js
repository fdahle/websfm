import { tiffToDisplayBlob } from '../../utils/tiff.js'

// TIFF transcode (geotiff decode + JPEG/PNG re-encode) runs here so a batch of
// large TIFFs decodes across the worker pool instead of blocking the main
// thread; `tiffToDisplayBlob` has no DOM dependency (OffscreenCanvas works in
// a worker too), so it's reused unchanged.
export function makeTiffOps() {
  async function transcodeTiff([blob, jpegQuality], { emit } = {}) {
    const { displayBlob, computeBlob, width, height } = await tiffToDisplayBlob(blob, {
      jpegQuality,
      onThumbnail: emit ? (thumbBlob, tw, th) => emit('thumbnail', [thumbBlob, tw, th]) : undefined,
      // Stream the full-res display JPEG as soon as it's encoded, before the
      // slower compute PNG — lets the main thread make the viewer fully usable
      // while the PNG (returned in the final result) is still encoding.
      onDisplay: emit ? (dispBlob) => emit('display', [dispBlob]) : undefined,
    })
    return { result: { displayBlob, computeBlob, width, height } }
  }
  return { transcodeTiff }
}

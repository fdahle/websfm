// Compute worker: runs the heavy wasm (SIFT detection, descriptor matching,
// geometric verification) off the main thread so the UI stays responsive while
// a batch runs. Driven by computeClient.js via a tiny request/response protocol:
//   in:  { id, op, args }
//   out: { id, ok: true, result } | { id, ok: false, error }
// ArrayBuffers in the result are transferred (see each op's `transfer`).
//
// The op handlers live in ./ops/<domain>.js, each a factory returning
// { opName: handler }; this file keeps the OffscreenCanvas pixel decoder
// (rasterize, injected into the detect + dense ops), the message loop, and the
// merged op registry. Matching reuses the pure (DOM-free) core modules unchanged;
// SIFT needs pixel rasterisation, which on a worker uses OffscreenCanvas +
// createImageBitmap instead of the DOM <canvas>/<img> path — hence rasterize here.

import { makeDetectOps } from './ops/detect.js'
import { makeMatchOps } from './ops/match.js'
import { makeSfmOps } from './ops/sfm.js'
import { makeDenseOps } from './ops/dense.js'
import { makeProductsOps } from './ops/products.js'
import { makeMeshOps } from './ops/mesh.js'
import { makeCloudOps } from './ops/cloud.js'
import { makeTiffOps } from './ops/tiff.js'
import { makeSegmentOps } from './ops/segment.js'
import { makeIoOps } from './ops/io.js'

// Decode an image URL (blob: URLs work in a worker) and draw it into an
// OffscreenCanvas, downscaled so the longest side is ≤ maxDim. Returns RGBA
// pixels, the working dimensions, the scale back to the original, and the
// original (natural) dimensions.
async function rasterize(url, maxDim) {
  const blob = await (await fetch(url)).blob()
  const bmp = await createImageBitmap(blob)
  const natW = bmp.width, natH = bmp.height
  const scale = Math.min(1, maxDim / Math.max(natW, natH))
  const width = Math.round(natW * scale)
  const height = Math.round(natH * scale)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  bmp.close()
  return { data, width, height, scale, natW, natH }
}

// Merge every domain's op registry. rasterize is the only worker-local helper the
// ops need; the rest of each domain's helpers live in its own module.
const ops = {
  ...makeDetectOps({ rasterize }),
  ...makeMatchOps(),
  ...makeSfmOps(),
  ...makeDenseOps({ rasterize }),
  ...makeProductsOps(),
  ...makeMeshOps(),
  ...makeCloudOps(),
  ...makeTiffOps(),
  ...makeSegmentOps({ rasterize }),
  ...makeIoOps(),
}

self.onmessage = async (e) => {
  const { id, op, args } = e.data
  const handler = ops[op]
  if (!handler) {
    self.postMessage({ id, ok: false, error: `Unknown op: ${op}` })
    return
  }
  // Intermediate events for streaming ops, tagged with the request id.
  const emit = (ev, evArgs) => self.postMessage({ id, ev, args: evArgs })
  try {
    const { result, transfer } = await handler(args, { emit })
    self.postMessage({ id, ok: true, result }, transfer ?? [])
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) })
  }
}

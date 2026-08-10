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
import { makeUndistortOps } from './ops/undistort.js'
import { makeLazCodec, makeLazOps } from './ops/laz.js'

// Decode an image URL (blob: URLs work in a worker) and draw it into an
// OffscreenCanvas, downscaled so the longest side is ≤ maxDim. Returns RGBA
// pixels, the working dimensions, the scale back to the original, and the
// original (natural) dimensions.
// A bare "Failed to fetch" names neither the URL nor the stage it died in, and
// the three plausible causes — a revoked/foreign blob: URL, a blocked request,
// an undecodable payload — are indistinguishable in that message. Keep the URL
// (blob:/http: are short; a data: URL is truncated) attached to every failure.
function describeUrl(url) {
  if (typeof url !== 'string') return String(url)
  return url.length > 120 ? `${url.slice(0, 120)}… (${url.length} chars)` : url
}

async function rasterize(url, maxDim) {
  let resp
  try {
    resp = await fetch(url)
  } catch (err) {
    throw new Error(`rasterize: fetch failed for ${describeUrl(url)} — ${err?.message ?? err}`)
  }
  if (!resp.ok) throw new Error(`rasterize: HTTP ${resp.status} for ${describeUrl(url)}`)
  const blob = await resp.blob()
  let bmp
  try {
    bmp = await createImageBitmap(blob)
  } catch (err) {
    throw new Error(`rasterize: decode failed for ${describeUrl(url)} `
      + `(${blob.type || 'no content-type'}, ${blob.size} B) — ${err?.message ?? err}`)
  }
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
// One LAZ codec instance, shared by the import parser and the export op.
const lazCodec = makeLazCodec()

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
  ...makeIoOps({ lazCodec }),
  ...makeLazOps(lazCodec),
  ...makeUndistortOps({ rasterize }),
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

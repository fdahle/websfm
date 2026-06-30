// Compute worker: runs the heavy wasm (SIFT detection, descriptor matching,
// geometric verification) off the main thread so the UI stays responsive while
// a batch runs. Driven by computeClient.js via a tiny request/response protocol:
//   in:  { id, op, args }
//   out: { id, ok: true, result } | { id, ok: false, error }
// ArrayBuffers in the result are transferred (see each op's `transfer`).
//
// Matching reuses the pure (DOM-free) core module unchanged. SIFT needs pixel
// rasterisation, which on a worker uses OffscreenCanvas + createImageBitmap
// instead of the DOM <canvas>/<img> path — hence its own implementation here.

import initSift, { detect_sift } from '../wasm/detection/sift.js'
import { matchDescriptors, verifyMatches } from '../core/matching.js'
import { reconstruct as sfmReconstruct } from '../core/sfm.js'
import {
  selectSourceViews, scaleK, rgbaToGray, depthMapForImage, fuseDepthMaps,
} from '../core/mvs.js'
import { buildMaskLookup } from '../core/mask.js'

// Must match STRIDE in crates/sift/src/lib.rs: [x, y, scale, response, angle, d0..d127]
const STRIDE = 133
const DESC_LEN = 128

let siftReady = null
const ensureSift = () => (siftReady ??= initSift())

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

// Mirrors utils/detection.js's detectKeypoints, but worker-side. Keypoint coords
// map back to original-image pixels; descriptors are returned as a transferable
// Float32Array (N×128, row-major).
async function detect([url, options = {}]) {
  const { maxDim = 1200, contrastThreshold = 0.01, maxKeypoints = 5000, mask = null } = options
  await ensureSift()
  const { data, width, height, scale, natW, natH } = await rasterize(url, maxDim)

  // Masked regions are excluded: keypoints landing on a masked pixel are dropped.
  const maskLut = mask ? await buildMaskLookup(mask, width, height) : null

  const t0 = performance.now()
  const flat = detect_sift(new Uint8Array(data.buffer), width, height, contrastThreshold, maxKeypoints)
  const ms = performance.now() - t0

  const n = Math.floor(flat.length / STRIDE)
  const keypoints = []
  // Upper bound; the descriptor buffer is trimmed to the kept count below.
  const descBuf = new Float32Array(n * DESC_LEN)
  let kept = 0
  for (let i = 0; i < n; i++) {
    const base = i * STRIDE
    const dx = flat[base], dy = flat[base + 1]
    // Sample the source RGB at the keypoint (detect-space pixel) so the sparse
    // cloud can be coloured later. Clamp to the raster bounds; single-pixel
    // nearest sample is plenty for per-track median aggregation.
    const px = Math.min(width - 1, Math.max(0, Math.round(dx)))
    const py = Math.min(height - 1, Math.max(0, Math.round(dy)))
    if (maskLut && maskLut[py * width + px]) continue
    const o = (py * width + px) * 4
    keypoints.push({
      x: dx / scale, y: dy / scale,
      nx: dx / width, ny: dy / height,
      scale: flat[base + 2] / scale, response: flat[base + 3],
      color: [data[o], data[o + 1], data[o + 2]],
    })
    descBuf.set(flat.subarray(base + 5, base + 5 + DESC_LEN), kept * DESC_LEN)
    kept++
  }
  // Trim to the kept keypoints (copy so the transferred buffer is exactly sized).
  const descriptors = kept === n ? descBuf : descBuf.slice(0, kept * DESC_LEN)

  return {
    result: { keypoints, descriptors, width: natW, height: natH, detectWidth: width, detectHeight: height, ms },
    transfer: [descriptors.buffer],
  }
}

async function match([descA, descB, options = {}]) {
  return { result: await matchDescriptors(descA, descB, options) }
}

async function verify([kpsA, kpsB, matches, options = {}]) {
  const res = await verifyMatches(kpsA, kpsB, matches, options)
  if (!res) return { result: null }
  // res.inlierMask is a fresh Float32Array → transfer it back.
  return { result: res, transfer: [res.inlierMask.buffer] }
}

// Long-running incremental SfM. Streams the algorithm's log + progress back to
// the main thread as intermediate `ev` messages (see emit), then returns the
// final model.
async function reconstruct([input], { emit }) {
  const result = await sfmReconstruct(input, {
    onLog: (message, level, category) => emit('log', [message, level, category]),
    onProgress: (done, total, label) => emit('progress', [done, total, label]),
  })
  return { result }
}

// Extract a tightly-packed RGB buffer (drop alpha) from RGBA pixels.
function rgbFromRgba(data, w, h) {
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgb[i*3] = data[i*4]; rgb[i*3+1] = data[i*4+1]; rgb[i*3+2] = data[i*4+2]
  }
  return rgb
}

// Render a depth plane to a grayscale PNG data URL for the image viewer's depth
// overlay. Valid depths are normalised to 0..255 (near = bright); holes are black.
async function depthToDataUrl(depth, w, h) {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i]
    if (d > 0) { if (d < lo) lo = d; if (d > hi) hi = d }
  }
  const span = hi > lo ? hi - lo : 1
  const img = new ImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const d = depth[i]
    const g = d > 0 ? 255 - Math.round(((d - lo) / span) * 255) : 0
    const o = i * 4
    img.data[o] = g; img.data[o+1] = g; img.data[o+2] = g; img.data[o+3] = 255
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').putImageData(img, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
}

// Stage A — Build Depth Maps. Rasterises each registered image (and its source
// neighbours), runs PatchMatch MVS, and returns one depth map per reference image
// (raw depth/cost planes + colours for fusion, plus a display PNG). Pure compute
// lives in core/mvs.js; pixel decoding is worker-only (OffscreenCanvas).
async function computeDepthMaps([input], { emit }) {
  const { images, points, settings = {} } = input
  const { maxDim = 800, maxSources = 6, minAngleDeg = 3, window = 2, iterations = 3, bestK = 3 } = settings

  const cameras = new Map(images.map((im) => [im.uuid, { R: im.R, t: im.t, K: im.K }]))
  const rasterCache = new Map() // url → { data, width, height, scale }
  const getRaster = async (url) => {
    if (!rasterCache.has(url)) rasterCache.set(url, await rasterize(url, maxDim))
    return rasterCache.get(url)
  }

  const maps = []
  const transfer = []
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    emit('progress', [i, images.length, img.name])

    const srcUuids = selectSourceViews(cameras, points, img.uuid, { maxSources, minAngleDeg })
    if (srcUuids.length === 0) {
      emit('log', [`Depth maps: ${img.name} skipped (no overlapping views)`, 'warn', 'Dense'])
      continue
    }

    const rRef = await getRaster(img.url)
    const ref = {
      gray: rgbaToGray(rRef.data, rRef.width, rRef.height),
      width: rRef.width, height: rRef.height,
      K: scaleK(img.K, rRef.scale),
      cam: { R: img.R, t: img.t },
    }
    const sources = []
    for (const u of srcUuids) {
      const s = images.find((im) => im.uuid === u)
      const rs = await getRaster(s.url)
      sources.push({
        gray: rgbaToGray(rs.data, rs.width, rs.height),
        w: rs.width, h: rs.height,
        K: scaleK(s.K, rs.scale),
        cam: { R: s.R, t: s.t },
      })
    }

    const dm = await depthMapForImage(ref, sources, points, { window, iterations, bestK })
    if (!dm) {
      emit('log', [`Depth maps: ${img.name} skipped (no sparse depth support)`, 'warn', 'Dense'])
      continue
    }
    // Drop masked regions from the dense cloud: zero the depth there so fusion
    // (which treats depth <= 0 as "no data") skips those pixels.
    if (img.mask) {
      const maskLut = await buildMaskLookup(img.mask, dm.width, dm.height)
      for (let k = 0; k < dm.depth.length; k++) if (maskLut[k]) dm.depth[k] = 0
    }
    const rgb = rgbFromRgba(rRef.data, rRef.width, rRef.height)
    const displayDataUrl = await depthToDataUrl(dm.depth, dm.width, dm.height)
    let valid = 0
    for (let k = 0; k < dm.depth.length; k++) if (dm.depth[k] > 0) valid++
    emit('log', [`Depth maps: ${img.name} — ${srcUuids.length} sources, `
      + `${(100 * valid / dm.depth.length).toFixed(0)}% pixels with depth`, 'info', 'Dense'])

    maps.push({
      uuid: img.uuid, width: dm.width, height: dm.height,
      K: ref.K, R: img.R, t: img.t,
      depth: dm.depth, cost: dm.cost, rgb, displayDataUrl,
    })
    transfer.push(dm.depth.buffer, dm.cost.buffer, rgb.buffer)
  }

  emit('progress', [images.length, images.length, 'Done'])
  return { result: { maps }, transfer }
}

// Stage B — Build Point Cloud (dense). Fuses the depth maps from Stage A into a
// single coloured point cloud (pure compute in core/mvs.js).
async function densify([input], { emit }) {
  const { maps, settings = {} } = input
  emit('progress', [0, 1, 'Fusing depth maps…'])
  const points = fuseDepthMaps(maps, settings)
  emit('log', [`Dense cloud: fused ${maps.length} depth maps → ${points.length} points`, 'success', 'Dense'])
  emit('progress', [1, 1, 'Done'])
  // Pack points into a transferable flat buffer: [x,y,z,r,g,b] per point.
  const flat = new Float32Array(points.length * 6)
  points.forEach((p, i) => {
    flat.set([p.x, p.y, p.z, p.color[0], p.color[1], p.color[2]], i * 6)
  })
  return { result: { points: flat }, transfer: [flat.buffer] }
}

const ops = { detect, match, verify, reconstruct, computeDepthMaps, densify }

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

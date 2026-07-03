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
  selectSourceViews, scaleK, rgbaToGray, depthMapForImage, fuseDepthMaps, filterDepthMap, autoBestK,
} from '../core/mvs.js'
import { buildMaskLookup } from '../core/mask.js'
import { depthColor } from '../core/colormap.js'
import { buildLocalFrame, makeFrame } from '../core/projection.js'
import { frameFromSimilarity } from '../core/georef.js'
import { rasterizeDem } from '../core/dem.js'
import { orthorectify } from '../core/ortho.js'
import { isGpuAvailable, ensureDevice } from './gpu/device.js'
import { computeDepthMapGPU } from './gpu/depthMapGpu.js'
import {
  createMemLedger, projectDensePeakBytes, formatBytes, DEFAULT_BUDGET_BYTES,
} from '../core/memBudget.js'

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

  // Layout: STRIDE floats per kept keypoint, then a single trailing raw-count
  // (total detected before the max_keypoints cap). Empty (degenerate input) ⇒ 0.
  const rawFound = flat.length > 0 ? flat[flat.length - 1] : 0
  const n = flat.length > 0 ? Math.floor((flat.length - 1) / STRIDE) : 0
  // Smallest kept response = last entry (the crate returns them response-desc);
  // the point at which the max_keypoints cap started discarding features.
  const minResponse = n > 0 ? flat[(n - 1) * STRIDE + 3] : 0
  const keypoints = []
  const responses = []
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
    responses.push(flat[base + 3])
    descBuf.set(flat.subarray(base + 5, base + 5 + DESC_LEN), kept * DESC_LEN)
    kept++
  }
  // Trim to the kept keypoints (copy so the transferred buffer is exactly sized).
  const descriptors = kept === n ? descBuf : descBuf.slice(0, kept * DESC_LEN)

  // Diagnostics for the detailed (debug) log: what the run actually did.
  responses.sort((a, b) => a - b)
  const at = (q) => (responses.length ? responses[Math.min(responses.length - 1, Math.round(q * (responses.length - 1)))] : 0)
  const diag = {
    detectWidth: width, detectHeight: height, natW, natH, scale,
    rawFound, capped: n, kept, maskedDropped: n - kept,
    capHit: maxKeypoints > 0 && rawFound > maxKeypoints, minResponse,
    respP50: at(0.5), respP95: at(0.95),
  }

  return {
    result: { keypoints, descriptors, width: natW, height: natH, detectWidth: width, detectHeight: height, ms, diag },
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

// Render a depth plane to a colourized PNG data URL for the image viewer's depth
// overlay. Valid depths are normalised to a blue→red ramp (near = red); holes
// are transparent so the underlying image shows through.
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
    const o = i * 4
    if (d > 0) {
      // Near = warm (t→1), far = cool (t→0).
      const t = 1 - (d - lo) / span
      const [r, g, b] = depthColor(t)
      img.data[o] = r; img.data[o+1] = g; img.data[o+2] = b; img.data[o+3] = 255
    } else {
      img.data[o] = 0; img.data[o+1] = 0; img.data[o+2] = 0; img.data[o+3] = 0
    }
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
  const {
    maxDim = 800, maxSources = 6, minAngleDeg = 3, window = 3, iterations = 3, bestK = null,
    speckleFilter = true, filterRadius = 1, filterRelTol = 0.1,
  } = settings
  // Auto best-K per image (Step 3) when the user hasn't overridden it: derive from
  // that image's source count (clamp(ceil(nSources/2),1,4)) rather than a fixed 3.
  const autoBestKMode = !(bestK > 0)

  // Median / p95 of an array (for cost distributions). Mutates a copy.
  const stat = (arr) => {
    if (!arr.length) return { median: 0, p95: 0 }
    const s = [...arr].sort((a, b) => a - b)
    const at = (q) => s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]
    return { median: at(0.5), p95: at(0.95) }
  }

  const t0 = performance.now()
  emit('log', [`Depth maps: ${images.length} image(s) — working ≤${maxDim}px, `
    + `≤${maxSources} sources (best-${autoBestKMode ? 'auto' : bestK}), window ${window} (${2 * window + 1}×${2 * window + 1}), `
    + `${iterations} PatchMatch iters`, 'info', 'Dense'])

  // Backend selection: opt into the (experimental) WebGPU path with settings.useGpu;
  // anything that prevents it (no WebGPU, no adapter) silently keeps the WASM path.
  // `backend = undefined` ⇒ depthMapForImage uses its WASM default.
  let backend
  if (settings.useGpu && isGpuAvailable()) {
    const state = await ensureDevice()
    if (state) {
      backend = computeDepthMapGPU
      const id = [...new Set([state.info?.vendor, state.info?.architecture || state.info?.description]
        .filter(Boolean))].join(' ')
      emit('log', [`Depth maps: backend = WebGPU${id ? ` (${id})` : ''}`
        + `${state.isFallback ? ' [software adapter]' : ''} — multi-source PatchMatch (experimental)`,
        'warn', 'Dense'])
    } else {
      emit('log', ['Depth maps: GPU requested but no adapter — using WASM (CPU)', 'warn', 'Dense'])
    }
  }
  if (!backend) emit('log', ['Depth maps: backend = WASM (CPU)', 'info', 'Dense'])

  const cameras = new Map(images.map((im) => [im.uuid, { R: im.R, t: im.t, K: im.K }]))

  // Pre-flight memory budget (Step 5): project the peak allocation and refuse to
  // start when it exceeds the budget, rather than letting the browser OOM-kill the
  // tab mid-run (Safari can't be observed or intercepted). Working dims use the
  // maxDim² upper bound; source count uses maxSources.
  const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
  const proj = projectDensePeakBytes({
    nImages: images.length, maxDim, nSources: maxSources, backend: backend ? 'gpu' : 'wasm',
  })
  emit('log', [`Dense: projected peak memory ≈ ${formatBytes(proj.total)} `
    + `(store ${formatBytes(proj.store)} + raster ${formatBytes(proj.raster)}`
    + `${proj.gpu ? ` + GPU ${formatBytes(proj.gpu)}` : ''}) vs budget ${formatBytes(budget)}`,
    proj.total > budget ? 'error' : 'info', 'Dense'])
  if (proj.total > budget) {
    emit('log', ['Dense: aborting before start — projected memory exceeds the budget. '
      + 'Lower Quality (e.g. Medium) or raise the memory budget, then retry.', 'error', 'Dense'])
    throw new Error(`dense pre-flight: projected ${formatBytes(proj.total)} exceeds budget ${formatBytes(budget)}`)
  }

  // Precompute each image's source views once (also drives the raster refcounts),
  // so the cache can evict a raster the moment it's no longer needed — keeping the
  // resident working set small instead of holding every image's pixels at once.
  const srcUuidsByImg = images.map((img) =>
    selectSourceViews(cameras, points, img.uuid, { maxSources, minAngleDeg }))
  const urlByUuid = new Map(images.map((im) => [im.uuid, im.url]))
  const usedSets = srcUuidsByImg.map((srcUuids, i) => {
    const set = new Set([images[i].url])
    for (const u of srcUuids) { const url = urlByUuid.get(u); if (url) set.add(url) }
    return set
  })
  const useCount = new Map()
  for (const set of usedSets) for (const url of set) useCount.set(url, (useCount.get(url) || 0) + 1)

  const ledger = createMemLedger()
  const rasterCache = new Map() // url → { data, width, height, scale }
  const getRaster = async (url) => {
    if (!rasterCache.has(url)) {
      const r = await rasterize(url, maxDim)
      rasterCache.set(url, r)
      ledger.track(`raster:${url}`, r.width * r.height * 4)
    }
    return rasterCache.get(url)
  }
  // Drop every raster this image was the last consumer of (decrement its remaining
  // uses; delete + untrack at zero). Runs on every path out of the loop body.
  const releaseAfter = (i) => {
    for (const url of usedSets[i]) {
      const c = (useCount.get(url) || 0) - 1
      useCount.set(url, c)
      if (c <= 0) { rasterCache.delete(url); ledger.release(`raster:${url}`) }
    }
  }

  const maps = []
  const transfer = []
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    emit('progress', [i, images.length, img.name])

    const srcUuids = srcUuidsByImg[i]
    if (srcUuids.length === 0) {
      emit('log', [`Depth maps: ${img.name} skipped (no overlapping views)`, 'warn', 'Dense'])
      releaseAfter(i)
      continue
    }
    const imgBestK = autoBestKMode ? autoBestK(srcUuids.length) : bestK

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
      // Source masks (film frame / fiducials) must be excluded from the ZNCC match,
      // not just from the reference's own depth: otherwise a reference pixel finds a
      // spurious low-cost match against a neighbour's high-contrast border, leaking
      // those edges into the depth map. Build the LUT at the source's working size.
      const srcMask = s.mask ? await buildMaskLookup(s.mask, rs.width, rs.height) : null
      sources.push({
        gray: rgbaToGray(rs.data, rs.width, rs.height),
        w: rs.width, h: rs.height,
        K: scaleK(s.K, rs.scale),
        cam: { R: s.R, t: s.t },
        mask: srcMask,
      })
    }

    const tImg = performance.now()
    // Always stream depthMapForImage's own log (coarse-to-fine plan, debug level);
    // validate the GPU cost kernel against the CPU reference on the first image only.
    const hooks = {
      onLog: (m, l, c) => emit('log', [`${img.name}: ${m}`, l, c]),
      validate: backend && i === 0,
    }
    let dm
    try {
      dm = await depthMapForImage(ref, sources, points, { window, iterations, bestK: imgBestK }, backend, hooks)
    } catch (err) {
      // A GPU failure mid-run must not abort the whole batch: log it, drop to WASM
      // for this image and every image after, and retry once on the CPU path.
      if (backend) {
        emit('log', [`Depth maps: GPU error on ${img.name} (${err?.message ?? err}) — falling back to WASM`,
          'warn', 'Dense'])
        backend = undefined
        dm = await depthMapForImage(ref, sources, points, { window, iterations, bestK: imgBestK }, backend)
      } else {
        throw err
      }
    }
    const imgMs = performance.now() - tImg
    if (!dm) {
      emit('log', [`Depth maps: ${img.name} skipped (no sparse depth support)`, 'warn', 'Dense'])
      releaseAfter(i)
      continue
    }
    // Median / speckle filter: clean per-image noise before the cross-view fusion
    // gate sees it (the per-image PatchMatch has no geometric consistency check).
    if (speckleFilter) {
      const { depth: fdepth, removed, smoothed } =
        filterDepthMap(dm.depth, dm.width, dm.height, { radius: filterRadius, relTol: filterRelTol })
      dm.depth = fdepth
      emit('log', [`Depth maps: ${img.name} — speckle filter dropped ${removed} px, smoothed ${smoothed}`,
        'debug', 'Dense'])
    }
    // Drop masked regions from the dense cloud: zero the depth there so fusion
    // (which treats depth <= 0 as "no data") skips those pixels.
    if (img.mask) {
      const maskLut = await buildMaskLookup(img.mask, dm.width, dm.height)
      for (let k = 0; k < dm.depth.length; k++) if (maskLut[k]) dm.depth[k] = 0
    }
    const rgb = rgbFromRgba(rRef.data, rRef.width, rRef.height)
    const displayDataUrl = await depthToDataUrl(dm.depth, dm.width, dm.height)
    // Per-pixel diagnostics: how many pixels got a depth, and the matching-cost
    // distribution over those pixels (low cost = confident; high = likely junk
    // that fusion's maxCost gate will drop — the key signal for dense quality).
    let valid = 0
    const costs = []
    for (let k = 0; k < dm.depth.length; k++) {
      if (dm.depth[k] > 0) { valid++; costs.push(dm.cost[k]) }
    }
    const cs = stat(costs)
    const seedPct = (100 * dm.seeded / dm.depth.length).toFixed(1)
    emit('log', [`Depth maps: ${img.name} — ${srcUuids.length} sources (best-${imgBestK}), ${dm.width}×${dm.height}, `
      + `depth ${dm.depthMin.toFixed(2)}–${dm.depthMax.toFixed(2)} (${dm.seeded} seeds, ${seedPct}%), `
      + `${(100 * valid / dm.depth.length).toFixed(0)}% with depth, `
      + `cost median ${cs.median.toFixed(2)} / p95 ${cs.p95.toFixed(2)}, ${(imgMs / 1000).toFixed(1)}s`,
      'info', 'Dense'])

    maps.push({
      uuid: img.uuid, width: dm.width, height: dm.height,
      K: ref.K, R: img.R, t: img.t,
      depth: dm.depth, cost: dm.cost, rgb, displayDataUrl,
    })
    transfer.push(dm.depth.buffer, dm.cost.buffer, rgb.buffer)
    releaseAfter(i) // evict rasters this image was the last consumer of
  }

  emit('progress', [images.length, images.length, 'Done'])
  emit('log', [`Depth maps: ${maps.length}/${images.length} computed in ${((performance.now() - t0) / 1000).toFixed(1)}s; `
    + `raster cache peak ${formatBytes(ledger.peak())}`, 'success', 'Dense'])
  return { result: { maps }, transfer }
}

// Stage B — Build Point Cloud (dense). Fuses the depth maps from Stage A into a
// single coloured point cloud (pure compute in core/mvs.js).
async function densify([input], { emit }) {
  const { maps, settings = {} } = input
  emit('progress', [0, 1, 'Fusing depth maps…'])
  const tFuse = performance.now()
  const points = fuseDepthMaps(maps, settings, (m, l, c) => emit('log', [m, l, c]))
  emit('log', [`Dense cloud: fused ${maps.length} depth maps → ${points.length} points `
    + `in ${((performance.now() - tFuse) / 1000).toFixed(1)}s`, 'success', 'Dense'])
  emit('progress', [1, 1, 'Done'])
  // Pack points into a transferable flat buffer: [x,y,z,r,g,b] per point.
  const flat = new Float32Array(points.length * 6)
  points.forEach((p, i) => {
    flat.set([p.x, p.y, p.z, p.color[0], p.color[1], p.color[2]], i * 6)
  })
  return { result: { points: flat, summary: points.summary ?? null }, transfer: [flat.buffer] }
}

// Rebuild a projection frame from a serialisable descriptor (frames carry
// closures, so they can't cross postMessage — the store sends a spec, the worker
// resolves it). 'local' is derived from the scene; 'similarity' from a fit.
function rebuildFrame(spec, cameras, points) {
  if (spec?.kind === 'similarity') {
    return frameFromSimilarity({ scale: spec.scale, R: spec.R, t: spec.t }, spec.crs)
  }
  if (spec && spec.origin && spec.east) {
    // A fully-resolved local descriptor (re-used by the ortho pass).
    return makeFrame(spec)
  }
  return buildLocalFrame(cameras.values(), points)
}

// A serialisable snapshot of a frame (basis + metadata) so the DEM result can
// carry the exact frame its grid was built in, for the ortho pass to reuse.
function frameDescriptor(frame, spec) {
  if (spec?.kind === 'similarity') return { kind: 'similarity', scale: spec.scale, R: spec.R, t: spec.t, crs: spec.crs }
  return {
    kind: 'local', origin: frame.origin, east: frame.east, north: frame.north, up: frame.up,
    crs: frame.crs, unit: frame.unit, source: frame.source,
  }
}

// Colourise + hillshade a DEM height grid to a PNG data URL for the preview. Uses
// the shared depth ramp for elevation, multiplied by a simple Lambertian
// hillshade from the height gradient. Nodata cells are transparent.
async function demToDataUrl(grid) {
  const { width: w, height: h, data, mask, gsd, zMin, zMax } = grid
  const span = zMax > zMin ? zMax - zMin : 1
  const img = new ImageData(w, h)
  // Light from the north-west, 45° up.
  const lx = -0.7071, ly = 0.7071, lz = 1
  const at = (c, r) => (mask[r * w + c] ? data[r * w + c] : NaN)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const o = (r * w + c) * 4
      const z = at(c, r)
      if (Number.isNaN(z)) { img.data[o + 3] = 0; continue }
      const [cr, cg, cb] = depthColor((z - zMin) / span)
      // Central-difference slope (fall back to same cell at borders/holes).
      const zl = mask[r * w + Math.max(0, c - 1)] ? data[r * w + Math.max(0, c - 1)] : z
      const zr = mask[r * w + Math.min(w - 1, c + 1)] ? data[r * w + Math.min(w - 1, c + 1)] : z
      const zt = mask[Math.max(0, r - 1) * w + c] ? data[Math.max(0, r - 1) * w + c] : z
      const zb = mask[Math.min(h - 1, r + 1) * w + c] ? data[Math.min(h - 1, r + 1) * w + c] : z
      const dzdx = (zr - zl) / (2 * gsd), dzdy = (zb - zt) / (2 * gsd)
      const nlen = Math.hypot(dzdx, dzdy, 1)
      const shade = Math.max(0.25, Math.min(1, (-dzdx * lx - dzdy * ly + lz) / (nlen * Math.hypot(lx, ly, lz))))
      img.data[o] = cr * shade; img.data[o + 1] = cg * shade; img.data[o + 2] = cb * shade; img.data[o + 3] = 255
    }
  }
  return rasterToDataUrl(img, w, h)
}

async function rasterToDataUrl(imageData, w, h) {
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').putImageData(imageData, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
}

// Build a DEM: transform the (dense) points into the chosen frame, rasterise a
// height grid, and bake a hillshaded preview. Pure compute lives in
// core/{projection,georef,dem}.js. Returns the grid (+ its frame descriptor so
// the ortho pass reuses the exact same frame).
async function generateDem([input], { emit }) {
  const { points, cameras = [], frame: frameSpec, settings = {} } = input
  const camMap = new Map(cameras.map((c) => [c.uuid, { R: c.R, t: c.t, K: c.K }]))
  emit('progress', [0, 1, 'Projecting points…'])
  const frame = rebuildFrame(frameSpec, camMap, points)

  // Project every point into the frame (z = height).
  const framed = new Array(points.length)
  for (let i = 0; i < points.length; i++) {
    const [x, y, z] = frame.fromSfm(points[i])
    framed[i] = { x, y, z }
  }

  emit('progress', [0, 1, 'Rasterising grid…'])
  const grid = rasterizeDem(framed, settings)
  if (!grid) throw new Error('DEM: could not rasterise (need a denser cloud or a smaller GSD)')

  const previewDataUrl = await demToDataUrl(grid)
  const unitLabel = frame.unit === 'm' ? 'm' : 'model units'
  emit('log', [`DEM: ${grid.width}×${grid.height} @ ${grid.gsd.toPrecision(3)} ${unitLabel}/px, `
    + `z ${grid.zMin.toPrecision(4)}–${grid.zMax.toPrecision(4)}, `
    + `${grid.count} measured + ${grid.filled} filled cells (${frame.crs})`, 'success', 'Products'])
  emit('progress', [1, 1, 'Done'])

  const result = {
    width: grid.width, height: grid.height, gsd: grid.gsd,
    originX: grid.originX, originY: grid.originY,
    data: grid.data, mask: grid.mask, zMin: grid.zMin, zMax: grid.zMax,
    count: grid.count, filled: grid.filled,
    frame: frameDescriptor(frame, frameSpec), crs: frame.crs, unit: frame.unit,
    previewDataUrl,
  }
  return { result, transfer: [grid.data.buffer, grid.mask.buffer] }
}

// Build an orthophoto by reprojecting each DEM cell into the cached depth maps
// (their depth planes double as occlusion z-buffers; their RGB planes supply the
// colour). Pure compute lives in core/ortho.js.
async function generateOrtho([input], { emit }) {
  const { dem, maps, settings = {} } = input
  emit('progress', [0, dem.height, 'Orthorectifying…'])
  const frame = rebuildFrame(dem.frame)
  const t0 = performance.now()
  const { width, height, rgba, covered } = orthorectify(dem, maps, frame.toSfm, settings,
    (done, total) => emit('progress', [done, total, 'Orthorectifying…']))

  const previewDataUrl = await rasterToDataUrl(new ImageData(rgba, width, height), width, height)
  emit('log', [`Ortho: ${width}×${height}, ${covered}/${width * height} cells coloured `
    + `(${(100 * covered / (width * height)).toFixed(0)}%) from ${maps.length} view(s) `
    + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'success', 'Products'])
  emit('progress', [height, height, 'Done'])

  const rgbaBuf = new Uint8Array(rgba.buffer)
  return {
    result: { width, height, rgba: rgbaBuf, covered, previewDataUrl },
    transfer: [rgbaBuf.buffer],
  }
}

const ops = { detect, match, verify, reconstruct, computeDepthMaps, densify, generateDem, generateOrtho }

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

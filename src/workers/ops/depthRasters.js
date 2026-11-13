// Dense Stage A's rasters: each photo decoded at the working size and moved into the
// pinhole frame the sparse cameras use (distortion folded out, a film scan warped to its
// canonical frame, a fisheye onto a wider canvas), its mask moved the same way, and the
// cache that keeps each raster, its mask and its grey plane while a later map needs it.
// The depth preview PNG is here too. Moved from workers/ops/dense.js (R2).

import { buildMaskLookup } from '../../utils/maskCanvas.js'
import { hasDistortion } from '../../core/sfm/distortion.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import {
  resampleRgba,
  resampleMaskLut,
  pinholeFrameSize,
  fisheyeCanvas,
  resampleRgbaMarked,
} from '../../core/products/undistort.js'
import { rgbaToGray } from '../../core/dense/mvs.js'
import { scaleAxes } from '../../core/sfm/geometry.js'
import { depthColor } from '../../core/products/colormap.js'
import { createMemLedger } from '../../core/dense/memBudget.js'
import { DENSE_TUNING } from '../../core/tuning.js'

// ── Raster → pinhole frame ──────────────────────────────────────────────────
// Every raster dense reads must live in the same pinhole frame as the sparse
// cloud: distortion folded out, and for a film scan the scan→canonical affine
// applied too. The *map* comes from core/sfm/displayFrame.js `makeSampleMap`
// (one composition, shared with the image view's residual overlay and the
// undistorted-image export) and the *resampling* from core/products/undistort.js.
// Dense supplies the two scale factors because it works at reduced resolution.

// A working raster's per-axis scale: what the rounded resize applied (rasterize's
// scaleXY), never the nominal `scale` alone — see geometry.js scaleK.
export const gridScale = (r) => r.scaleXY ?? r.scale
// A source's identity for the memory ledger: the URL, or a pyramid's `key`
// (utils/image.js pyramidSource) — an object would stringify to one shared tag.
export const srcKey = (u) => (typeof u === 'string' ? u : (u?.key ?? String(u)))

// Any distortion to remove (calibrated OR self-calibrated), or a rolling-shutter
// photo to move onto its principal row's pose (`rs`, RSH-4)?
export function hasAnyDistortion(dist, selfCal, rs = null) {
  return hasDistortion(dist) || hasDistortion(selfCal) || !!rs
}

// Remove lens distortion from a working-resolution raster. Kfull is the
// native-resolution K; output and source share the working grid, so both scales
// are its per-axis factors (`r.scaleXY`). A no-op when both bags are empty — that early return is what
// keeps the common EXIF-only case free (a pure scale change is still a real map).
//
// A fisheye goes onto a wider canvas (undistort.js fisheyeCanvas): the raster then
// carries `pad` (the principal-point shift, full-res px — use paddedK), `outside`
// (0/1 LUT of canvas pixels off the photo) and, like every undistorted raster,
// `undist` = { map, sw, sh } to move a photo-space mask the same way (undistortedMask).
// `photo` = { width, height } of the full-resolution photo.
export function undistortRaster(r, Kfull, dist, selfCal, photo = null, rs = null) {
  if (!hasAnyDistortion(dist, selfCal, rs)) return r
  const base = makeSampleMap({ K: Kfull, dist, selfCal, rs, outScale: gridScale(r), srcScale: gridScale(r) })
  const canvas = !hasDistortion(selfCal) && photo ? fisheyeCanvas(Kfull, dist, photo.width, photo.height) : null
  if (!canvas) {
    return { ...r, data: resampleRgba(r, base, r.width, r.height), undist: { map: base, sw: r.width, sh: r.height } }
  }
  const [sx, sy] = scaleAxes(gridScale(r))
  const ox = canvas.dx * sx,
    oy = canvas.dy * sy
  const map = (u, v) => base(u - ox, v - oy)
  const ow = Math.round(canvas.width * sx),
    oh = Math.round(canvas.height * sy)
  const { data, outside } = resampleRgbaMarked(r, map, ow, oh)
  return {
    ...r,
    data,
    width: ow,
    height: oh,
    pad: { dx: canvas.dx, dy: canvas.dy },
    outside,
    undist: { map, sw: r.width, sh: r.height },
  }
}

// The camera's K for an undistorted raster's grid (before scaling to it): a widened
// fisheye canvas shifts the principal point by its pad; the focal is unchanged.
export const paddedK = (K, r) => (r.pad ? { ...K, cx: K.cx + r.pad.dx, cy: K.cy + r.pad.dy } : K)

// A photo-space mask (1 = excluded) on an undistorted raster's grid, nearest sample,
// OR the canvas pixels off the photo. Null when there is nothing to exclude.
export async function undistortedMask(mask, r) {
  let lut = null
  if (mask) {
    lut = await buildMaskLookup(mask, r.undist ? r.undist.sw : r.width, r.undist ? r.undist.sh : r.height)
    if (r.undist) lut = resampleMaskLut(lut, r.undist.sw, r.undist.sh, r.undist.map, r.width, r.height)
  }
  if (!r.outside) return lut
  if (!lut) return r.outside
  const out = new Uint8Array(lut.length)
  for (let k = 0; k < lut.length; k++) out[k] = lut[k] || r.outside[k] ? 1 : 0
  return out
}

// ── Film scan → canonical warp (F4) ─────────────────────────────────────────
// A film image's sparse cameras use the canonical K, so its dense reference
// raster must live in the canonical pixel frame too. We warp the scan raster
// into that frame with the SAME transform chain the sparse ingest applied, only
// inverted (output canonical px → sample the scan). The canonical working grid
// is sized so its long side ≈ maxDim (matching non-film rasters). Returns a
// raster carrying what the mask warp needs (scanDims, fid, canonK, dist).
export function filmSampleMap(canonK, dist, fid, cScale, scanScale, selfCal) {
  return makeSampleMap({
    K: canonK,
    dist,
    selfCal,
    fiducial: fid,
    outScale: cScale,
    srcScale: scanScale,
  })
}

export function warpFilmRaster(r, canonK, dist, fid, maxDim, selfCal) {
  const { width: sw, height: sh } = r
  const scanScale = gridScale(r)
  const { frame } = fid
  const cScale = maxDim / Math.max(frame.width, frame.height)
  const { width: ow, height: oh } = pinholeFrameSize({ fiducial: fid, scale: cScale })
  const useDist = hasDistortion(dist) ? dist : null
  const useSelf = hasDistortion(selfCal) ? selfCal : null
  const map = filmSampleMap(canonK, useDist, fid, cScale, scanScale, useSelf)
  return {
    // The canonical grid is defined by cScale on both axes (the map above), so K
    // scales uniformly; only the scan it samples has rounded per-axis factors.
    data: resampleRgba(r, map, ow, oh),
    width: ow,
    height: oh,
    scale: cScale,
    scaleXY: [cScale, cScale],
    fid,
    canonK,
    dist: useDist,
    selfCal: useSelf,
    scanDims: { w: sw, h: sh, scale: scanScale },
  }
}

// Warp a scan-space mask LUT (built at scan working size) into the canonical
// working grid of raster `r` (a warpFilmRaster output). Nearest sample.
export async function filmMaskLut(mask, r) {
  const sd = r.scanDims
  const scanLut = await buildMaskLookup(mask, sd.w, sd.h)
  const map = filmSampleMap(r.canonK, r.dist, r.fid, r.scale, sd.scale, r.selfCal)
  return resampleMaskLut(scanLut, sd.w, sd.h, map, r.width, r.height)
}

// Greyscale rasters (R = G = B everywhere) kept as one channel; the grey plane is
// rgbaToGray's own expression on (v, v, v), so it matches it exactly.
export function isGreyRgba(data) {
  for (let o = 0; o < data.length; o += 4) if (data[o] !== data[o + 1] || data[o] !== data[o + 2]) return false
  return true
}
export function firstChannel(data) {
  const v = new Uint8Array(data.length >> 2)
  for (let i = 0; i < v.length; i++) v[i] = data[i * 4]
  return v
}
export function greyFromChannel(v) {
  const gray = new Uint8Array(v.length)
  for (let i = 0; i < v.length; i++) gray[i] = (v[i] * 0.299 + v[i] * 0.587 + v[i] * 0.114) | 0
  return gray
}
export function rgbFromChannel(v) {
  const rgb = new Uint8Array(v.length * 3)
  for (let i = 0; i < v.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v[i]
  return rgb
}

// Extract a tightly-packed RGB buffer (drop alpha) from RGBA pixels.
export function rgbFromRgba(data, w, h) {
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = data[i * 4]
    rgb[i * 3 + 1] = data[i * 4 + 1]
    rgb[i * 3 + 2] = data[i * 4 + 2]
  }
  return rgb
}

// Render a depth plane to a colourized PNG Blob for the image viewer's depth
// overlay (a Blob, not a data URL: it crosses to the page by reference and stays
// off both V8 heaps). Valid depths are normalised to a blue→red ramp (near = red); holes
// are transparent so the underlying image shows through.
// At most DENSE_TUNING.depthPreviewMaxDim on its long side, nearest sample.
export async function depthToPng(depth, w, h) {
  let lo = Infinity,
    hi = -Infinity
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i]
    if (d > 0) {
      if (d < lo) lo = d
      if (d > hi) hi = d
    }
  }
  const span = hi > lo ? hi - lo : 1
  const f = Math.min(1, DENSE_TUNING.depthPreviewMaxDim / Math.max(w, h))
  const pw = Math.max(1, Math.round(w * f)),
    ph = Math.max(1, Math.round(h * f))
  const img = new ImageData(pw, ph)
  for (let i = 0; i < pw * ph; i++) {
    const sx = Math.min(w - 1, Math.floor(((i % pw) + 0.5) / f)),
      sy = Math.min(h - 1, Math.floor((Math.floor(i / pw) + 0.5) / f))
    const d = depth[sy * w + sx]
    const o = i * 4
    if (d > 0) {
      // Near = warm (t→1), far = cool (t→0).
      const t = 1 - (d - lo) / span
      const [r, g, b] = depthColor(t)
      img.data[o] = r
      img.data[o + 1] = g
      img.data[o + 2] = b
      img.data[o + 3] = 255
    } else {
      img.data[o] = 0
      img.data[o + 1] = 0
      img.data[o + 2] = 0
      img.data[o + 3] = 0
    }
  }
  const canvas = new OffscreenCanvas(pw, ph)
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(img, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

// The rasters one run of depth maps reads: `images` (every image of the run), `order`
// (the indices this call computes), `srcUuidsByImg` (each one's source views) and
// `maxDim` (the working size). → { prepare, ready, prefetch, releaseAfter,
// imageByUuid, ledger, prepMs }: prepMs also collects the loop's other timings.
export function createRasterCache({ rasterize, images, order, srcUuidsByImg, maxDim }) {
  const urlByUuid = new Map(images.map((im) => [im.uuid, im.url]))
  // Per-url intrinsics + distortion, so decodeRaster can undistort each source once
  // (url↔image is 1:1, and undistortion is independent of ref/source role).
  const metaByUrl = new Map(
    images.map((im) => [
      im.url,
      {
        K: im.K,
        dist: im.dist || null,
        selfCal: im.selfCal || null,
        fid: im.fid || null,
        rs: im.rs || null,
        photo: im.width > 0 && im.height > 0 ? { width: im.width, height: im.height } : null,
      },
    ]),
  )
  const usedSets = new Map(
    order.map((i) => {
      const set = new Set([images[i].url])
      for (const u of srcUuidsByImg.get(i)) {
        const url = urlByUuid.get(u)
        if (url) set.add(url)
      }
      return [i, set]
    }),
  )
  const useCount = new Map()
  for (const set of usedSets.values()) for (const url of set) useCount.set(url, (useCount.get(url) || 0) + 1)

  const ledger = createMemLedger()
  // Where the loop's time goes, beside the matching itself (logged at the end): the
  // decode + warp of each raster, its mask, its grey plane.
  const prepMs = { raster: 0, mask: 0, gray: 0, post: 0, saveWait: 0, waited: 0 }
  const decodeRaster = async (url) => {
    const tR = performance.now()
    let r = await rasterize(url, maxDim)
    // Undistort at ingest so every dense consumer stays pinhole (mirrors sparse).
    const meta = metaByUrl.get(url)
    if (meta?.fid) {
      // Film scan: warp into the canonical frame (composes calibrated + self-cal).
      r = warpFilmRaster(r, meta.K, meta.dist, meta.fid, maxDim, meta.selfCal)
    } else if (meta?.dist || meta?.selfCal || meta?.rs) {
      r = undistortRaster(r, meta.K, meta.dist, meta.selfCal, meta.photo, meta.rs)
    }
    // A greyscale raster (a film scan) is held as its one channel: four bytes a
    // pixel for every raster still needed filled the tab's buffer pool on a film
    // block at High (7.5 GB). Grey plane and colours come out bit for bit the same.
    if (isGreyRgba(r.data)) r = { ...r, data: null, channel: firstChannel(r.data) }
    prepMs.raster += performance.now() - tR
    return r
  }
  // An image's working raster with its mask on that grid and its grey plane, built
  // once and kept as long as any later map needs it (useCount). Each source used to
  // rebuild mask and grey for every map it served: decoding a full-size scan mask and
  // warping it into the film frame, up to seven times per map, was most of the loop's
  // time on the TMA film blocks. A promise, so the next map's images can be prepared
  // while this map matches (the worker's thread is idle while the GPU works).
  const prepared = new Map() // url → Promise<{ r, mask, gray }>
  const prepare = (im) => {
    if (!prepared.has(im.url)) {
      const job = (async () => {
        const r = await decodeRaster(im.url)
        const tM = performance.now()
        const mask = r.fid ? (im.mask ? await filmMaskLut(im.mask, r) : null) : await undistortedMask(im.mask, r)
        prepMs.mask += performance.now() - tM
        const tG = performance.now()
        const gray = r.channel ? greyFromChannel(r.channel) : rgbaToGray(r.data, r.width, r.height)
        prepMs.gray += performance.now() - tG
        ledger.track(
          `raster:${srcKey(im.url)}`,
          r.width * r.height * ((r.channel ? 1 : 4) + 1) + (mask ? mask.length : 0),
        )
        return { r, mask, gray }
      })()
      job.catch(() => {}) // a prefetch nobody awaits yet must not be an unhandled rejection
      prepared.set(im.url, job)
    }
    return prepared.get(im.url)
  }
  // Waits on a preparation, timing only what the loop could not overlap.
  const ready = async (im) => {
    const t = performance.now()
    const p = await prepare(im)
    prepMs.waited += performance.now() - t
    return p
  }
  const imageByUuid = new Map(images.map((im) => [im.uuid, im]))
  // Start preparing map k's reference and sources (not awaited).
  const prefetch = (k) => {
    if (k >= order.length) return
    const i = order[k]
    prepare(images[i])
    for (const u of srcUuidsByImg.get(i)) {
      const s = imageByUuid.get(u)
      if (s) prepare(s)
    }
  }
  // Drop every raster this image was the last consumer of (decrement its remaining
  // uses; delete + untrack at zero). Runs on every path out of the loop body.
  const releaseAfter = (i) => {
    for (const url of usedSets.get(i)) {
      const c = (useCount.get(url) || 0) - 1
      useCount.set(url, c)
      if (c <= 0 && prepared.delete(url)) ledger.release(`raster:${srcKey(url)}`)
    }
  }
  return { prepare, ready, prefetch, releaseAfter, imageByUuid, ledger, prepMs }
}

import { detectSift } from '../../core/features/sift.js'
import { matchDescriptors } from '../../core/features/bruteforce.js'
import { estimateHomographyRansac, applyHomography } from '../../core/features/guidedTiles.js'
import { percentileRange, stretchTo255 } from '../../core/io/rasterStyle.js'
import { homographyToNative, homographyScale, footprintRect, searchWindows, SEARCH_LEVELS, fineTiles, acceptTile } from '../../core/sfm/referenceMatch.js'
import { readWindowFromFile } from './io.js'
import { windowToNative } from '../../core/io/rasterWindow.js'
import { rasterToDataUrl, rasterToPng } from '../rasterPreview.js'

const COARSE_DIM = 1536

// Find GCPs (Tools ▸ Georeferencing): match the project orthophoto to a
// georeferenced reference band, coarse to fine.
//   1. Coarse: SIFT on a 1536-px look at both, one RANSAC homography. When the
//      search region read at that size gives no alignment, its 3×3 half-size and
//      then 5×5 quarter-size windows are tried (referenceMatch.js searchWindows) —
//      a block that is a few dozen pixels of a regional tile gets 2× and 4× more.
//   2. Refine: re-read only the reference footprint the alignment predicts and
//      match again, until a look no longer shrinks the window by half.
//   3. Fine: tiles over the ortho, both sides read at the coarser of the two
//      native resolutions (overviews for the finer one), matched inside a gate
//      around the coarse prediction, each tile with its own homography — relief
//      and doming bend a single plane — accepted only when its inliers are many,
//      consistent and spread across the tile.
// Everything returned is in native pixel-edge coordinates of each raster. The
// main thread turns matches into candidate GCPs (core/sfm/referenceGcps.js).
export function makeReferenceGcpOps({ rasterize }) {
  // Valid pixels stretched 2–98 % to gray; nodata filled with mid-gray so its
  // border does not become the strongest edge in the window.
  function grayRaster(values, width, height, isValid) {
    const sample = []
    for (let i = 0, step = Math.max(1, Math.ceil(values.length / 20000)); i < values.length; i += step)
      if (isValid(i)) sample.push(values[i])
    const range = percentileRange(sample, 2, 98)
    const data = new Uint8ClampedArray(width * height * 4), valid = new Uint8Array(width * height)
    let count = 0
    for (let i = 0; i < width * height; i++) {
      const ok = isValid(i), v = ok ? stretchTo255(values[i], range) : 128, o = i * 4
      data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255
      if (ok) { valid[i] = 1; count++ }
    }
    return { data, valid, width, height, coverage: count / Math.max(1, width * height) }
  }
  function referenceGray(raw) {
    const band = raw.channels[0], nodata = raw.nodata
    return grayRaster(band, raw.width, raw.height, i => Number.isFinite(band[i]) && band[i] !== nodata)
  }
  function orthoGray(raw) { // RGBA COG: alpha 0 = not covered
    const [r, g, b, a] = raw.channels, n = raw.width * raw.height, lum = new Float32Array(n)
    for (let i = 0; i < n; i++) lum[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i]
    return grayRaster(lum, raw.width, raw.height, i => !a || a[i] > 0)
  }
  // A keypoint counts only with valid pixels 3 samples around it.
  const inside = (r, x, y) => [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, 0]].every(([dx, dy]) => {
    const u = Math.floor(x + dx), v = Math.floor(y + dy)
    return u >= 0 && v >= 0 && u < r.width && v < r.height && r.valid[v * r.width + u]
  })
  async function features(raster, maxKeypoints) {
    const { flat } = await detectSift(raster.data, raster.width, raster.height, { maxKeypoints, contrastThreshold: 0.01, maxOrientations: 2 })
    const count = Math.max(0, Math.floor((flat.length - 2) / 133)), points = [], keep = []
    for (let i = 0; i < count; i++) {
      const x = flat[i * 133], y = flat[i * 133 + 1]
      if (inside(raster, x, y)) { points.push([x, y]); keep.push(i) }
    }
    const descriptors = new Float32Array(keep.length * 128)
    keep.forEach((i, k) => descriptors.set(flat.subarray(i * 133 + 5, i * 133 + 133), k * 128))
    return { points, descriptors }
  }
  async function pairs(a, b, ratioThreshold) {
    const { matches } = await matchDescriptors(a.descriptors, b.descriptors, { ratioThreshold, crossCheck: true })
    return matches.map(m => [a.points[m.ia], b.points[m.ib]])
  }
  const toNative = (layout, [x, y]) => windowToNative(layout, x, y)

  async function findReferenceMatches([{ local, reference }], { emit }) {
    const log = (m) => emit?.('log', [m, 'info', 'Find GCPs'])
    // The project ortho, whole, at the coarse size: its stored COG (overview read)
    // or, for a record without one, its preview image.
    let localLayout, localRaster
    if (local.cog) {
      const raw = await readWindowFromFile(local.cog, { maxDim: COARSE_DIM, bands: [0, 1, 2, 3], overviews: true })
      localLayout = raw; localRaster = orthoGray(raw)
    } else {
      const img = await rasterize(local.previewUrl, COARSE_DIM)
      const sx = local.width / img.width, sy = local.height / img.height
      localLayout = { scaleX: sx, scaleY: sy, centreX0: sx / 2, centreY0: sy / 2 }
      localRaster = grayRaster(img.data.filter((_, i) => i % 4 === 0), img.width, img.height, i => img.data[i * 4 + 3] > 0)
    }
    const localFeatures = await features(localRaster, 4000)
    const covered = (x0, y0, x1, y1) => { // fraction of valid ortho samples in a native rect, from the coarse look
      let n = 0, v = 0
      const c0 = localLayout.centreX0 ?? 0.5, r0 = localLayout.centreY0 ?? 0.5
      for (let y = Math.max(0, Math.ceil((y0 - r0) / localLayout.scaleY)); y < Math.min(localRaster.height, (y1 - r0) / localLayout.scaleY); y++)
        for (let x = Math.max(0, Math.ceil((x0 - c0) / localLayout.scaleX)); x < Math.min(localRaster.width, (x1 - c0) / localLayout.scaleX); x++) { n++; v += localRaster.valid[y * localRaster.width + x] }
      return n ? v / n : 0
    }

    // One coarse look at a reference rect → { H (native → native), … } or null.
    async function look(rect) {
      const raw = await readWindowFromFile(reference.file, { rect, maxDim: COARSE_DIM, bands: [reference.band], overviews: true })
      const ref = referenceGray(raw)
      if (ref.coverage < 0.02) return null
      const p = await pairs(localFeatures, await features(ref, 4000), 0.75)
      const fit = estimateHomographyRansac(p.map(q => q[0]), p.map(q => q[1]), { threshPx: 3, iters: 2000 })
      if (!fit || fit.inlierCount < 10 || fit.inlierCount / Math.max(1, p.length) < 0.25) return null
      const H = homographyToNative(fit.H, localLayout, raw)
      const s = (raw.scaleX + raw.scaleY) / 2
      return { H, raw, ref, rect: { col: raw.window[0], row: raw.window[1], width: raw.window[2] - raw.window[0], height: raw.window[3] - raw.window[1] },
        inliers: fit.inlierCount, ratio: fit.inlierCount / p.length, p95: fit.p95ErrPx * s, refPerWorking: s,
        matches: p.filter((_, k) => fit.inlierMask[k]).map(([a, b]) => ({ a: toNative(localLayout, a), b: toNative(raw, b) })) }
    }

    const full = { col: 0, row: 0, width: reference.width, height: reference.height }
    const region = reference.region ?? full
    let coarse = null, searched = 0
    for (let level = 1; level <= 3 && !coarse; level++) {
      // A finer subdivision only pays while the region is read downsampled.
      if (level > 1 && Math.max(region.width, region.height) * SEARCH_LEVELS[level].size < COARSE_DIM * 0.8) break
      for (const w of searchWindows(region, level)) {
        searched++
        const hit = await look(w)
        if (hit && (!coarse || hit.inliers > coarse.inliers)) coarse = hit
      }
      if (!coarse) log(`No alignment in ${searched} search window(s) at level ${level}`)
    }
    if (!coarse) throw new Error(`No reliable ortho alignment found in ${searched} search window(s)`
      + `${reference.region ? ' around the expected footprint' : ''}. Try another reference band or a reference covering the same area; use manual control if the scene has changed substantially.`)
    const levels = [{ rect: coarse.rect, inliers: coarse.inliers, p95: coarse.p95 }]
    for (let k = 0; k < 2; k++) {
      const next = footprintRect(coarse.H, local.width, local.height, reference.width, reference.height)
      if (!next || next.width * next.height > 0.5 * coarse.rect.width * coarse.rect.height || coarse.refPerWorking < 1.2) break
      const hit = await look(next)
      if (!hit) break
      coarse = hit
      levels.push({ rect: hit.rect, inliers: hit.inliers, p95: hit.p95 })
    }
    log(`Coarse alignment: ${coarse.inliers} inliers, p95 ${coarse.p95.toFixed(1)} reference px, after ${levels.length} look(s)`)

    // Fine tiles.
    const scale = homographyScale(coarse.H, local.width / 2, local.height / 2)
    const tiles = [], matches = []
    let kl = 1, kr = coarse.refPerWorking
    if (local.cog) {
      const plan = fineTiles({ H: coarse.H, localWidth: local.width, localHeight: local.height, refWidth: reference.width, refHeight: reference.height,
        scale, margin: Math.max(32, Math.ceil(3 * coarse.p95 / (scale < 1 ? 1 : scale))), covered })
      kl = plan.kl; kr = plan.kr
      const gate = Math.max(32 * kr, 3 * coarse.p95)
      for (const t of plan.tiles) {
        const lraw = await readWindowFromFile(local.cog, { rect: t.local, maxDim: Math.min(4096, t.localMaxDim), bands: [0, 1, 2, 3], overviews: true })
        const rraw = await readWindowFromFile(reference.file, { rect: t.reference, maxDim: Math.min(4096, t.refMaxDim), bands: [reference.band], overviews: true })
        const lg = orthoGray(lraw), rg = referenceGray(rraw)
        const p = (await pairs(await features(lg, 2000), await features(rg, 2000), 0.8))
          .map(([a, b]) => [toNative(lraw, a), toNative(rraw, b)])
          .filter(([a, b]) => { const q = applyHomography(coarse.H, ...a); return Math.hypot(q[0] - b[0], q[1] - b[1]) <= gate })
        const fit = p.length >= 10 ? estimateHomographyRansac(p.map(q => q[0]), p.map(q => q[1]), { threshPx: 2 * kr, iters: 1000 }) : null
        if (!acceptTile(fit, p.map(q => q[0]), { tileSize: Math.min(t.local.width, t.local.height) })) continue
        const index = tiles.length, inl = p.filter((_, k) => fit.inlierMask[k])
        const [localPng, refPng] = await Promise.all([rasterToPng(lg.data, lg.width, lg.height), rasterToPng(rg.data, rg.width, rg.height)])
        tiles.push({ H: fit.H, inliers: fit.inlierCount, ratio: fit.inlierCount / p.length, local: t.local, reference: t.reference,
          localImage: { blob: localPng, ...imagePlacement(lraw) }, referenceImage: { blob: refPng, ...imagePlacement(rraw) } })
        for (const [a, b] of inl) {
          const q = applyHomography(fit.H, ...a)
          matches.push({ a, b, tile: index, residual: Math.hypot(q[0] - b[0], q[1] - b[1]) / kr })
        }
      }
      log(`Fine pass: ${tiles.length}/${plan.tiles.length} tiles aligned, ${matches.length} matches at ${(kr).toFixed(2)} reference px per working px`)
    }
    let fine = null
    if (matches.length >= 8) {
      const fit = estimateHomographyRansac(matches.map(m => m.a), matches.map(m => m.b), { threshPx: 3 * kr, iters: 1500 })
      if (fit) fine = { H: fit.H, inliers: fit.inlierCount, p95: fit.p95ErrPx / kr }
    } else {
      // Coarse only: no stored COG, or no tile aligned. The coarse matches stand in,
      // each on the one coarse model.
      tiles.length = 0; matches.length = 0
      tiles.push({ H: coarse.H, inliers: coarse.inliers, ratio: coarse.ratio, local: null, reference: null })
      kl = local.width / localRaster.width; kr = coarse.refPerWorking
      for (const m of coarse.matches) {
        const q = applyHomography(coarse.H, ...m.a)
        matches.push({ ...m, tile: 0, residual: Math.hypot(q[0] - m.b[0], q[1] - m.b[1]) / kr })
      }
    }
    return { result: {
      H: fine?.H ?? coarse.H, matches, tiles, kl, kr, refined: !!fine,
      coarse: { inliers: coarse.inliers, p95: coarse.p95 / coarse.refPerWorking, looks: levels, searched },
      fine: fine && { inliers: fine.inliers, p95: fine.p95 },
      referencePreview: { url: await rasterToDataUrl(coarse.ref.data, coarse.ref.width, coarse.ref.height), ...imagePlacement(coarse.raw) },
    } }
  }
  return { findReferenceMatches }
}

// Where a read's image sits in native pixel-edge coordinates (for an SVG <image>).
function imagePlacement(raw) {
  const cx = raw.centreX0 ?? raw.col + 0.5, cy = raw.centreY0 ?? raw.row + 0.5
  return { x: cx - raw.scaleX / 2, y: cy - raw.scaleY / 2, width: raw.width * raw.scaleX, height: raw.height * raw.scaleY, pixelWidth: raw.width, pixelHeight: raw.height }
}

import { detectSift } from '../../core/features/sift.js'
import { matchDescriptors } from '../../core/features/bruteforce.js'
import { estimateHomographyRansac, applyHomography } from '../../core/features/guidedTiles.js'
import { percentileRange, stretchTo255 } from '../../core/io/rasterStyle.js'
import {
  homographyToNative,
  homographyScale,
  footprintRect,
  searchWindows,
  SEARCH_LEVELS,
  fineTiles,
  acceptTile,
} from '../../core/sfm/referenceMatch.js'
import { readWindowFromFile } from './io.js'
import { windowToNative } from '../../core/io/rasterWindow.js'
import { rasterToDataUrl, rasterToPng } from '../rasterPreview.js'
import { pluralize } from '../../core/textFormat.js'
import { detectLearned } from '../../core/features/learnedDetect.js'
import { learnedDetector } from '../../core/features/learnedDetectors.js'
import { matchLightGlue } from '../../core/features/lightglue.js'
import { keypointsFromObjects } from '../../core/features/keypoints.js'
import { planTiles, tileOwns } from '../../core/features/tiling.js'
import { paddedRect } from '../../core/sfm/referenceMatch.js'
import { icpAlign, applyTransform } from '../../core/products/cloudAlign.js'
import { median, terrainPasses } from '../../core/sfm/terrainControl.js'
import {
  coarseHypotheses,
  refineRotations,
  rotateGray,
  lookSizes,
  similarityHomography,
  homographyRotation,
} from '../../core/sfm/referenceLook.js'

const COARSE_DIM = 1536
// A learned look reads both rasters at up to this many samples a side (a 4-band
// orthophoto read stays inside rasterWindow's 16 M-sample budget), detects in tiles
// of LEARNED_TILE px and gives LightGlue the strongest LIGHTGLUE_KEYPOINTS of each.
const LEARNED_DIM = 2000
const LEARNED_TILE = 1024
const LIGHTGLUE_KEYPOINTS = 2048
// A learned look counts when this many matches agree on one homography (hist-sfm's
// minimum); wrong rotations on Rachel gave at most 8.
const LEARNED_MIN_INLIERS = 20

// Find GCPs (Tools ▸ Georeferencing): match the project orthophoto to a
// georeferenced reference band (or the mean of its first three bands), coarse to fine.
//   1. Coarse, learned (`matcher` 'disk' or 'superpoint'): both rasters read at the
//      same metres per sample, the orthophoto turned to a hypothesised rotation,
//      features detected in tiles and matched by LightGlue, one RANSAC homography
//      (core/sfm/referenceLook.js says which scales and rotations, best first: a
//      prior from camera positions or footprints, else a sweep). Film against a
//      satellite image shares shapes, not texture; this is what aligns it.
//      Coarse, SIFT (`matcher` 'sift'): a 1536-px look at both. When the
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
    const data = new Uint8ClampedArray(width * height * 4),
      valid = new Uint8Array(width * height)
    let count = 0
    for (let i = 0; i < width * height; i++) {
      const ok = isValid(i),
        v = ok ? stretchTo255(values[i], range) : 128,
        o = i * 4
      data[o] = data[o + 1] = data[o + 2] = v
      data[o + 3] = 255
      if (ok) {
        valid[i] = 1
        count++
      }
    }
    return { data, valid, width, height, coverage: count / Math.max(1, width * height) }
  }
  // One band, or the mean of the first three (as hist-sfm reads an RGB reference):
  // film is panchromatic, closer to the visible mean than to any one band.
  function referenceGray(raw) {
    const nodata = raw.nodata
    if (raw.channels.length >= 3) {
      const [r, g, b] = raw.channels,
        n = raw.width * raw.height,
        mean = new Float32Array(n)
      const ok = (v) => Number.isFinite(v) && v !== nodata
      for (let i = 0; i < n; i++) mean[i] = ok(r[i]) && ok(g[i]) && ok(b[i]) ? (r[i] + g[i] + b[i]) / 3 : NaN
      return grayRaster(mean, raw.width, raw.height, (i) => Number.isFinite(mean[i]))
    }
    const band = raw.channels[0]
    return grayRaster(band, raw.width, raw.height, (i) => Number.isFinite(band[i]) && band[i] !== nodata)
  }
  function orthoGray(raw) {
    // RGBA COG: alpha 0 = not covered
    const [r, g, b, a] = raw.channels,
      n = raw.width * raw.height,
      lum = new Float32Array(n)
    for (let i = 0; i < n; i++) lum[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i]
    return grayRaster(lum, raw.width, raw.height, (i) => !a || a[i] > 0)
  }
  // A keypoint counts only with valid pixels 3 samples around it.
  const inside = (r, x, y) =>
    [
      [-3, -3],
      [3, -3],
      [-3, 3],
      [3, 3],
      [0, 0],
    ].every(([dx, dy]) => {
      const u = Math.floor(x + dx),
        v = Math.floor(y + dy)
      return u >= 0 && v >= 0 && u < r.width && v < r.height && r.valid[v * r.width + u]
    })
  async function features(raster, maxKeypoints) {
    const { flat } = await detectSift(raster.data, raster.width, raster.height, {
      maxKeypoints,
      contrastThreshold: 0.01,
      maxOrientations: 2,
    })
    const count = Math.max(0, Math.floor((flat.length - 2) / 133)),
      points = [],
      keep = []
    for (let i = 0; i < count; i++) {
      const x = flat[i * 133],
        y = flat[i * 133 + 1]
      if (inside(raster, x, y)) {
        points.push([x, y])
        keep.push(i)
      }
    }
    const descriptors = new Float32Array(keep.length * 128)
    keep.forEach((i, k) => descriptors.set(flat.subarray(i * 133 + 5, i * 133 + 133), k * 128))
    return { points, descriptors }
  }
  async function pairs(a, b, ratioThreshold) {
    const { matches } = await matchDescriptors(a.descriptors, b.descriptors, { ratioThreshold, crossCheck: true })
    return matches.map((m) => [a.points[m.ia], b.points[m.ib]])
  }
  const toNative = (layout, [x, y]) => windowToNative(layout, x, y)

  // Learned features of a gray raster ({ data RGBA from grayRaster, valid }), in
  // tiles: `rotationDeg` turns it first (rotateGray), and the returned points are
  // back in the unturned raster's samples. Keypoints near nodata are dropped, as
  // `inside` does for SIFT. → { kps (Keypoints in the turned canvas, for LightGlue),
  // points, descriptors, width, height } with the turned canvas' size.
  async function learnedFeatures(spec, raster, rotationDeg, onLog) {
    const n = raster.width * raster.height,
      gray = new Float32Array(n)
    for (let i = 0; i < n; i++) gray[i] = raster.data[i * 4] / 255
    const turned = rotateGray(
      { data: gray, valid: raster.valid, width: raster.width, height: raster.height },
      rotationDeg,
    )
    const { width, height } = turned
    const found = []
    for (const tile of planTiles(width, height, LEARNED_TILE, 64, { align: spec.tileAlign })) {
      const planar = new Float32Array(tile.w * tile.h * spec.channels)
      for (let y = 0; y < tile.h; y++)
        planar.set(
          turned.data.subarray((tile.y + y) * width + tile.x, (tile.y + y) * width + tile.x + tile.w),
          y * tile.w,
        )
      for (let c = 1; c < spec.channels; c++) planar.copyWithin(c * tile.w * tile.h, 0, tile.w * tile.h)
      const { keypoints, descriptors } = await detectLearned(spec, planar, tile.w, tile.h, {
        maxKeypoints: LIGHTGLUE_KEYPOINTS,
        onLog,
      })
      keypoints.forEach((k, i) => {
        const x = k.x + tile.x,
          y = k.y + tile.y
        if (!tileOwns(tile, x, y) || !inside(turned, x, y)) return
        found.push({ x, y, score: k.score, desc: descriptors.subarray(i * spec.descDim, (i + 1) * spec.descDim) })
      })
    }
    found.sort((a, b) => b.score - a.score)
    const kept = found.slice(0, LIGHTGLUE_KEYPOINTS)
    const descriptors = new Float32Array(kept.length * spec.descDim)
    kept.forEach((f, i) => descriptors.set(f.desc, i * spec.descDim))
    return {
      kps: keypointsFromObjects(kept),
      points: kept.map((f) => turned.toSource(f.x, f.y)),
      descriptors,
      width,
      height,
    }
  }

  async function findReferenceMatches([{ local, reference, matcher = 'sift', prior = null }], { emit }) {
    const log = (m) => emit?.('log', [m, 'info', 'Find GCPs'])
    const refBands = reference.rgb ? [0, 1, 2] : [reference.band]
    const spec = learnedDetector(matcher)
    // The project ortho, whole, at the coarse size: its stored COG (overview read)
    // or, for a record without one, its preview image.
    let localLayout, localRaster
    if (local.cog) {
      const raw = await readWindowFromFile(local.cog, { maxDim: COARSE_DIM, bands: [0, 1, 2, 3], overviews: true })
      localLayout = raw
      localRaster = orthoGray(raw)
    } else {
      const img = await rasterize(local.previewUrl, COARSE_DIM)
      const sx = local.width / img.width,
        sy = local.height / img.height
      localLayout = { scaleX: sx, scaleY: sy, centreX0: sx / 2, centreY0: sy / 2 }
      localRaster = grayRaster(
        img.data.filter((_, i) => i % 4 === 0),
        img.width,
        img.height,
        (i) => img.data[i * 4 + 3] > 0,
      )
    }
    const localFeatures = spec ? null : await features(localRaster, 4000)
    const covered = (x0, y0, x1, y1) => {
      // fraction of valid ortho samples in a native rect, from the coarse look
      let n = 0,
        v = 0
      const c0 = localLayout.centreX0 ?? 0.5,
        r0 = localLayout.centreY0 ?? 0.5
      for (
        let y = Math.max(0, Math.ceil((y0 - r0) / localLayout.scaleY));
        y < Math.min(localRaster.height, (y1 - r0) / localLayout.scaleY);
        y++
      )
        for (
          let x = Math.max(0, Math.ceil((x0 - c0) / localLayout.scaleX));
          x < Math.min(localRaster.width, (x1 - c0) / localLayout.scaleX);
          x++
        ) {
          n++
          v += localRaster.valid[y * localRaster.width + x]
        }
      return n ? v / n : 0
    }

    // One coarse look at a reference rect → { H (native → native), … } or null.
    async function look(rect) {
      const raw = await readWindowFromFile(reference.file, {
        rect,
        maxDim: COARSE_DIM,
        bands: refBands,
        overviews: true,
      })
      const ref = referenceGray(raw)
      if (ref.coverage < 0.02) return null
      const p = await pairs(localFeatures, await features(ref, 4000), 0.75)
      const fit = estimateHomographyRansac(
        p.map((q) => q[0]),
        p.map((q) => q[1]),
        { threshPx: 3, iters: 2000 },
      )
      if (!fit || fit.inlierCount < 10 || fit.inlierCount / Math.max(1, p.length) < 0.25) return null
      const H = homographyToNative(fit.H, localLayout, raw)
      const s = (raw.scaleX + raw.scaleY) / 2
      return {
        H,
        raw,
        ref,
        rect: {
          col: raw.window[0],
          row: raw.window[1],
          width: raw.window[2] - raw.window[0],
          height: raw.window[3] - raw.window[1],
        },
        inliers: fit.inlierCount,
        ratio: fit.inlierCount / p.length,
        p95: fit.p95ErrPx * s,
        refPerWorking: s,
        matches: p
          .filter((_, k) => fit.inlierMask[k])
          .map(([a, b]) => ({ a: toNative(localLayout, a), b: toNative(raw, b) })),
      }
    }

    // The orthophoto read at `maxDim` samples (cached per size): its COG, or the
    // preview image when the record has none.
    const localReads = new Map()
    function localAt(maxDim) {
      if (!localReads.has(maxDim))
        localReads.set(
          maxDim,
          (async () => {
            if (local.cog) {
              const raw = await readWindowFromFile(local.cog, { maxDim, bands: [0, 1, 2, 3], overviews: true })
              return { layout: raw, raster: orthoGray(raw) }
            }
            const img = await rasterize(local.previewUrl, maxDim)
            const sx = local.width / img.width,
              sy = local.height / img.height
            const raster = grayRaster(
              img.data.filter((_, i) => i % 4 === 0),
              img.width,
              img.height,
              (i) => img.data[i * 4 + 3] > 0,
            )
            return { layout: { scaleX: sx, scaleY: sy, centreX0: sx / 2, centreY0: sy / 2 }, raster }
          })(),
        )
      return localReads.get(maxDim)
    }
    const learnedCache = new Map()
    const cached = (key, make) => {
      if (!learnedCache.has(key)) learnedCache.set(key, make())
      return learnedCache.get(key)
    }
    const onLog = (m, level = 'debug') => emit?.('log', [m, level, 'Find GCPs'])
    // One learned look at a reference rect under a hypothesis { scale, rotationDeg }
    // → the same shape as look(), or null.
    async function learnedLook(rect, { scale, rotationDeg }) {
      const { refMaxDim, localMaxDim } = lookSizes({
        rect,
        scale,
        localWidth: local.width,
        localHeight: local.height,
        maxDim: LEARNED_DIM,
      })
      const r = await cached(`r:${rect.col},${rect.row},${rect.width},${rect.height}:${refMaxDim}`, async () => {
        const raw = await readWindowFromFile(reference.file, {
          rect,
          maxDim: refMaxDim,
          bands: refBands,
          overviews: true,
        })
        const ref = referenceGray(raw)
        return ref.coverage < 0.02 ? null : { raw, ref, f: await learnedFeatures(spec, ref, 0, onLog) }
      })
      if (!r || r.f.points.length < 8) return null
      const l = await cached(`l:${localMaxDim}:${rotationDeg}`, async () => {
        const { layout, raster } = await localAt(localMaxDim)
        return { layout, f: await learnedFeatures(spec, raster, rotationDeg, onLog) }
      })
      if (l.f.points.length < 8) return null
      const { matches } = await matchLightGlue({
        kpsA: l.f.kps,
        descA: l.f.descriptors,
        wA: l.f.width,
        hA: l.f.height,
        kpsB: r.f.kps,
        descB: r.f.descriptors,
        wB: r.f.width,
        hB: r.f.height,
        modelId: spec.matcherModelId,
        maxKeypoints: LIGHTGLUE_KEYPOINTS,
        onLog,
      })
      if (matches.length < 8) return null
      const A = matches.map((m) => l.f.points[m.ia]),
        B = matches.map((m) => r.f.points[m.ib])
      const fit = estimateHomographyRansac(A, B, { threshPx: 3, iters: 5000 })
      if (!fit || fit.inlierCount < LEARNED_MIN_INLIERS) return fit ? { inliers: fit.inlierCount } : null
      const raw = r.raw,
        s = (raw.scaleX + raw.scaleY) / 2
      return {
        H: homographyToNative(fit.H, l.layout, raw),
        raw,
        ref: r.ref,
        rect: {
          col: raw.window[0],
          row: raw.window[1],
          width: raw.window[2] - raw.window[0],
          height: raw.window[3] - raw.window[1],
        },
        inliers: fit.inlierCount,
        ratio: fit.inlierCount / matches.length,
        p95: fit.p95ErrPx * s,
        refPerWorking: s,
        matches: A.flatMap((a, k) => (fit.inlierMask[k] ? [{ a: toNative(l.layout, a), b: toNative(raw, B[k]) }] : [])),
        rotationDeg,
        scale,
      }
    }
    // The hypothesis a known native homography implies at the orthophoto's centre.
    const hypothesisOf = (H) => ({
      scale: homographyScale(H, local.width / 2, local.height / 2),
      rotationDeg: Math.round(homographyRotation(H, local.width / 2, local.height / 2)),
    })
    const lookAt = (rect, H) => (spec ? learnedLook(rect, hypothesisOf(H)) : look(rect))

    const full = { col: 0, row: 0, width: reference.width, height: reference.height }
    let region = reference.region ?? full
    let coarse = null,
      searched = 0
    if (spec) {
      // A prior (orthophoto native px → reference native px) narrows the area to its
      // predicted footprint, padded by a quarter and three times its own misfit.
      if (prior) {
        const H = similarityHomography(prior)
        const corners = [
          [0, 0],
          [local.width, 0],
          [local.width, local.height],
          [0, local.height],
        ].map(([x, y]) => applyHomography(H, x, y))
        region =
          paddedRect(corners, reference.width, reference.height, { pad: 0.25, minPad: 3 * prior.rms + 64 }) ?? region
        log(
          `Prior from ${prior.source}: rotation ${prior.rotationDeg.toFixed(0)}°, ${prior.scale.toPrecision(3)} reference px per orthophoto px, misfit ${prior.rms.toFixed(0)} reference px`,
        )
      }
      let best = null
      const search = async (area, hypotheses) => {
        for (const hyp of hypotheses) {
          searched++
          const hit = await learnedLook(area, hyp)
          onLog(
            `Coarse look ${searched} (${hyp.stage}): rotation ${hyp.rotationDeg.toFixed(0)}°, scale ${hyp.scale.toPrecision(3)} → ${hit?.inliers ?? 0} inliers`,
          )
          if (hit?.H) return hit
        }
        return null
      }
      if (prior) best = await search(region, coarseHypotheses({ prior }))
      if (!best) {
        // No prior, or a wrong one: the search area and the orthophoto read at the same size.
        if (prior) log(`No alignment around the prior from ${prior.source}; sweeping scales and rotations`)
        region = reference.region ?? full
        const guessScale = Math.max(region.width, region.height) / Math.max(local.width, local.height)
        best = await search(region, coarseHypotheses({ guessScale }))
      }
      if (best) {
        // Neighbouring rotations of a hit, as hist-sfm refines its sweep.
        for (const rotationDeg of refineRotations(best.rotationDeg)) {
          searched++
          const hit = await learnedLook(region, { scale: best.scale, rotationDeg })
          if (hit?.H && hit.inliers > best.inliers) best = hit
        }
        log(
          `Learned coarse look: ${best.inliers} inliers at rotation ${best.rotationDeg.toFixed(0)}° after ${pluralize(searched, 'look')}`,
        )
      }
      coarse = best
    }
    for (let level = 1; level <= 3 && !coarse && !spec; level++) {
      // A finer subdivision only pays while the region is read downsampled.
      if (level > 1 && Math.max(region.width, region.height) * SEARCH_LEVELS[level].size < COARSE_DIM * 0.8) break
      for (const w of searchWindows(region, level)) {
        searched++
        const hit = await look(w)
        if (hit && (!coarse || hit.inliers > coarse.inliers)) coarse = hit
      }
      if (!coarse) log(`No alignment in ${pluralize(searched, 'search window')} at level ${level}`)
    }
    if (!coarse)
      throw new Error(
        `No reliable ortho alignment found in ${pluralize(searched, 'search window')}` +
          `${reference.region ? ' around the expected footprint' : ''}. Try another reference band or a reference covering the same area; use manual control if the scene has changed substantially.`,
      )
    const levels = [{ rect: coarse.rect, inliers: coarse.inliers, p95: coarse.p95 }]
    for (let k = 0; k < 2; k++) {
      const next = footprintRect(coarse.H, local.width, local.height, reference.width, reference.height)
      if (
        !next ||
        next.width * next.height > 0.5 * coarse.rect.width * coarse.rect.height ||
        coarse.refPerWorking < 1.2
      )
        break
      const hit = await lookAt(next, coarse.H)
      if (!hit?.H) break
      coarse = hit
      levels.push({ rect: hit.rect, inliers: hit.inliers, p95: hit.p95 })
    }
    log(
      `Coarse alignment: ${coarse.inliers} inliers, p95 ${coarse.p95.toFixed(1)} reference px, after ${pluralize(levels.length, 'look')}`,
    )

    // Fine tiles.
    const scale = homographyScale(coarse.H, local.width / 2, local.height / 2)
    const tiles = [],
      matches = []
    let kl = 1,
      kr = coarse.refPerWorking
    if (local.cog) {
      const plan = fineTiles({
        H: coarse.H,
        localWidth: local.width,
        localHeight: local.height,
        refWidth: reference.width,
        refHeight: reference.height,
        scale,
        margin: Math.max(32, Math.ceil((3 * coarse.p95) / (scale < 1 ? 1 : scale))),
        covered,
      })
      kl = plan.kl
      kr = plan.kr
      // Learned tiles: the orthophoto tile turned to the coarse rotation, as in the
      // coarse look (SIFT matched none of Rachel's tiles film to satellite).
      const turn = hypothesisOf(coarse.H).rotationDeg
      const learnedPairs = async (lg, rg) => {
        const fl = await learnedFeatures(spec, lg, turn, onLog),
          fr = await learnedFeatures(spec, rg, 0, onLog)
        if (fl.points.length < 8 || fr.points.length < 8) return []
        const { matches: m } = await matchLightGlue({
          kpsA: fl.kps,
          descA: fl.descriptors,
          wA: fl.width,
          hA: fl.height,
          kpsB: fr.kps,
          descB: fr.descriptors,
          wB: fr.width,
          hB: fr.height,
          modelId: spec.matcherModelId,
          maxKeypoints: LIGHTGLUE_KEYPOINTS,
          onLog,
        })
        return m.map(({ ia, ib }) => [fl.points[ia], fr.points[ib]])
      }
      const gate = Math.max(32 * kr, 3 * coarse.p95)
      for (const t of plan.tiles) {
        const lraw = await readWindowFromFile(local.cog, {
          rect: t.local,
          maxDim: Math.min(4096, t.localMaxDim),
          bands: [0, 1, 2, 3],
          overviews: true,
        })
        const rraw = await readWindowFromFile(reference.file, {
          rect: t.reference,
          maxDim: Math.min(4096, t.refMaxDim),
          bands: refBands,
          overviews: true,
        })
        const lg = orthoGray(lraw),
          rg = referenceGray(rraw)
        const p = (
          spec ? await learnedPairs(lg, rg) : await pairs(await features(lg, 2000), await features(rg, 2000), 0.8)
        )
          .map(([a, b]) => [toNative(lraw, a), toNative(rraw, b)])
          .filter(([a, b]) => {
            const q = applyHomography(coarse.H, ...a)
            return Math.hypot(q[0] - b[0], q[1] - b[1]) <= gate
          })
        const fit =
          p.length >= 10
            ? estimateHomographyRansac(
                p.map((q) => q[0]),
                p.map((q) => q[1]),
                { threshPx: 2 * kr, iters: 1000 },
              )
            : null
        if (
          !acceptTile(
            fit,
            p.map((q) => q[0]),
            { tileSize: Math.min(t.local.width, t.local.height) },
          )
        )
          continue
        const index = tiles.length,
          inl = p.filter((_, k) => fit.inlierMask[k])
        const [localPng, refPng] = await Promise.all([
          rasterToPng(lg.data, lg.width, lg.height),
          rasterToPng(rg.data, rg.width, rg.height),
        ])
        tiles.push({
          H: fit.H,
          inliers: fit.inlierCount,
          ratio: fit.inlierCount / p.length,
          local: t.local,
          reference: t.reference,
          localImage: { blob: localPng, ...imagePlacement(lraw) },
          referenceImage: { blob: refPng, ...imagePlacement(rraw) },
        })
        for (const [a, b] of inl) {
          const q = applyHomography(fit.H, ...a)
          matches.push({ a, b, tile: index, residual: Math.hypot(q[0] - b[0], q[1] - b[1]) / kr })
        }
      }
      log(
        `Fine pass: ${tiles.length}/${plan.tiles.length} tiles aligned, ${matches.length} matches at ${kr.toFixed(2)} reference px per working px`,
      )
    }
    let fine = null
    if (matches.length >= 8) {
      const fit = estimateHomographyRansac(
        matches.map((m) => m.a),
        matches.map((m) => m.b),
        { threshPx: 3 * kr, iters: 1500 },
      )
      if (fit) fine = { H: fit.H, inliers: fit.inlierCount, p95: fit.p95ErrPx / kr }
    } else {
      // Coarse only: no stored COG, or no tile aligned. The coarse matches stand in,
      // each on the one coarse model.
      tiles.length = 0
      matches.length = 0
      tiles.push({ H: coarse.H, inliers: coarse.inliers, ratio: coarse.ratio, local: null, reference: null })
      kl = local.width / localRaster.width
      kr = coarse.refPerWorking
      for (const m of coarse.matches) {
        const q = applyHomography(coarse.H, ...m.a)
        matches.push({ ...m, tile: 0, residual: Math.hypot(q[0] - m.b[0], q[1] - m.b[1]) / kr })
      }
    }
    return {
      result: {
        H: fine?.H ?? coarse.H,
        matches,
        tiles,
        kl,
        kr,
        refined: !!fine,
        coarse: { inliers: coarse.inliers, p95: coarse.p95 / coarse.refPerWorking, looks: levels, searched },
        fine: fine && { inliers: fine.inliers, p95: fine.p95 },
        referencePreview: {
          url: await rasterToDataUrl(coarse.ref.data, coarse.ref.width, coarse.ref.height),
          ...imagePlacement(coarse.raw),
        },
      },
    }
  }
  // Coarse matcher ▸ Terrain: the sparse points (orthophoto frame, Float64Array xyz)
  // aligned to the reference DEM by ICP from `initial` (core/sfm/terrainControl.js
  // terrainInitial), its height offset set from the DEM first. → { transform, rms,
  // inlierFraction, passes, positions (DEM CRS), residual (m, point − DEM, NaN off
  // it), pixel (m), referencePreview (hillshade) }.
  async function alignTerrain([{ points, dem, initial, misfit = 0 }], { emit }) {
    const log = (m, level = 'info') => emit?.('log', [m, level, 'Find GCPs'])
    const n = points.length / 3,
      g = dem.geoTransform
    const at = (tf, i) => applyTransform(tf, [points[3 * i], points[3 * i + 1], points[3 * i + 2]])
    // The DEM window the prior predicts, padded by 3 km and three times its misfit.
    const px = []
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4000))) {
      const [x, y] = at(initial, i)
      px.push([(x - g.originX) / g.scaleX, (y - g.originY) / g.scaleY])
    }
    const pad = (3000 + 3 * misfit) / Math.abs(g.scaleX)
    const rect = paddedRect(px, dem.width, dem.height, { pad: 0, minPad: pad })
    if (!rect) throw new Error('The reference DEM does not cover the expected position of the block')
    const raw = await readWindowFromFile(dem.file, { rect, maxDim: 2048, bands: [0], overviews: true })
    const z = raw.channels[0],
      W = raw.width,
      H = raw.height
    const ok = (v) => Number.isFinite(v) && v !== raw.nodata && v > -1e4
    const c0 = raw.centreX0 ?? raw.col + 0.5,
      r0 = raw.centreY0 ?? raw.row + 0.5
    const stepX = raw.scaleX * Math.abs(g.scaleX),
      stepY = raw.scaleY * Math.abs(g.scaleY)
    // DEM height at a CRS point (nearest sample), NaN off the window or on nodata.
    const heightAt = (x, y) => {
      const j = Math.round(((x - g.originX) / g.scaleX - c0) / raw.scaleX),
        k = Math.round(((y - g.originY) / g.scaleY - r0) / raw.scaleY)
      if (j < 0 || k < 0 || j >= W || k >= H) return NaN
      const v = z[k * W + j]
      return ok(v) ? v : NaN
    }
    const tf0 = { ...initial, t: [...initial.t] }
    const dz = median(
      Array.from({ length: n }, (_, i) => {
        const p = at(tf0, i)
        return heightAt(p[0], p[1]) - p[2]
      }),
    )
    if (!Number.isFinite(dz)) throw new Error('No sparse point falls on the reference DEM at the expected position')
    tf0.t[2] += dz
    // The reference: every valid DEM sample, with its surface normal.
    const pos = [],
      nrm = []
    for (let k = 1; k < H - 1; k++)
      for (let j = 1; j < W - 1; j++) {
        const i = k * W + j
        if (!ok(z[i]) || !ok(z[i - 1]) || !ok(z[i + 1]) || !ok(z[i - W]) || !ok(z[i + W])) continue
        const gx = (z[i + 1] - z[i - 1]) / (2 * stepX),
          gy = (z[i - W] - z[i + W]) / (2 * stepY) // rows run south
        const l = Math.hypot(gx, gy, 1)
        pos.push(g.originX + (c0 + j * raw.scaleX) * g.scaleX, g.originY + (r0 + k * raw.scaleY) * g.scaleY, z[i])
        nrm.push(-gx / l, -gy / l, 1 / l)
      }
    const reference = { count: pos.length / 3, pos: new Float64Array(pos), nrm: new Float32Array(nrm) }
    log(
      `Terrain: ${pluralize(n, 'sparse point')} against ${pluralize(reference.count, 'DEM sample')} at ${stepX.toFixed(0)} m; height offset ${dz.toFixed(0)} m`,
    )
    let tf = tf0,
      last = null
    const passes = []
    for (const pass of terrainPasses(misfit)) {
      last = icpAlign(
        { count: n, pos: points },
        reference,
        { ...pass, estimateScale: true, initial: tf, maxIterations: 60, trim: 0.8, sampleCount: 40000 },
        (m, level) => log(m, level === 'warn' ? 'warn' : 'debug'),
      )
      tf = last.transform
      passes.push({ ...pass, rms: last.rms, inliers: last.inlierFraction, iterations: last.iterations })
      log(
        `Terrain ICP ≤ ${pass.maxDistance} m (${pass.pointToPlane ? 'point-to-plane' : 'point-to-point'}): RMS ${last.rms.toFixed(1)} m, ${(100 * last.inlierFraction).toFixed(0)} % in range`,
      )
    }
    const positions = new Float64Array(3 * n),
      residual = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const p = at(tf, i)
      positions.set(p, 3 * i)
      residual[i] = p[2] - heightAt(p[0], p[1])
    }
    // A hillshade of the window as the dialog's reference overview.
    const shade = new Uint8ClampedArray(W * H * 4)
    const sun = [-Math.SQRT1_2 * Math.SQRT1_2, Math.SQRT1_2 * Math.SQRT1_2, Math.SQRT1_2] // NW, 45° up
    for (let k = 0; k < H; k++)
      for (let j = 0; j < W; j++) {
        const i = k * W + j
        let v = 128
        if (j > 0 && k > 0 && j < W - 1 && k < H - 1 && ok(z[i - 1]) && ok(z[i + 1]) && ok(z[i - W]) && ok(z[i + W])) {
          const gx = (z[i + 1] - z[i - 1]) / (2 * stepX),
            gy = (z[i - W] - z[i + W]) / (2 * stepY)
          const l = Math.hypot(gx, gy, 1)
          v = 255 * Math.max(0, (-gx * sun[0] - gy * sun[1] + sun[2]) / l)
        }
        shade[i * 4] = shade[i * 4 + 1] = shade[i * 4 + 2] = v
        shade[i * 4 + 3] = 255
      }
    return {
      result: {
        transform: tf,
        rms: last.rms,
        inlierFraction: last.inlierFraction,
        passes,
        dz,
        positions,
        residual,
        pixel: Math.abs(g.scaleX),
        referencePreview: { url: await rasterToDataUrl(shade, W, H), ...imagePlacement(raw) },
      },
      transfer: [positions.buffer, residual.buffer],
    }
  }
  return { findReferenceMatches, alignTerrain }
}

// Where a read's image sits in native pixel-edge coordinates (for an SVG <image>).
function imagePlacement(raw) {
  const cx = raw.centreX0 ?? raw.col + 0.5,
    cy = raw.centreY0 ?? raw.row + 0.5
  return {
    x: cx - raw.scaleX / 2,
    y: cy - raw.scaleY / 2,
    width: raw.width * raw.scaleX,
    height: raw.height * raw.scaleY,
    pixelWidth: raw.width,
    pixelHeight: raw.height,
  }
}

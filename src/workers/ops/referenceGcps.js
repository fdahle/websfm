import { detectSift } from '../../core/features/sift.js'
import { matchDescriptors } from '../../core/features/bruteforce.js'
import { estimateHomographyRansac } from '../../core/features/guidedTiles.js'
import { percentileRange, stretchTo255 } from '../../core/io/rasterStyle.js'
import { rasterToDataUrl } from '../rasterPreview.js'

export function makeReferenceGcpOps({ rasterize }) {
  async function features(raster) {
    const { flat } = await detectSift(raster.data, raster.width, raster.height, { maxKeypoints: 4000, contrastThreshold: 0.01 })
    const count = Math.max(0, Math.floor((flat.length - 2) / 133)), points = [], descriptors = new Float32Array(count * 128)
    for (let i = 0; i < count; i++) {
      points.push([flat[i * 133], flat[i * 133 + 1]])
      descriptors.set(flat.subarray(i * 133 + 5, i * 133 + 133), i * 128)
    }
    return { points, descriptors }
  }
  async function findReferenceMatches([url, reference]) {
    const local = await rasterize(url, 1536)
    const { width, height, channels: [band], nodata } = reference
    const sample = []
    for (let i = 0, step = Math.max(1, Math.ceil(band.length / 10000)); i < band.length; i += step)
      if (band[i] !== nodata) sample.push(band[i])
    const range = percentileRange(sample, 2, 98)
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < band.length; i++) {
      if (!Number.isFinite(band[i]) || band[i] === nodata) continue
      const v = stretchTo255(band[i], range), o = i * 4
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255
    }
    const a = await features(local), b = await features({ data, width, height })
    const { matches } = await matchDescriptors(a.descriptors, b.descriptors, { ratioThreshold: 0.7, crossCheck: true })
    const pairs = matches.filter(m => {
      const p = a.points[m.ia], q = b.points[m.ib]
      return local.data[(Math.floor(p[1]) * local.width + Math.floor(p[0])) * 4 + 3] > 0
        && data[(Math.floor(q[1]) * width + Math.floor(q[0])) * 4 + 3] > 0
    }).map(m => ({ a: a.points[m.ia], b: b.points[m.ib] }))
    const fit = estimateHomographyRansac(pairs.map(p => p.a), pairs.map(p => p.b), { threshPx: 3, iters: 1500 })
    if (!fit || fit.inlierCount < 8 || fit.inlierCount / Math.max(1, pairs.length) < 0.25)
      throw new Error('No reliable ortho alignment found. Try another reference band or a reference covering the same area; use manual control if the scene has changed substantially.')
    return { result: { H: fit.H, matches: pairs.filter((_, i) => fit.inlierMask[i]), inliers: fit.inlierCount,
      p95: fit.p95ErrPx, localWidth: local.width, localHeight: local.height,
      referencePreview: await rasterToDataUrl(data, width, height) } }
  }
  return { findReferenceMatches }
}

import { describe, it, expect } from 'vitest'
import { writeArrayBuffer } from 'geotiff'
import { buildPyramidFromTiff, openPyramid, readLevelRect, readNativeRect, isPyramid } from '../workers/rasterSource.js'
import { halveRows } from '../core/io/rasterPyramid.js'

// A deterministic gray / RGB test image as a baseline TIFF (geotiff's writer).
function testImage(W, H, spp) {
  const px = new Uint8Array(W * H * spp)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < spp; c++) {
        px[(y * W + x) * spp + c] = (x * 7 + y * 13 + c * 50 + ((x * y) >> 4)) & 255
      }
  const buf = writeArrayBuffer(px, {
    width: W,
    height: H,
    SamplesPerPixel: spp,
    BitsPerSample: Array(spp).fill(8),
    PhotometricInterpretation: spp === 1 ? 1 : 2,
    PlanarConfiguration: 1,
  })
  return { px, blob: new Blob([buf]) }
}

describe('buildPyramidFromTiff → readLevelRect', () => {
  it('stores level 0 exactly and every level as the 2×2 box cascade (gray)', async () => {
    const W = 301,
      H = 177
    const { px, blob } = testImage(W, H, 1)
    const desc = await buildPyramidFromTiff(blob, { tileSize: 64, minLong: 40, previews: false })
    expect(isPyramid(desc)).toBe(true)
    expect(desc.index).toMatchObject({ width: W, height: H, channels: 1, tileSize: 64 })
    const src = await openPyramid(desc)
    // A rect across tile seams, level 0: the source pixels, gray in R = G = B.
    const r = readNativeRect(src, { x0: 50, y0: 40, x1: 190, y1: 140 })
    expect([r.width, r.height]).toEqual([140, 100])
    for (const [x, y] of [
      [0, 0],
      [13, 23],
      [139, 99],
      [77, 24],
    ]) {
      const v = px[(40 + y) * W + 50 + x]
      expect([...r.data.subarray((y * 140 + x) * 4, (y * 140 + x) * 4 + 4)]).toEqual([v, v, v, 255])
    }
    // Level 2 equals halving twice.
    let want = px,
      w = W,
      h = H
    for (let k = 0; k < 2; k++) {
      want = halveRows(want, w, h, 1)
      w = Math.ceil(w / 2)
      h = Math.ceil(h / 2)
    }
    const L2 = readLevelRect(src, 2, { x0: 0, y0: 0, x1: w, y1: h })
    expect([L2.width, L2.height]).toEqual([w, h])
    for (let i = 0; i < w * h; i += 97) expect(L2.data[i * 4]).toBe(want[i])
  })

  it('builds a one-channel pyramid from a gray scan that is not 8/16-bit (readRGB path)', async () => {
    const W = 90,
      H = 50
    for (const [bps, fmt, Arr, at] of [
      [32, 3, Float32Array, (i) => (i % 97) / 97],
      [4, 1, Uint8Array, (i) => i % 16],
    ]) {
      const px = Arr.from({ length: W * H }, (_, i) => at(i))
      const buf = writeArrayBuffer(px, {
        width: W,
        height: H,
        SamplesPerPixel: 1,
        BitsPerSample: [bps],
        SampleFormat: [fmt],
        PhotometricInterpretation: 1,
        PlanarConfiguration: 1,
      })
      const desc = await buildPyramidFromTiff(new Blob([buf]), { tileSize: 32, minLong: 20, previews: false })
      expect(desc.index.channels).toBe(1)
      const src = await openPyramid(desc)
      const r = readNativeRect(src, { x0: 0, y0: 0, x1: W, y1: H })
      expect([r.width, r.height]).toEqual([W, H])
      // Gray in R = G = B, opaque.
      for (const i of [0, 33, W * H - 1]) {
        expect(r.data[i * 4]).toBe(r.data[i * 4 + 1])
        expect(r.data[i * 4 + 3]).toBe(255)
      }
    }
  })

  it('keeps RGB channels and clips a rect at the image edge', async () => {
    const W = 130,
      H = 70
    const { px, blob } = testImage(W, H, 3)
    const src = await openPyramid(await buildPyramidFromTiff(blob, { tileSize: 32, previews: false }))
    expect(src.index.channels).toBe(3)
    const r = readNativeRect(src, { x0: 120, y0: 60, x1: 200, y1: 99 })
    expect([r.width, r.height]).toEqual([10, 10])
    const i = (69 * W + 129) * 3
    expect([...r.data.subarray((9 * 10 + 9) * 4, (9 * 10 + 9) * 4 + 3)]).toEqual([px[i], px[i + 1], px[i + 2]])
  })
})

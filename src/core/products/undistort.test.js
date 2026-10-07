import { describe, it, expect } from 'vitest'
import {
  sampleRgbaBilinear, resampleRgba, resampleMaskLut, pinholeFrameSize,
  validSampleRect, cropRgba, shiftPrincipalPoint,
} from './undistort.js'
import { makeSampleMap } from '../sfm/displayFrame.js'
import { toScaledPx, fromScaledPx } from '../sfm/geometry.js'
import { undistortPixel } from '../sfm/distortion.js'

const K = { fx: 800, fy: 800, cx: 320, cy: 240 }

// A synthetic RGBA raster whose red channel encodes x and green encodes y, so a
// resampled pixel reports exactly which source pixel it came from.
function rampRaster(w, h) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = (v * w + u) * 4
      data[i] = u; data[i + 1] = v; data[i + 2] = 0; data[i + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

describe('sampleRgbaBilinear', () => {
  it('interpolates between neighbours and clamps outside the raster', () => {
    const r = rampRaster(4, 4)
    const out = new Uint8ClampedArray(4)
    sampleRgbaBilinear(r.data, 4, 4, 1.5, 2, out, 0)
    expect(out[0]).toBe(2)          // (1+2)/2 rounded by the clamped array
    expect(out[1]).toBe(2)
    // Far outside → the corner pixel, never a wrap-around.
    sampleRgbaBilinear(r.data, 4, 4, -50, -50, out, 0)
    expect(out[0]).toBe(0); expect(out[1]).toBe(0)
    sampleRgbaBilinear(r.data, 4, 4, 999, 999, out, 0)
    expect(out[0]).toBe(3); expect(out[1]).toBe(3)
  })
})

describe('resampleRgba', () => {
  it('returns the source untouched for an identity map at the same size', () => {
    const r = rampRaster(8, 8)
    expect(resampleRgba(r, null, 8, 8)).toBe(r.data)
  })

  it('follows the map output → source', () => {
    const r = rampRaster(8, 8)
    // Shift by (+2,+1): output (u,v) reads source (u+2, v+1).
    const out = resampleRgba(r, (u, v) => ({ x: u + 2, y: v + 1 }), 4, 4)
    const at = (u, v) => [out[(v * 4 + u) * 4], out[(v * 4 + u) * 4 + 1]]
    expect(at(0, 0)).toEqual([2, 1])
    expect(at(3, 3)).toEqual([5, 4])
  })
})

describe('undistort round-trip', () => {
  // The whole point of the module: sampling the distorted raster through the
  // forward map must land back on the pixel the pipeline undistorted the
  // keypoint to. Distort-then-undistort is the same inverse pair the ingest fold
  // uses, so agreement here is agreement with the sparse model's frame.
  it('the sample map is the inverse of undistortPixel to sub-0.1px', () => {
    const dist = { k1: -0.12, k2: 0.03, k3: 0, p1: 0, p2: 0 }
    const map = makeSampleMap({ K, dist })
    let worst = 0
    for (let v = 0; v < 480; v += 37) {
      for (let u = 0; u < 640; u += 41) {
        const d = map(u, v)                       // ideal → distorted
        const back = undistortPixel(d.x, d.y, K, dist) // distorted → ideal
        worst = Math.max(worst, Math.hypot(back.x - u, back.y - v))
      }
    }
    expect(worst).toBeLessThan(0.1)
  })

  it('leaves the principal point fixed', () => {
    const map = makeSampleMap({ K, dist: { k1: -0.2, k2: 0, k3: 0, p1: 0, p2: 0 } })
    const c = map(K.cx, K.cy)
    expect(Math.hypot(c.x - K.cx, c.y - K.cy)).toBeLessThan(1e-9)
  })

  it('is the identity map (null) when there is nothing to remove', () => {
    expect(makeSampleMap({ K, dist: null, selfCal: null })).toBe(null)
    expect(makeSampleMap({ K, dist: { k1: 0, k2: 0, k3: 0 } })).toBe(null)
  })
})

describe('makeSampleMap scaling', () => {
  it('a scaled output grid equals scaling the full-resolution result', () => {
    const dist = { k1: -0.1, k2: 0, k3: 0, p1: 0, p2: 0 }
    const full = makeSampleMap({ K, dist })
    const half = makeSampleMap({ K, dist, outScale: 0.5, srcScale: 0.5 })
    // Centre-aligned grids (geometry.js toScaledPx): half-grid pixel u is native
    // (u + ½)/0.5 − ½, and the result goes back the same way.
    for (const [u, v] of [[10, 10], [100, 60], [300, 200]]) {
      const a = full(fromScaledPx(u, 0.5), fromScaledPx(v, 0.5))
      const b = half(u, v)
      expect(Math.abs(b.x - toScaledPx(a.x, 0.5))).toBeLessThan(1e-6)
      expect(Math.abs(b.y - toScaledPx(a.y, 0.5))).toBeLessThan(1e-6)
    }
  })

  it('a pure scale change is still a real map, not null', () => {
    expect(makeSampleMap({ K, outScale: 0.5, srcScale: 0.5 })).not.toBe(null)
  })
})

describe('pinholeFrameSize', () => {
  it('uses the native image size for a normal camera', () => {
    expect(pinholeFrameSize({ meta: { width: 6000, height: 4000 } }))
      .toEqual({ width: 6000, height: 4000 })
  })

  it('uses the canonical frame for a film scan, not the scan size', () => {
    const fiducial = { frame: { width: 9200, height: 9200 }, A: null }
    expect(pinholeFrameSize({ meta: { width: 20000, height: 19000 }, fiducial }))
      .toEqual({ width: 9200, height: 9200 })
  })

  it('scales the grid down for a reduced-resolution run', () => {
    expect(pinholeFrameSize({ meta: { width: 1000, height: 500 }, scale: 0.25 }))
      .toEqual({ width: 250, height: 125 })
  })
})

describe('validSampleRect', () => {
  it('is the whole frame for an identity map', () => {
    expect(validSampleRect(null, 10, 8, 10, 8)).toEqual({ x: 0, y: 0, width: 10, height: 8 })
  })

  it('insets by the margin a shifted map pushes out of bounds', () => {
    // Output (u,v) samples (u−2, v−1): the first two columns and first row fall
    // outside the source, and the last column/row of the source is unreachable.
    const rect = validSampleRect((u, v) => ({ x: u - 2, y: v - 1 }), 10, 8, 10, 8)
    expect(rect).toEqual({ x: 2, y: 1, width: 8, height: 7 })
  })

  it('leaves barrel distortion uncropped — its map samples inward', () => {
    // k1 < 0 shrinks the sampled radius, so every output pixel reads a source
    // pixel closer to the centre and nothing falls outside. Undistorting barrel
    // expands the image; it is pincushion that costs you a border.
    const map = makeSampleMap({ K, dist: { k1: -0.25, k2: 0, k3: 0, p1: 0, p2: 0 } })
    expect(validSampleRect(map, 640, 480, 640, 480))
      .toEqual({ x: 0, y: 0, width: 640, height: 480 })
  })

  it('crops pincushion distortion to an inscribed rectangle strictly inside the frame', () => {
    const dist = { k1: 0.15, k2: 0, k3: 0, p1: 0, p2: 0 }
    const map = makeSampleMap({ K, dist })
    const rect = validSampleRect(map, 640, 480, 640, 480)
    expect(rect).not.toBe(null)
    expect(rect.x).toBeGreaterThan(0)
    expect(rect.y).toBeGreaterThan(0)
    expect(rect.x + rect.width).toBeLessThan(640)
    expect(rect.y + rect.height).toBeLessThan(480)
    // Every pixel of the reported rect really is in bounds.
    for (let v = rect.y; v < rect.y + rect.height; v += 7) {
      for (let u = rect.x; u < rect.x + rect.width; u += 7) {
        const s = map(u, v)
        expect(s.x).toBeGreaterThanOrEqual(0)
        expect(s.y).toBeGreaterThanOrEqual(0)
        expect(s.x).toBeLessThanOrEqual(639)
        expect(s.y).toBeLessThanOrEqual(479)
      }
    }
  })

  it('returns null when nothing maps inside', () => {
    expect(validSampleRect(() => ({ x: -1000, y: -1000 }), 8, 8, 8, 8)).toBe(null)
  })
})

describe('cropRgba + shiftPrincipalPoint', () => {
  it('cuts the rect and moves the principal point with the origin', () => {
    const r = rampRaster(8, 8)
    const rect = { x: 2, y: 3, width: 4, height: 2 }
    const out = cropRgba(r.data, 8, 8, rect)
    expect(out.length).toBe(4 * 2 * 4)
    expect([out[0], out[1]]).toEqual([2, 3])           // top-left is source (2,3)
    const k2 = shiftPrincipalPoint(K, rect)
    expect(k2).toEqual({ fx: 800, fy: 800, cx: 318, cy: 237 })
  })

  it('returns the buffer untouched for a full-frame rect', () => {
    const r = rampRaster(4, 4)
    expect(cropRgba(r.data, 4, 4, { x: 0, y: 0, width: 4, height: 4 })).toBe(r.data)
  })
})

describe('resampleMaskLut', () => {
  it('keeps mask values boolean under the same map', () => {
    const lut = new Uint8Array(16)
    lut[2 * 4 + 2] = 1
    const out = resampleMaskLut(lut, 4, 4, (u, v) => ({ x: u + 1, y: v + 1 }), 4, 4)
    expect(out[1 * 4 + 1]).toBe(1)
    expect([...out].every((x) => x === 0 || x === 1)).toBe(true)
  })
})

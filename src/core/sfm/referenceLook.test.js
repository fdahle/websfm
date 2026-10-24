import { describe, expect, it } from 'vitest'
import {
  fitSimilarity2d,
  similarityHomography,
  homographyRotation,
  coarseHypotheses,
  refineRotations,
  rotateGray,
  lookSizes,
  ROTATION_STEP_DEG,
  SCALE_STEPS,
} from './referenceLook.js'

describe('fitSimilarity2d', () => {
  it('recovers a similarity and drops a far outlier', () => {
    const s = 0.4,
      th = (200 * Math.PI) / 180
    const map = ([x, y]) => [
      s * (Math.cos(th) * x - Math.sin(th) * y) + 1800,
      s * (Math.sin(th) * x + Math.cos(th) * y) + 900,
    ]
    const pairs = [
      [0, 0],
      [3000, 0],
      [0, 2800],
      [3000, 2800],
      [1500, 1400],
      [700, 2100],
    ].map((p, i) => {
      const q = map(p)
      return { p, q: i === 5 ? [q[0] + 900, q[1]] : [q[0] + (i % 2 ? 2 : -2), q[1]] } // the 6th is a wrong footprint
    })
    const m = fitSimilarity2d(pairs)
    expect(m.used).toBe(5)
    expect(m.scale).toBeCloseTo(0.4, 2)
    expect(m.rotationDeg).toBeCloseTo(200, 1)
    expect(m.rms).toBeLessThan(3)
    // The homography form agrees on the rotation.
    expect(homographyRotation(similarityHomography(m), 1500, 1400)).toBeCloseTo(200, 1)
  })
  it('refuses pairs whose targets do not spread, or fit worse than a third of it', () => {
    const p = [
      [0, 0],
      [100, 0],
      [0, 100],
      [100, 100],
    ]
    // Every photo's GPS field holds the same point.
    expect(fitSimilarity2d(p.map((x) => ({ p: x, q: [500, 500] })))).toBeNull()
    // Targets scattered with no relation to the sources.
    const q = [
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 0],
    ]
    expect(fitSimilarity2d(p.map((x, i) => ({ p: x, q: q[i] })))).toBeNull()
  })
  it('needs three usable pairs', () => {
    expect(
      fitSimilarity2d([
        { p: [0, 0], q: [1, 1] },
        { p: [1, 0], q: [2, 1] },
      ]),
    ).toBeNull()
    expect(
      fitSimilarity2d([
        { p: [0, 0], q: [1, 1] },
        { p: [1, 0], q: [2, 1] },
        { p: [NaN, 0], q: [2, 2] },
      ]),
    ).toBeNull()
  })
})

describe('coarseHypotheses', () => {
  it('tries the prior and ±15° first, then the rest of the sweep at its scale', () => {
    const h = coarseHypotheses({ prior: { scale: 0.45, rotationDeg: 199 } })
    expect(h.slice(0, 3).map((x) => x.rotationDeg)).toEqual([199, 214, 184])
    expect(h.every((x) => x.scale === 0.45)).toBe(true)
    expect(h.length).toBe(3 + 360 / ROTATION_STEP_DEG)
  })
  it('sweeps every rotation at each scale step without a prior', () => {
    const h = coarseHypotheses({ guessScale: 2 })
    expect(h.length).toBe(SCALE_STEPS.length * (360 / ROTATION_STEP_DEG))
    expect(h[0]).toMatchObject({ scale: 2, rotationDeg: 0 })
    expect(new Set(h.map((x) => x.scale)).size).toBe(SCALE_STEPS.length)
  })
  it('refines ±10° around a hit', () => {
    expect(refineRotations(355)).toEqual([345, 5])
  })
})

describe('rotateGray', () => {
  it('turns a raster and maps every turned sample back to its source', () => {
    const width = 40,
      height = 20
    const data = new Float32Array(width * height).map((_, i) => (i % width) + 100 * Math.floor(i / width))
    const valid = new Uint8Array(width * height).fill(1)
    const t = rotateGray({ data, valid, width, height }, 90)
    expect([t.width, t.height]).toEqual([20, 40])
    let checked = 0
    for (let y = 0; y < t.height; y++)
      for (let x = 0; x < t.width; x++) {
        if (!t.valid[y * t.width + x]) continue
        const [u, v] = t.toSource(x, y)
        expect(t.data[y * t.width + x]).toBeCloseTo(u + 100 * v, 3)
        checked++
      }
    expect(checked).toBeGreaterThan(600)
    // Clockwise on screen: the source's top-left corner ends up top-right.
    const [u, v] = t.toSource(t.width - 1, 0)
    expect(u).toBeLessThan(2)
    expect(v).toBeLessThan(2)
  })
})

describe('lookSizes', () => {
  it('reads both rasters at the same metres per sample', () => {
    // A 6,000 px reference window; the orthophoto is 3,000 px at 0.45 reference px each.
    const s = lookSizes({
      rect: { width: 6000, height: 5000 },
      scale: 0.45,
      localWidth: 3000,
      localHeight: 2800,
      maxDim: 2000,
    })
    expect(s.refMaxDim).toBe(2000)
    // reference: 3 native px per sample → orthophoto 3 / 0.45 = 6.67 px per sample
    expect(s.localMaxDim).toBe(450)
  })
  it('reads both coarser when the orthophoto would pass its native resolution', () => {
    // 5 reference px per orthophoto px: at native reference resolution the orthophoto
    // would need 5× its own pixels.
    const s = lookSizes({ rect: { width: 1000, height: 1000 }, scale: 5, localWidth: 800, localHeight: 600 })
    expect(s.localMaxDim).toBe(800)
    expect(s.refMaxDim).toBe(Math.round(1000 / 5))
  })
})

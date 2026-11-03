import { describe, it, expect } from 'vitest'
import {
  reflectanceGeometry,
  demHeightAt,
  viewOf,
  radiometryOf,
  blockCaptures,
  renderReflectanceBlock,
  resolveCalibration,
  calibrationFactor,
  nativeGsd,
} from './reflectanceMap.js'

// Nadir cameras over flat ground z = 0 (frame = SfM): x_cam = X − C_x, y_cam = −(Y − C_y),
// z_cam = C_z − Z.
const NADIR = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
]
const photoAt = (C, extra = {}) => ({
  R: NADIR,
  t: [-C[0], C[1], C[2]],
  K: { fx: 100, fy: 100, cx: 49.5, cy: 49.5 },
  width: 100,
  height: 100,
  sampleMap: null,
  ...extra,
})
const dem = { width: 20, height: 10, gsd: 1, originX: 0, originY: 10, data: new Float32Array(200), mask: null }

describe('reflectance geometry', () => {
  it('covers the DEM at the requested cell size and reads its heights', () => {
    expect(reflectanceGeometry(dem, 0.5)).toEqual({ width: 40, height: 20, gsd: 0.5, originX: 0, originY: 10 })
    const sloped = { ...dem, data: Float32Array.from({ length: 200 }, (_, i) => i % 20) }
    // Cell centres sit at x = c + 0.5: x = 3 is halfway between columns 2 and 3.
    expect(demHeightAt(sloped, 3, 5)).toBeCloseTo(2.5, 10)
    expect(demHeightAt({ ...dem, mask: new Uint8Array(200) }, 3, 5)).toBeNaN()
  })
  it('takes the native ground pixel from the photos above the DEM', () => {
    expect(
      nativeGsd(
        dem,
        [
          [5, 5, 50],
          [8, 5, 70],
          [9, 5, 60],
          [100, 100, 50],
        ],
        [100, 100, 100, 100],
      ),
    ).toBeCloseTo(0.6, 10)
  })
})

describe('rendering', () => {
  // Two captures over x = 5 and x = 15; band 0 reads DN 1000 + 1000·capture, band 1 is
  // thermal (centikelvin) and missing from the second capture.
  const band0 = { bits: 16, blackLevel: 0, exposure: 1, gain: 1, radiometricCal: [65536, 0, 0] }
  const thermal = { thermal: true }
  const captures = [0, 1].map((k) => {
    const C = [5 + 10 * k, 5, 50]
    const ref = photoAt(C, {
      cal: radiometryOf(band0, 'X', 0.001, 100, 100),
      dn: new Uint16Array(10000).fill(1000 + 1000 * k),
    })
    const th =
      k === 0
        ? photoAt(C, { cal: radiometryOf(thermal, 'X', 1, 100, 100), dn: new Uint16Array(10000).fill(29315) })
        : null
    return { scoring: ref, photos: [ref, th] }
  })
  const cellP = (c, r) => [c + 0.5, 10 - (r + 0.5), 0]
  const photoData = (p) => ({ dn: p.dn, width: 100, height: 100 })

  it('gives each cell the capture that sees it most nadir, each band from that capture', () => {
    const block = { col0: 0, row0: 0, width: 20, height: 10 }
    const caps = blockCaptures(captures, block, cellP)
    expect(caps.length).toBe(2)
    const { data, covered } = renderReflectanceBlock(block, caps, 2, cellP, photoData)
    expect(covered).toBe(200)
    // Column 4 (x = 4.5) is nearer capture 0, column 15 (x = 15.5) capture 1.
    expect(data[(5 * 20 + 4) * 2]).toBeCloseTo(1, 6) // 1000 DN · 1/1000
    expect(data[(5 * 20 + 15) * 2]).toBeCloseTo(2, 6)
    expect(data[(5 * 20 + 4) * 2 + 1]).toBeCloseTo(20, 4) // 293.15 K
    expect(data[(5 * 20 + 15) * 2 + 1]).toBeNaN() // no thermal photo in capture 1
  })
  it('leaves cells no photo sees as NaN, and finds no capture for a far block', () => {
    const far = (c, r) => [c + 500, 10 - r, 0]
    expect(blockCaptures(captures, { col0: 0, row0: 0, width: 4, height: 4 }, far)).toEqual([])
    expect(viewOf(captures[0].scoring, [500, 5, 0])).toBeNull()
    const { data } = renderReflectanceBlock({ col0: 0, row0: 0, width: 4, height: 4 }, captures, 2, far, photoData)
    expect(data.every((v) => Number.isNaN(v))).toBe(true)
  })
  it('applies the band radiometry: black level, vignetting, the row term', () => {
    const b = {
      ...band0,
      blackLevel: 100,
      radiometricCal: [65536, 0.001, 0],
      exposure: 0.5,
      vignette: { center: [0, 0], poly: [0.01] },
    }
    const { toValue } = radiometryOf(b, 'X', 2, 100, 100)
    const r = Math.hypot(3, 4)
    expect(toValue(1100, 3, 4)).toBeCloseTo((2 * (1000 / (1 + 0.01 * r)) * (1 / (1 + (0.001 * 4) / 0.5))) / 0.5, 9)
    expect(toValue(50, 3, 4)).toBe(0)
  })
})

describe('calibration', () => {
  it('chooses what the data allows', () => {
    expect(resolveCalibration('auto', { havePanel: true, haveDls: true })).toBe('panel+dls')
    expect(resolveCalibration('auto', { havePanel: true, haveDls: false })).toBe('panel')
    expect(resolveCalibration('auto', { havePanel: false, haveDls: true })).toBe('dls')
    expect(resolveCalibration('auto', { havePanel: false, haveDls: false })).toBe('radiance')
    expect(resolveCalibration('dls', { havePanel: true, haveDls: true })).toBe('dls')
  })
  it('turns radiance into reflectance by the panel, the sun sensor, or both', () => {
    const panel = { albedo: 0.5, radiance: 0.2, irradiance: 1.2 }
    expect(calibrationFactor('panel', panel, 0.6)).toBeCloseTo(2.5, 12)
    expect(calibrationFactor('dls', panel, 0.6)).toBeCloseTo(Math.PI / 0.6, 12)
    // Half the light of the panel capture: the same radiance is twice the reflectance.
    expect(calibrationFactor('panel+dls', panel, 0.6)).toBeCloseTo(5, 12)
    expect(calibrationFactor('radiance', panel, 0.6)).toBe(1)
    expect(calibrationFactor('dls', panel, null)).toBeNaN()
  })
})

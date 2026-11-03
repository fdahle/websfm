import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import exifr from 'exifr'
import { fromArrayBuffer } from 'geotiff'
import { bandMetadata } from '../io/metadata.js'
import {
  exposureSeconds,
  vignetteFn,
  hasRadiometry,
  radianceImage,
  regionStats,
  panelIrradiance,
  reflectanceFactor,
  dlsIrradiance,
} from './micasense.js'

const band = {
  bits: 16,
  blackLevel: 4800,
  exposure: 0.001,
  gain: 2,
  radiometricCal: [0.0001, 1e-8, 2e-6],
  vignette: { center: [10, 5], poly: [0.001, 0.0001] },
}

describe('radiance', () => {
  it('applies black level, gain, exposure, the row term and vignetting', () => {
    const w = 20,
      h = 10
    const dn = new Uint16Array(w * h).fill(14800)
    dn[3] = 4000 // below black: 0
    const L = radianceImage(dn, w, h, band)
    const at = (x, y) => {
      const r = Math.hypot(x - 10, y - 5)
      const V = 1 / (1 + 0.001 * r + 0.0001 * r * r)
      const R = 1 / (1 + (1e-8 * y) / 0.001 - 2e-6 * y)
      return (((V * R * 10000) / (2 * 0.001)) * 0.0001) / 65536
    }
    expect(L[3]).toBe(0)
    for (const [x, y] of [
      [10, 5],
      [0, 0],
      [19, 9],
    ])
      expect(L[y * w + x]).toBeCloseTo(at(x, y), 6)
    expect(hasRadiometry(band)).toBe(true)
    expect(hasRadiometry({ ...band, radiometricCal: [0, 0, 0] })).toBe(false)
  })
  it('reads the 2-D vignetting polynomial of newer cameras', () => {
    const v = vignetteFn({ vignette: { poly2D: [1, 0.5, -0.25], exponents2D: [0, 0, 1, 0, 0, 2] } }, 100, 50)
    expect(v(50, 25)).toBeCloseTo(1 / (1 + 0.5 * 0.5 - 0.25 * 0.25), 12)
    expect(vignetteFn({}, 10, 10)(3, 4)).toBe(1)
  })
  it('turns thermal centikelvin into °C', () => {
    const t = radianceImage(new Uint16Array([29315, 30315]), 2, 1, { thermal: true })
    expect(Array.from(t).map((v) => +v.toFixed(3))).toEqual([20, 30])
  })
  it('fixes the legacy RedEdge exposure', () => {
    expect(exposureSeconds({ exposure: 1 / 6329 }, 'RedEdge')).toBe(0.000274)
    expect(exposureSeconds({ exposure: 1 / 6329 }, 'Altum')).toBe(1 / 6329)
  })
})

describe('panel and irradiance', () => {
  it('averages a quadrilateral and converts a panel to irradiance and reflectance', () => {
    const w = 10
    const img = new Float32Array(100).map((_, i) => i % w)
    const s = regionStats(img, w, [
      [2, 2],
      [6, 2],
      [6, 4],
      [2, 4],
    ])
    expect(s.count).toBe(15)
    expect(s.mean).toBeCloseTo(4, 12)
    expect(panelIrradiance(0.1, 0.5)).toBeCloseTo(0.2 * Math.PI, 12)
    // A panel seen under that irradiance reads back its own albedo.
    expect(0.1 * reflectanceFactor(panelIrradiance(0.1, 0.5))).toBeCloseTo(0.5, 12)
  })
  it('takes the DLS 2 horizontal irradiance, or rebuilds it where the firmware got it wrong', () => {
    const irradiance = { horizontal: 1.2, direct: 1, scattered: 0.25, solarElevation: Math.PI / 6 }
    expect(dlsIrradiance({ irradiance, firmware: 'v1.3.0' }, 'Altum')).toBe(1.2)
    expect(dlsIrradiance({ irradiance, firmware: 'v1.2.2' }, 'Altum')).toBeCloseTo(0.75, 12)
    expect(dlsIrradiance({ irradiance, firmware: 'v1.0.0' }, 'Altum-PT')).toBe(1.2)
    expect(dlsIrradiance({ irradiance: {} })).toBeNull()
    expect(dlsIrradiance({ thermal: true, irradiance })).toBeNull()
  })
})

// MicaSense's own test values (imageprocessing tests/test_capture.py), on their sample
// captures where present (/data1/websfm_testdata/micasense-samples, see its README).
const SAMPLES = process.env.MICASENSE_SAMPLES ?? '/data1/websfm_testdata/micasense-samples/data'
describe.skipIf(!existsSync(SAMPLES))('MicaSense sample captures', () => {
  async function load(f) {
    const buf = readFileSync(`${SAMPLES}/${f}`)
    const e = await exifr.parse(buf, { xmp: true })
    const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const im = await tiff.getImage()
    const [dn] = await im.readRasters()
    return { band: bandMetadata(e), model: e.Model, dn, w: im.getWidth(), h: im.getHeight() }
  }
  it('matches the panel radiance and irradiance of a RedEdge-MX panel capture', async () => {
    const radiance = [
      0.17909220357022979, 0.1805512169681595, 0.1577359026273932, 0.10556279304323357, 0.13221390933733143,
    ]
    const irradiance = [
      1.1482341858192686, 1.15758852413034, 1.0113101079623947, 0.6768067247286578, 0.8476780536256069,
    ]
    for (let b = 1; b <= 5; b++) {
      const { band, model, dn, w, h } = await load(`REDEDGE-MX/IMG_0001_${b}.tif`)
      const L = regionStats(radianceImage(dn, w, h, band, model), w, band.panel.corners).mean
      // MicaSense measures on the undistorted image; the panel is even enough not to care.
      expect(Math.abs(L / radiance[b - 1] - 1)).toBeLessThan(0.0015)
      expect(Math.abs(panelIrradiance(L, 0.49) / irradiance[b - 1] - 1)).toBeLessThan(0.0015)
    }
  })
  it('matches the DLS irradiance of an Altum flight capture', async () => {
    const good = [1.1215395307329492, 1.0496371984570443, 0.9390573858775944, 0.5691781852317392, 0.6800663660628287]
    for (let b = 1; b <= 5; b++) {
      const { band, model } = await load(`ALTUM/IMG_0021_${b}.tif`)
      expect(dlsIrradiance(band, model)).toBeCloseTo(good[b - 1], 6)
    }
  })
})

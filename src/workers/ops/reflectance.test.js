import { describe, it, expect, vi, afterEach } from 'vitest'
import { fromArrayBuffer } from 'geotiff'
import { makeReflectanceOps } from './reflectance.js'
import { writeGeoTiff, geoKeysForEpsg } from '../../core/products/geotiff.js'

// A 16-bit single-band photo, as a MicaSense band image is stored.
function photoTiff(w, h, valueAt) {
  const dn = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dn[y * w + x] = valueAt(x, y)
  return writeGeoTiff({
    width: w,
    height: h,
    samples: [{ bits: 16, format: 1 }],
    photometric: 1,
    data: new Uint8Array(dn.buffer),
    pixelScale: [1, 1, 0],
    tiepoint: [0, 0, 0, 0, 0, 0],
    geoKeys: geoKeysForEpsg(32632, false),
  })
}

afterEach(() => vi.unstubAllGlobals())

// The photos are fetched by URL: serve them from memory.
function serve(files) {
  vi.stubGlobal('fetch', async (url) => {
    const bytes = files.get(url)
    if (!bytes) throw new Error(`no ${url}`)
    return new Response(bytes)
  })
}

const NADIR = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
]
const K = { fx: 100, fy: 100, cx: 49.5, cy: 49.5 }
const band = { bits: 16, blackLevel: 0, exposure: 1, gain: 1, radiometricCal: [65536, 0, 0], thermal: false }
const photo = (url, C, capture, bandIdx, b = band, factor = 1) => ({
  uuid: url,
  name: url,
  url,
  capture,
  band: bandIdx,
  R: NADIR,
  t: [-C[0], C[1], C[2]],
  K,
  width: 100,
  height: 100,
  dist: null,
  selfCal: null,
  meta: { band: b, model: 'X' },
  factor,
})

describe('reflectance map ops', () => {
  it('reads the panel and writes one Float32 band per lens on the DEM, split over workers', async () => {
    // A panel photo: 2000 DN in a square, 100 around it.
    serve(
      new Map([
        ['panel', photoTiff(100, 100, (x, y) => (x >= 40 && x < 60 && y >= 40 && y < 60 ? 2000 : 100))],
        ['a0', photoTiff(100, 100, () => 1000)],
        ['a1', photoTiff(100, 100, () => 29315)],
        ['b0', photoTiff(100, 100, () => 3000)],
      ]),
    )
    const ops = makeReflectanceOps()
    const logs = []
    const emit = (ev, args) => ev === 'log' && logs.push(args[0])
    const panels = await ops.reflectancePanels(
      [
        {
          panels: [
            {
              key: '#0',
              name: 'panel',
              url: 'panel',
              band,
              model: 'X',
              corners: [
                [42, 42],
                [57, 42],
                [57, 57],
                [42, 57],
              ],
            },
          ],
        },
      ],
      { emit },
    )
    // Radiance of 2000 DN: 2000 · a1 / 2¹⁶ = 2000.
    expect(panels['#0']).toMatchObject({ radiance: 2000, photos: 1 })

    // Two captures 10 m apart, 50 m up over flat ground; band 1 thermal, only in the first.
    const dem = {
      width: 20,
      height: 10,
      gsd: 1,
      originX: 0,
      originY: 10,
      data: new Float32Array(200),
      mask: new Uint8Array(200).fill(1),
      frame: {
        kind: 'similarity',
        scale: 1,
        R: NADIR.map((r, i) => [0, 1, 2].map((j) => (i === j ? 1 : 0))),
        t: [0, 0, 0],
        crs: 'EPSG:32632',
      },
    }
    const factor = 0.5 / 2000 // the panel's albedo / radiance
    const input = {
      dem,
      gsd: 0.5,
      bands: [
        { key: '#0', name: 'Green', thermal: false },
        { key: '#5', name: 'LWIR (°C)', thermal: true },
      ],
      refBand: 0,
      photos: [
        photo('a0', [5, 5, 50], 0, 0, band, factor),
        photo('a1', [5, 5, 50], 0, 1, { thermal: true }),
        photo('b0', [15, 5, 50], 1, 0, band, factor),
      ],
    }
    const plan = await ops.reflectanceBegin([input], { emit })
    expect(plan).toMatchObject({ width: 40, height: 20, gsd: 0.5, blocks: 1, captures: 2, crs: 'EPSG:32632' })
    const blocks = []
    const res = await ops.reflectanceShare([input, [0]], {
      emit: (ev, args) => ev === 'block' && blocks.push(args[0]),
    })
    expect(res).toMatchObject({ covered: 800, loads: 3 })
    for (const b of blocks) await ops.reflectanceAdd([b])
    const { cog } = await ops.reflectanceFinish()

    const image = await (await fromArrayBuffer(await cog.arrayBuffer())).getImage()
    expect([image.getWidth(), image.getHeight(), image.getSamplesPerPixel()]).toEqual([40, 20, 2])
    expect(image.fileDirectory.GDAL_METADATA ?? image.fileDirectory.getValue?.('GDAL_METADATA')).toContain('LWIR (°C)')
    const [green, lwir] = await image.readRasters()
    const at = (c, r) => r * 40 + c
    // West half from capture A (1000 DN), east half from B (3000 DN), × albedo/radiance.
    expect(green[at(5, 10)]).toBeCloseTo(0.25, 6)
    expect(green[at(35, 10)]).toBeCloseTo(0.75, 6)
    expect(lwir[at(5, 10)]).toBeCloseTo(20, 4)
    expect(lwir[at(35, 10)]).toBeNaN()
  })

  it('takes the reference band’s ground pixel when no cell size is given', async () => {
    serve(new Map())
    const ops = makeReflectanceOps()
    const logs = []
    const dem = {
      width: 20,
      height: 10,
      gsd: 1,
      originX: 0,
      originY: 10,
      data: new Float32Array(200),
      mask: null,
      frame: {
        kind: 'similarity',
        scale: 1,
        R: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        t: [0, 0, 0],
        crs: 'EPSG:32632',
      },
    }
    const plan = await ops.reflectanceBegin(
      [{ dem, gsd: 0, bands: [{ key: '#0', name: 'Green' }], refBand: 0, photos: [photo('a0', [5, 5, 50], 0, 0)] }],
      { emit: (ev, args) => ev === 'log' && logs.push(args[0]) },
    )
    // 50 m / 100 px.
    expect(plan.gsd).toBeCloseTo(0.5, 10)
    expect(logs.join('\n')).toMatch(/ground pixel is 0\.500/)
  })
})

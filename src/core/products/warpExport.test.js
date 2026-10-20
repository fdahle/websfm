import { describe, it, expect } from 'vitest'
import { fromBlob } from 'geotiff'
import { makeExportOps } from '../../workers/ops/export.js'
import { createCogBuilder, geoKeysForEpsg } from './geotiff.js'

// geotiff.js reads a Blob through FileReader (a browser API, absent in Node): the
// worker op reads the stored COG that way, so give the test the same, minimally.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => { this.result = result; this.onload?.({ target: this }); this.onloadend?.({ target: this }) },
        (err) => { this.error = err; this.onerror?.(err) })
    }
  }
}

const UTM32 = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs'
const UTM33 = '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs'
const deflate = async (bytes) => {
  const part = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).blob()
  return { length: part.size, part }
}
// A plane z = 0.01·Δx − 0.02·Δy + 400 over a 600 × 400 grid at 5 m, in UTM 32.
const geo = { width: 600, height: 400, gsd: 5, originX: 688000, originY: 5342000 }
const zAt = (x, y) => 0.01 * (x - geo.originX) - 0.02 * (y - geo.originY) + 400
function planeData() {
  const data = new Float32Array(geo.width * geo.height)
  for (let r = 0; r < geo.height; r++) for (let c = 0; c < geo.width; c++) {
    data[r * geo.width + c] = zAt(geo.originX + (c + 0.5) * geo.gsd, geo.originY - (r + 0.5) * geo.gsd)
  }
  return data
}
async function demCog(data) {
  const b = createCogBuilder({ width: geo.width, height: geo.height, tileSize: 256, ArrayType: Float32Array,
    samples: [{ bits: 32, format: 3 }], photometric: 1, gdalNoData: 'nan',
    pixelScale: [geo.gsd, geo.gsd, 0], tiepoint: [0, 0, 0, geo.originX, geo.originY, 0],
    geoKeys: geoKeysForEpsg(32632, false) }, { blockSize: 512, compress: deflate })
  for (let r0 = 0; r0 < geo.height; r0 += 512) for (let c0 = 0; c0 < geo.width; c0 += 512) {
    const w = Math.min(512, geo.width - c0), h = Math.min(512, geo.height - r0), blk = new Float32Array(w * h)
    for (let r = 0; r < h; r++) blk.set(data.subarray((r0 + r) * geo.width + c0, (r0 + r) * geo.width + c0 + w), r * w)
    await b.addBlock({ col0: c0, row0: r0, width: w, height: h, data: blk })
  }
  return new Blob((await b.finish()).parts, { type: 'image/tiff' })
}

describe('warpRaster (export a DEM in another CRS)', () => {
  const ops = makeExportOps()
  const args = (extra) => [{ kind: 'dem', geo, resampling: 'bilinear',
    from: { code: 'EPSG:32632', def: UTM32 }, to: { code: 'EPSG:32633', def: UTM33, epsg: 32633, geographic: false }, ...extra }]
  const emit = () => {}

  for (const [name, input] of [['its stored GeoTIFF', async () => ({ file: await demCog(planeData()) })],
    ['its plane', async () => ({ plane: { data: planeData() } })]]) {
    it(`reads ${name}, tags the target EPSG and keeps the heights on their plane`, async () => {
      const { result } = await ops.warpRaster(args(await input()), { emit })
      const image = await (await fromBlob(result.blob)).getImage(0)
      expect(image.getGeoKeys().ProjectedCSTypeGeoKey).toBe(32633)
      expect(image.getWidth()).toBe(result.width)
      expect(result.gsd).toBeGreaterThan(4.98)
      expect(result.gsd).toBeLessThan(5.02)
      const [z] = await image.readRasters({ samples: [0], interleave: false })
      // A cell near the middle: its centre back in UTM 32 lies on the plane.
      const proj4 = (await import('proj4')).default
      let checked = 0
      for (const [c, r] of [[Math.floor(result.width / 2), Math.floor(result.height / 2)], [200, 180], [420, 230]]) {
        const [x, y] = proj4(UTM33, UTM32, [result.originX + (c + 0.5) * result.gsd, result.originY - (r + 0.5) * result.gsd])
        const inside = x > geo.originX + geo.gsd && x < geo.originX + (geo.width - 1) * geo.gsd
          && y < geo.originY - geo.gsd && y > geo.originY - (geo.height - 1) * geo.gsd
        if (!inside) continue
        expect(z[r * result.width + c]).toBeCloseTo(zAt(x, y), 2)
        checked++
      }
      expect(checked).toBeGreaterThan(1)
      // The output box's corner lies outside the rotated source footprint.
      expect(z[0]).toBeNaN()
    })
  }

  it('warps an orthophoto: colour inside, transparent outside its footprint', async () => {
    const w = 300, h = 200, rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([200, 120, 40, 255], i * 4)
    const b = createCogBuilder({ width: w, height: h, tileSize: 256, ArrayType: Uint8ClampedArray,
      samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })), photometric: 2, extraSamples: [2],
      pixelScale: [5, 5, 0], tiepoint: [0, 0, 0, geo.originX, geo.originY, 0], geoKeys: geoKeysForEpsg(32632, false) },
    { blockSize: 512, compress: deflate })
    await b.addBlock({ col0: 0, row0: 0, width: w, height: h, data: rgba })
    const file = new Blob((await b.finish()).parts, { type: 'image/tiff' })
    const { result } = await ops.warpRaster([{ kind: 'ortho', file, geo: { width: w, height: h, gsd: 5, originX: geo.originX, originY: geo.originY },
      from: { code: 'EPSG:32632', def: UTM32 }, to: { code: 'EPSG:32633', def: UTM33, epsg: 32633, geographic: false } }], { emit })
    const image = await (await fromBlob(result.blob)).getImage(0)
    const px = await image.readRasters({ interleave: true })
    const mid = (Math.floor(result.height / 2) * result.width + Math.floor(result.width / 2)) * 4
    expect([...px.subarray(mid, mid + 4)]).toEqual([200, 120, 40, 255])
    expect(px[3]).toBe(0)
  })

  it('refuses a geographic target for a raster around a pole', async () => {
    const polar = '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
    const around = { width: 100, height: 100, gsd: 1000, originX: -50000, originY: 50000 }
    await expect(ops.warpRaster([{ kind: 'dem', geo: around, plane: { data: new Float32Array(100 * 100) },
      from: { code: 'EPSG:3413', def: polar }, to: { code: 'EPSG:4326', def: '+proj=longlat +datum=WGS84 +no_defs', epsg: 4326, geographic: true } }], { emit }))
      .rejects.toThrow(/contains the North Pole/)
  })
})

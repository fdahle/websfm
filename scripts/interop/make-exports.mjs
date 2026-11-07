// Exports for the interop check (scripts/interop/README.md): known synthetic data
// written through the SAME functions the app's Export menu calls, plus what each file
// must contain (expected.json). The other tools (GDAL, PDAL, COLMAP) then read the files
// and check them against expected.json, so a file that only WebSfM can read fails.
//
//   node scripts/interop/make-exports.mjs <outDir>
//
// Writers exercised, as the app calls them:
//   DEM      core/products/exporters.js demToCog / demToGeoTiff (Export ▸ DEM ▸ COG / GeoTIFF),
//            core/products/geotiff.js createCogBuilder with the DEM product's spec (the
//            stored DEM of a large grid, workers/ops/products.js generateDemBlocks)
//   Ortho    exporters.js orthoToGeoTiff (Export ▸ Orthophoto ▸ GeoTIFF)
//   Cloud    workers/ops/export.js exportCloud: LAS, LAZ, COPC (Export ▸ Point Cloud)
//   COLMAP   core/io/colmapModel.js buildColmapModel + text / binary serializers
//            (Export ▸ SfM Project ▸ COLMAP)
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demToCog, demToGeoTiff, orthoToGeoTiff } from '../../src/core/products/exporters.js'
import { createCogBuilder, geoKeysForEpsg } from '../../src/core/products/geotiff.js'
import { makeExportOps } from '../../src/workers/ops/export.js'
import { makeLazCodec } from '../../src/workers/ops/laz.js'
import initLaz from '../../src/wasm/lazcodec/lazcodec.js'
import {
  buildColmapModel,
  serializeColmapModelParts,
  serializeColmapModelBinParts,
} from '../../src/core/io/colmapModel.js'
import { deflateTile } from '../../src/workers/deflateTile.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const out = resolve(process.argv[2] ?? 'interop-out')
await mkdir(out, { recursive: true })
const expected = {}

const EPSG = 32632 // UTM 32N: a projected CRS every tool knows
const X0 = 500000,
  Y0 = 4400000,
  GSD = 0.5

// The same deflate the app's raster export uses (composables/exports/rasters.js).
async function deflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer())
const toBytes = async (x) => (x instanceof Blob ? blobBytes(x) : x instanceof Uint8Array ? x : new Uint8Array(x))

// ── DEM: a tilted plane with a hole ───────────────────────────────────────────────────
// z(col, row) = 100 + 0.01·col − 0.02·row; NaN in a rectangle (nodata in the file).
// 1,100 × 700 cells: past one 512 tile, so the COG has overviews.
const W = 1100,
  H = 700
const z = (c, r) => 100 + 0.01 * c - 0.02 * r
const hole = (c, r) => c >= 200 && c < 260 && r >= 300 && r < 340
const demData = new Float32Array(W * H)
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) demData[r * W + c] = hole(c, r) ? NaN : z(c, r)
const dem = { width: W, height: H, gsd: GSD, originX: X0, originY: Y0, data: demData }
const crs = { code: EPSG, geographic: false }
await writeFile(
  join(out, 'dem.cog.tif'),
  await toBytes(await demToCog(dem, { crs, nodata: -9999, deflate: deflateBytes })),
)
await writeFile(
  join(out, 'dem.tif'),
  await toBytes(await demToGeoTiff(dem, { crs, nodata: -9999, deflate: deflateBytes })),
)

// The stored DEM product of a large grid: the block-by-block COG builder, its own spec
// (Float32, NaN nodata, 256 tiles, tile DEFLATE by deflateTile) as products.js sets it.
{
  const builder = createCogBuilder(
    {
      width: W,
      height: H,
      tileSize: 256,
      ArrayType: Float32Array,
      samples: [{ bits: 32, format: 3 }],
      photometric: 1,
      gdalNoData: 'nan',
      pixelScale: [GSD, GSD, 0],
      tiepoint: [0, 0, 0, X0, Y0, 0],
      geoKeys: geoKeysForEpsg(EPSG, false),
    },
    { blockSize: 512, compress: deflateTile },
  )
  for (let r0 = 0; r0 < H; r0 += 512)
    for (let c0 = 0; c0 < W; c0 += 512) {
      const bw = Math.min(512, W - c0),
        bh = Math.min(512, H - r0)
      const block = new Float32Array(bw * bh)
      for (let r = 0; r < bh; r++) for (let c = 0; c < bw; c++) block[r * bw + c] = demData[(r0 + r) * W + c0 + c]
      await builder.addBlock({ col0: c0, row0: r0, width: bw, height: bh, data: block })
    }
  const { parts } = await builder.finish()
  await writeFile(join(out, 'dem-product.cog.tif'), await blobBytes(new Blob(parts)))
}
const samples = [
  [0, 0],
  [W - 1, 0],
  [0, H - 1],
  [W - 1, H - 1],
  [517, 263],
  [1033, 611],
].map(([c, r]) => ({ col: c, row: r, z: Math.fround(z(c, r)) }))
expected.dem = {
  files: {
    'dem.cog.tif': { cog: true, nodata: -9999 },
    'dem.tif': { cog: false, nodata: -9999 },
    'dem-product.cog.tif': { cog: true, nodata: 'nan' },
  },
  epsg: EPSG,
  width: W,
  height: H,
  geotransform: [X0, GSD, 0, Y0, 0, -GSD],
  samples,
  hole: { col: 230, row: 320 },
}

// ── Ortho: an RGBA pattern with a transparent corner ──────────────────────────────────
const OW = 700,
  OH = 500
const rgba = new Uint8Array(OW * OH * 4)
const px = (c, r) => [c % 256, r % 256, (c + 2 * r) % 256, c < 50 && r < 40 ? 0 : 255]
for (let r = 0; r < OH; r++) for (let c = 0; c < OW; c++) rgba.set(px(c, r), (r * OW + c) * 4)
await writeFile(
  join(out, 'ortho.tif'),
  await toBytes(
    await orthoToGeoTiff(
      { width: OW, height: OH, rgba },
      { gsd: GSD, originX: X0, originY: Y0 },
      { crs, deflate: deflateBytes },
    ),
  ),
)
expected.ortho = {
  file: 'ortho.tif',
  epsg: EPSG,
  width: OW,
  height: OH,
  bands: 4,
  geotransform: [X0, GSD, 0, Y0, 0, -GSD],
  samples: [
    [0, 0],
    [123, 77],
    [699, 499],
    [300, 260],
  ].map(([c, r]) => ({ col: c, row: r, rgba: px(c, r) })),
}

// ── Point cloud: a known grid of points with colours and classes ──────────────────────
await initLaz({ module_or_path: await readFile(join(repo, 'src/wasm/lazcodec/lazcodec_bg.wasm')) })
const { exportCloud } = makeExportOps({ lazCodec: makeLazCodec() })
const N = 120_000
const pos = new Float64Array(N * 3),
  col = new Uint8Array(N * 3),
  cls = new Uint8Array(N)
for (let i = 0; i < N; i++) {
  const gx = i % 400,
    gy = Math.floor(i / 400)
  pos[i * 3] = X0 + gx * 0.25
  pos[i * 3 + 1] = Y0 - gy * 0.25
  pos[i * 3 + 2] = 100 + Math.sin(gx / 20) * 3 + gy * 0.01
  col.set([gx % 256, gy % 256, 128], i * 3)
  cls[i] = gx < 200 ? 2 : 5 // ground / high vegetation
}
let minZ = Infinity,
  maxZ = -Infinity
for (let i = 0; i < N; i++) {
  minZ = Math.min(minZ, pos[i * 3 + 2])
  maxZ = Math.max(maxZ, pos[i * 3 + 2])
}
const emit = () => {}
for (const format of ['las', 'laz', 'copc']) {
  const cloud = { count: N, pos: pos.slice(), col: col.slice(), attributes: { classification: cls.slice() } }
  const { result } = await exportCloud([{ cloud, format, color: true, crsCode: EPSG, geographic: false }], { emit })
  const name = format === 'copc' ? 'cloud.copc.laz' : `cloud.${format}`
  await writeFile(join(out, name), await blobBytes(result.blob))
}
expected.cloud = {
  files: ['cloud.las', 'cloud.laz', 'cloud.copc.laz'],
  count: N,
  epsg: EPSG,
  minx: X0,
  maxx: X0 + 399 * 0.25,
  miny: Y0 - (N / 400 - 1) * 0.25,
  maxy: Y0,
  minz: minZ,
  maxz: maxZ,
  classes: { 2: N / 2, 5: N / 2 },
  // LAS quantises coordinates; the writers pick their scale (≤ 1 mm here).
  tolerance: 0.002,
}

// ── COLMAP: three cameras around a cube of points, observations exact projections ─────
const K = { fx: 1200, fy: 1180, cx: 640.5, cy: 479.25 }
const rotY = (a) => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
]
const mulv = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
const cams = [-0.3, 0, 0.35].map((a, i) => {
  const R = rotY(a)
  const C = [Math.sin(a) * -10, 0.2 * i, -10 * Math.cos(a)] // centres on a circle, looking at the origin
  const t = mulv(R, C).map((v) => -v)
  return { uuid: `cam${i}`, name: `img_${i}.jpg`, width: 1280, height: 960, K, R, t }
})
const pts = []
for (let x = -2; x <= 2; x++)
  for (let y = -2; y <= 2; y++)
    for (let zc = -2; zc <= 2; zc++) {
      const X = [x * 0.5, y * 0.5, zc * 0.5]
      const views = cams.map((c) => {
        const p = mulv(c.R, X).map((v, k) => v + c.t[k])
        return { uuid: c.uuid, x: K.fx * (p[0] / p[2]) + K.cx, y: K.fy * (p[1] / p[2]) + K.cy }
      })
      pts.push({ xyz: X, color: [200, 100, 50], error: 0.5, views })
    }
const model = buildColmapModel({ images: cams, points: pts })
for (const [dir, files] of [
  ['colmap-txt', serializeColmapModelParts(model)],
  ['colmap-bin', serializeColmapModelBinParts(model)],
]) {
  await mkdir(join(out, dir), { recursive: true })
  for (const [name, parts] of Object.entries(files)) {
    const chunks = []
    for (const p of parts) chunks.push(typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))
    await writeFile(join(out, dir, name), Buffer.concat(chunks))
  }
}
expected.colmap = {
  dirs: ['colmap-txt', 'colmap-bin'],
  cameras: cams.map((c) => ({ name: c.name, width: c.width, height: c.height, K: c.K, R: c.R, t: c.t })),
  points: pts.length,
  observations: pts.length * cams.length,
  // One point and where each camera sees it: COLMAP's own projection must land there.
  probe: { xyz: pts[17].xyz, pixels: pts[17].views.map((v) => [v.x, v.y]) },
}

await writeFile(join(out, 'expected.json'), JSON.stringify(expected, null, 2))
console.log(`exports written to ${out}`)

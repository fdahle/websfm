// Build the geoid undulation grids the app ships in public/geoid/ (core/geo/geoid.js)
// from NGA's grids as PROJ distributes them (public domain):
//
//   curl -O https://cdn.proj.org/us_nga_egm96_15.tif   # EGM96, 15′, 2.7 MB
//   curl -O https://cdn.proj.org/us_nga_egm08_25.tif   # EGM2008, 2.5′, 81 MB
//   node scripts/build-geoid-grids.mjs us_nga_egm96_15.tif us_nga_egm08_25.tif
//
// Output: one 15′ grid per model, 721 rows (90° N → 90° S) × 1440 columns (180° W
// eastwards), N in whole centimetres as little-endian Int16, zlib-compressed. Every
// value is a NODE of the source grid (EGM2008: every 6th of its 2.5′ nodes), so the
// only error is the bilinear interpolation between 15′ nodes; docs/METHODS.md §9.1
// gives its size. The source grids are point-registered (GDAL reports their origin
// half a cell outside the first node; geotiff.js the tiepoint, i.e. the node).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { zlibSync } from 'fflate'
import { fromArrayBuffer } from 'geotiff'

const ROWS = 721,
  COLS = 1440,
  STEP = 0.25

async function nodes(path) {
  const buf = await readFile(path)
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const image = await tiff.getImage()
  const [res] = image.getResolution()
  const [x0, y0] = image.getOrigin()
  const stride = Math.round(STEP / res)
  // The first node must be 180° W, 90° N: the tiepoint of a PixelIsPoint grid,
  // half a cell in from the origin of an area-registered one.
  const half = image.getGeoKeys().GTRasterTypeGeoKey === 2 ? 0 : res / 2
  if (Math.abs(x0 + half + 180) > 1e-9 || Math.abs(y0 - half - 90) > 1e-9 || Math.abs(stride * res - STEP) > 1e-12) {
    throw new Error(`${path}: unexpected grid (origin ${x0}, ${y0}, step ${res})`)
  }
  const [band] = await image.readRasters()
  const width = image.getWidth(),
    out = new Int16Array(ROWS * COLS)
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const v = band[r * stride * width + c * stride]
      if (!Number.isFinite(v) || Math.abs(v) > 300) throw new Error(`${path}: bad value ${v} at row ${r}, col ${c}`)
      out[r * COLS + c] = Math.round(v * 100)
    }
  return out
}

const [egm96, egm2008] = process.argv.slice(2)
if (!egm96 || !egm2008) {
  console.error('usage: node scripts/build-geoid-grids.mjs us_nga_egm96_15.tif us_nga_egm08_25.tif')
  process.exit(1)
}
const dir = new URL('../public/geoid/', import.meta.url)
await mkdir(dir, { recursive: true })
for (const [name, path] of [
  ['egm96-15', egm96],
  ['egm2008-15', egm2008],
]) {
  const grid = await nodes(path)
  const bytes = zlibSync(new Uint8Array(grid.buffer), { level: 9 })
  await writeFile(new URL(`${name}.i16.z`, dir), bytes)
  console.log(`${name}: ${ROWS}×${COLS}, ${(bytes.length / 1e6).toFixed(2)} MB`)
}

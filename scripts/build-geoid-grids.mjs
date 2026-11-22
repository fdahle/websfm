// Build the geoid undulation grids the app ships in public/geoid/ (core/verticalDatum.js)
// from NGA's grids as PROJ distributes them (public domain):
//
//   curl -O https://cdn.proj.org/us_nga_egm96_15.tif   # EGM96, 15′, 2.7 MB
//   curl -O https://cdn.proj.org/us_nga_egm08_25.tif   # EGM2008, 2.5′, 81 MB
//   node scripts/build-geoid-grids.mjs us_nga_egm96_15.tif us_nga_egm08_25.tif
//
// Output, N in whole centimetres as little-endian Int16, zlib-compressed, rows from 90° N,
// columns from 180° W eastwards:
//   egm96-15.i16.z    EGM96 at 15′ (721 × 1440), as stored: the model's own grid.
//   egm2008-5.i16d.z  EGM2008 at 5′ (2161 × 4320), every 2nd node of the 2.5′ grid,
//                     each row stored as differences along it (the first value whole),
//                     which compresses to 5.8 MB instead of 13.
// Every value is a NODE of the source grid, so the only error is the interpolation
// between nodes (core/verticalDatum.js: bilinear for EGM96, as PROJ; bicubic for EGM2008);
// docs/METHODS.md §9.1 gives its size. The source grids are point-registered (GDAL reports
// their origin half a cell outside the first node; geotiff.js the tiepoint, the node).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { zlibSync } from 'fflate'
import { fromArrayBuffer } from 'geotiff'

async function nodes(path, { rows, cols, step }) {
  const buf = await readFile(path)
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const image = await tiff.getImage()
  const [res] = image.getResolution()
  const [x0, y0] = image.getOrigin()
  const stride = Math.round(step / res)
  // The first node must be 180° W, 90° N: the tiepoint of a PixelIsPoint grid,
  // half a cell in from the origin of an area-registered one.
  const half = image.getGeoKeys().GTRasterTypeGeoKey === 2 ? 0 : res / 2
  if (Math.abs(x0 + half + 180) > 1e-9 || Math.abs(y0 - half - 90) > 1e-9 || Math.abs(stride * res - step) > 1e-12) {
    throw new Error(`${path}: unexpected grid (origin ${x0}, ${y0}, step ${res})`)
  }
  const [band] = await image.readRasters()
  const width = image.getWidth(),
    out = new Int16Array(rows * cols)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = band[r * stride * width + c * stride]
      if (!Number.isFinite(v) || Math.abs(v) > 300) throw new Error(`${path}: bad value ${v} at row ${r}, col ${c}`)
      out[r * cols + c] = Math.round(v * 100)
    }
  return out
}

// Each row as differences along it (core/verticalDatum.js undoes it on load).
function rowDeltas(grid, cols) {
  const out = Int16Array.from(grid)
  for (let i = out.length - 1; i > 0; i--) if (i % cols) out[i] = grid[i] - grid[i - 1]
  return out
}

const [egm96, egm2008] = process.argv.slice(2)
if (!egm96 || !egm2008) {
  console.error('usage: node scripts/build-geoid-grids.mjs us_nga_egm96_15.tif us_nga_egm08_25.tif')
  process.exit(1)
}
const dir = new URL('../public/geoid/', import.meta.url)
await mkdir(dir, { recursive: true })
for (const { file, path, rows, cols, step, delta } of [
  { file: 'egm96-15.i16.z', path: egm96, rows: 721, cols: 1440, step: 0.25 },
  { file: 'egm2008-5.i16d.z', path: egm2008, rows: 2161, cols: 4320, step: 1 / 12, delta: true },
]) {
  const grid = await nodes(path, { rows, cols, step })
  const stored = delta ? rowDeltas(grid, cols) : grid
  const bytes = zlibSync(new Uint8Array(stored.buffer), { level: 9 })
  await writeFile(new URL(file, dir), bytes)
  console.log(`${file}: ${rows}×${cols}, ${(bytes.length / 1e6).toFixed(2)} MB`)
}

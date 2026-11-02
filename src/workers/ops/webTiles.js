import proj4 from 'proj4'
import { openRaster, readWindowBytes } from '../cogRead.js'
import { zipStream } from '../../utils/zip.js'
import {
  TILE,
  tileRange,
  tileSourceGrid,
  sampleTile,
  downsampleChildren,
  mbtilesMetadata,
  tmsRow,
} from '../../core/products/webTiles.js'

// Export ▸ Orthophoto ▸ MBTiles / XYZ tiles (core/products/webTiles.js): the Web
// Mercator pyramid of a computed orthophoto. The finest zoom is resampled from the
// stored COG, one window per tile; every coarser tile is its four children averaged,
// built depth first, so only a few tiles per zoom are held at once and the orthophoto is
// read once. MBTiles is SQLite (the same @sqlite.org/sqlite-wasm the COLMAP database
// uses, imported only here, when it is asked for); XYZ is a zip of {z}/{x}/{y} files.

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' }
// Past this many tiles the run would take hours and the file gigabytes: ask for fewer zooms.
export const MAX_WEB_TILES = 400000

export function makeWebTilesOps() {
  // input { file (the orthophoto's COG Blob), geo: { width, height, gsd, originX, originY }
  //   (CRS units, top-left corner), from: { def } (its proj4 definition), bbox [w, s, e, n]
  //   (degrees), minZoom, maxZoom, tileFormat: 'png' | 'jpeg' | 'webp', quality,
  //   container: 'mbtiles' | 'xyz', name }
  // → { blob, tiles, minZoom, maxZoom }
  async function exportWebTiles([input], { emit }) {
    const { file, geo, from, bbox, minZoom, maxZoom, tileFormat = 'png', quality = 0.85, container, name } = input
    const t0 = performance.now()
    const image = await openRaster(file)
    const bands = image.getSamplesPerPixel()
    const toCrs = proj4('WGS84', from.def)
    const toSource = (lon, lat) => {
      const [X, Y] = toCrs.forward([lon, lat])
      if (!Number.isFinite(X) || !Number.isFinite(Y)) return null
      return [(X - geo.originX) / geo.gsd - 0.5, (geo.originY - Y) / geo.gsd - 0.5]
    }
    const ranges = []
    let total = 0
    for (let z = minZoom; z <= maxZoom; z++) {
      ranges[z] = tileRange(bbox, z)
      total += (ranges[z].x1 - ranges[z].x0 + 1) * (ranges[z].y1 - ranges[z].y0 + 1)
    }
    if (total > MAX_WEB_TILES)
      throw new Error(
        `${total.toLocaleString()} tiles from zoom ${minZoom} to ${maxZoom} is more than ${MAX_WEB_TILES.toLocaleString()}: ` +
          'export fewer zooms (a lower finest zoom)',
      )
    const inRange = (z, x, y) => {
      const r = ranges[z]
      return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
    }

    const sink =
      container === 'mbtiles' ? await mbtilesSink(name, tileFormat, bbox, minZoom, maxZoom) : xyzSink(EXT[tileFormat])
    const canvas = new OffscreenCanvas(TILE, TILE)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let written = 0,
      visited = 0
    const encode = async (rgba) => {
      if (tileFormat === 'jpeg') {
        // JPEG has no alpha: uncovered pixels go white, as a map's background.
        for (let i = 3; i < rgba.length; i += 4)
          if (rgba[i] < 255) {
            const a = rgba[i] / 255
            for (let k = 1; k <= 3; k++) rgba[i - k] = Math.round(rgba[i - k] * a + 255 * (1 - a))
            rgba[i] = 255
          }
      }
      ctx.putImageData(new ImageData(rgba, TILE, TILE), 0, 0)
      const blob = await canvas.convertToBlob({ type: MIME[tileFormat], quality })
      return new Uint8Array(await blob.arrayBuffer())
    }
    const put = async (z, x, y, rgba) => {
      await sink.add(z, x, y, await encode(new Uint8ClampedArray(rgba)))
      written++
    }

    // A finest-zoom tile, resampled from the orthophoto.
    const render = async (z, x, y) => {
      const grid = tileSourceGrid(z, x, y, toSource)
      let c0 = Infinity,
        c1 = -Infinity,
        r0 = Infinity,
        r1 = -Infinity
      for (let i = 0; i < grid.length; i += 2) {
        if (!Number.isFinite(grid[i])) continue
        c0 = Math.min(c0, grid[i])
        c1 = Math.max(c1, grid[i])
        r0 = Math.min(r0, grid[i + 1])
        r1 = Math.max(r1, grid[i + 1])
      }
      const x0 = Math.max(0, Math.floor(c0) - 1),
        y0 = Math.max(0, Math.floor(r0) - 1)
      const x1 = Math.min(geo.width, Math.ceil(c1) + 2),
        y1 = Math.min(geo.height, Math.ceil(r1) + 2)
      if (!(x1 > x0 && y1 > y0)) return null
      let src = await readWindowBytes(image, x0, y0, x1, y1)
      if (bands === 3) src = rgbToRgba(src)
      const out = new Uint8ClampedArray(TILE * TILE * 4)
      return sampleTile(grid, src, x1 - x0, y1 - y0, x0, y0, out) ? out : null
    }

    // Depth first: a tile's children, then the tile from them.
    const build = async (z, x, y) => {
      visited++
      if (visited % 64 === 0) emit('progress', [visited, total, 'Writing web map tiles…'])
      let rgba
      if (z === maxZoom) rgba = await render(z, x, y)
      else {
        const children = []
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          const cx = 2 * x + dx,
            cy = 2 * y + dy
          children.push(inRange(z + 1, cx, cy) ? await build(z + 1, cx, cy) : null)
        }
        rgba = downsampleChildren(children)
      }
      if (rgba) await put(z, x, y, rgba)
      return rgba
    }
    const r = ranges[minZoom]
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) await build(minZoom, x, y)

    const blob = await sink.finish()
    emit('log', [
      `Web map tiles: ${written.toLocaleString()} ${EXT[tileFormat].toUpperCase()} tiles, zoom ${minZoom}–${maxZoom}, ` +
        `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      'info',
      'Export',
    ])
    return { result: { blob, tiles: written, minZoom, maxZoom } }
  }

  return { exportWebTiles }
}

function rgbToRgba(rgb) {
  const n = rgb.length / 3
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    out[4 * i] = rgb[3 * i]
    out[4 * i + 1] = rgb[3 * i + 1]
    out[4 * i + 2] = rgb[3 * i + 2]
    out[4 * i + 3] = 255
  }
  return out
}

// {z}/{x}/{y}.ext in a zip, folded into a Blob a batch at a time.
function xyzSink(ext) {
  const zip = zipStream()
  const parts = []
  let blob = null,
    size = 0
  const fold = (p) => {
    parts.push(...p)
    size += p.reduce((s, b) => s + b.length, 0)
    if (size >= 64 << 20) {
      blob = new Blob(blob ? [blob, ...parts] : parts)
      parts.length = 0
      size = 0
    }
  }
  return {
    async add(z, x, y, bytes) {
      fold(zip.add(`${z}/${x}/${y}.${ext}`, bytes))
    },
    async finish() {
      fold(zip.finish())
      return new Blob(blob ? [blob, ...parts] : parts, { type: 'application/zip' })
    },
  }
}

async function mbtilesSink(name, tileFormat, bbox, minZoom, maxZoom) {
  const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
  const sqlite = await sqlite3InitModule()
  const db = new sqlite.oo1.DB(':memory:', 'c')
  db.exec(
    'CREATE TABLE metadata (name TEXT, value TEXT);' +
      'CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);' +
      'CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);',
  )
  const format = { png: 'png', jpeg: 'jpg', webp: 'webp' }[tileFormat]
  for (const row of mbtilesMetadata({ name, format, bbox, minZoom, maxZoom, description: 'Orthophoto from WebSfM' }))
    db.exec({ sql: 'INSERT INTO metadata VALUES (?, ?)', bind: row })
  db.exec('BEGIN')
  const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)')
  return {
    async add(z, x, y, bytes) {
      insert.bind([z, x, tmsRow(y, z), bytes]).stepReset()
    },
    async finish() {
      insert.finalize()
      db.exec('COMMIT')
      const bytes = sqlite.capi.sqlite3_js_db_export(db)
      db.close()
      return new Blob([bytes], { type: 'application/x-sqlite3' })
    },
  }
}

// Web map tiles of an orthophoto (Export ▸ Orthophoto ▸ MBTiles / XYZ tiles): the
// Web Mercator (EPSG:3857) tile pyramid every web map, QGIS and QField read, 256 px
// tiles, x east from 180° W, y south from the top (XYZ; MBTiles stores rows from the
// bottom, TMS). Pure: tile maths, the per-tile resampling grid and the 2× downsample a
// parent tile is built from; the worker (workers/ops/webTiles.js) reads the raster and
// encodes.

export const TILE = 256
const R = 6378137 // the sphere Web Mercator projects
const MAX_LAT = 85.0511287798066

// Metres per pixel of a tile at latitude `lat` and zoom `z`.
export function tileResolution(lat, z) {
  return (2 * Math.PI * R * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z)
}

// Fractional tile coordinates of (lon°, lat°) at zoom z.
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z
  const la = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n]
}

// (lon°, lat°) of fractional tile coordinates (x, y) at zoom z.
export function tileToLonLat(x, y, z) {
  const n = 2 ** z
  const lon = (x / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  return [lon, lat]
}

// MBTiles' row (TMS, counted from the bottom) of XYZ row y.
export const tmsRow = (y, z) => 2 ** z - 1 - y

// The zooms worth writing for an orthophoto of `gsd` metres at latitude `lat`: from where
// the whole raster fits 2 × 2 tiles (`bbox` [west, south, east, north] in degrees) to the
// first zoom whose tiles are as fine as the orthophoto (capped at `cap`).
export function zoomRange({ gsd, lat, bbox, cap = 23 }) {
  let maxZoom = 0
  while (maxZoom < cap && tileResolution(lat, maxZoom) > gsd) maxZoom++
  // The finest zoom at which the whole area fits 2 × 2 tiles.
  let minZoom = maxZoom
  while (minZoom > 0) {
    const r = tileRange(bbox, minZoom)
    if (r.x1 - r.x0 <= 1 && r.y1 - r.y0 <= 1) break
    minZoom--
  }
  return { minZoom, maxZoom }
}

// Tiles covering bbox [west, south, east, north] at zoom z: { x0, x1, y0, y1 } inclusive.
export function tileRange([w, s, e, n], z) {
  const [x0, y0] = lonLatToTile(w, n, z)
  const [x1, y1] = lonLatToTile(e, s, z)
  const last = 2 ** z - 1
  const c = (v) => Math.max(0, Math.min(last, v))
  return { x0: c(Math.floor(x0)), x1: c(Math.ceil(x1) - 1), y0: c(Math.floor(y0)), y1: c(Math.ceil(y1) - 1) }
}

// The source position of every pixel centre of tile (z, x, y): `toSource(lon, lat)` →
// [col, row] in the source raster (or null off its projection), evaluated exactly on a
// (n + 1)² grid and bilinear in between: the reprojection across one tile is smooth, so
// 17 × 17 exact points stand for 65,536. → Float64Array [col, row, …] (NaN off it).
export function tileSourceGrid(z, x, y, toSource, n = 16) {
  const g = new Float64Array((n + 1) * (n + 1) * 2)
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const [lon, lat] = tileToLonLat(x + i / n, y + j / n, z)
      const p = toSource(lon, lat)
      const k = (j * (n + 1) + i) * 2
      g[k] = p ? p[0] : NaN
      g[k + 1] = p ? p[1] : NaN
    }
  }
  const out = new Float64Array(TILE * TILE * 2)
  const step = TILE / n
  for (let py = 0; py < TILE; py++) {
    const fy = (py + 0.5) / step
    const j = Math.min(n - 1, Math.floor(fy)),
      ty = fy - j
    for (let px = 0; px < TILE; px++) {
      const fx = (px + 0.5) / step
      const i = Math.min(n - 1, Math.floor(fx)),
        tx = fx - i
      const a = (j * (n + 1) + i) * 2,
        b = a + 2,
        c = a + (n + 1) * 2,
        d = c + 2
      const o = (py * TILE + px) * 2
      for (let k = 0; k < 2; k++)
        out[o + k] = (1 - ty) * ((1 - tx) * g[a + k] + tx * g[b + k]) + ty * ((1 - tx) * g[c + k] + tx * g[d + k])
    }
  }
  return out
}

// Fill a tile (RGBA, 256²) by bilinear sampling of a source window: `src` RGBA bytes of
// `w` × `h` whose top-left cell is (x0, y0) in the grid's coordinates (pixel centres at
// integers). A cell with alpha 0 is nodata and does not blend in; a pixel with no
// source around it stays transparent. → whether any pixel was set.
export function sampleTile(grid, src, w, h, x0, y0, out) {
  let any = false
  for (let p = 0; p < TILE * TILE; p++) {
    const sx = grid[2 * p] - x0,
      sy = grid[2 * p + 1] - y0
    if (!(sx > -0.5 && sy > -0.5 && sx < w - 0.5 && sy < h - 0.5)) continue
    const cx = Math.min(w - 1, Math.max(0, sx)),
      cy = Math.min(h - 1, Math.max(0, sy))
    const i0 = Math.min(w - 2, Math.floor(cx)),
      j0 = Math.min(h - 2, Math.floor(cy))
    const i = Math.max(0, i0),
      j = Math.max(0, j0)
    const tx = w > 1 ? cx - i : 0,
      ty = h > 1 ? cy - j : 0
    let r = 0,
      g = 0,
      b = 0,
      a = 0,
      wsum = 0
    for (const [di, dj, wt] of [
      [0, 0, (1 - tx) * (1 - ty)],
      [1, 0, tx * (1 - ty)],
      [0, 1, (1 - tx) * ty],
      [1, 1, tx * ty],
    ]) {
      const ii = Math.min(w - 1, i + di),
        jj = Math.min(h - 1, j + dj)
      const k = (jj * w + ii) * 4
      if (wt <= 0 || src[k + 3] === 0) continue
      r += src[k] * wt
      g += src[k + 1] * wt
      b += src[k + 2] * wt
      a += src[k + 3] * wt
      wsum += wt
    }
    if (wsum < 0.25) continue
    const o = p * 4
    out[o] = Math.round(r / wsum)
    out[o + 1] = Math.round(g / wsum)
    out[o + 2] = Math.round(b / wsum)
    out[o + 3] = Math.round(a / wsum)
    any = true
  }
  return any
}

// A parent tile from its four children (null where a child is empty), each 2 × 2 block
// averaged over its opaque pixels. `children` in order [top-left, top-right,
// bottom-left, bottom-right]. → RGBA, or null when every child is empty.
export function downsampleChildren(children) {
  if (children.every((c) => !c)) return null
  const out = new Uint8ClampedArray(TILE * TILE * 4)
  const half = TILE / 2
  children.forEach((c, q) => {
    if (!c) return
    const ox = (q % 2) * half,
      oy = Math.floor(q / 2) * half
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          n = 0
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          const k = ((2 * y + dy) * TILE + 2 * x + dx) * 4
          if (c[k + 3] === 0) continue
          r += c[k]
          g += c[k + 1]
          b += c[k + 2]
          a += c[k + 3]
          n++
        }
        if (!n) continue
        const o = ((oy + y) * TILE + ox + x) * 4
        out[o] = Math.round(r / n)
        out[o + 1] = Math.round(g / n)
        out[o + 2] = Math.round(b / n)
        // Over all four: a partly covered block fades at the edge, as a renderer would.
        out[o + 3] = Math.round(a / 4)
      }
    }
  })
  return out
}

// MBTiles 1.3 metadata rows for an orthophoto.
export function mbtilesMetadata({ name, format, bbox, minZoom, maxZoom, description = '' }) {
  const [w, s, e, n] = bbox
  const fmt = (v) => Number(v.toFixed(7))
  return [
    ['name', name],
    ['format', format],
    ['type', 'overlay'],
    ['version', '1.0'],
    ['description', description],
    ['bounds', [w, s, e, n].map(fmt).join(',')],
    ['center', [fmt((w + e) / 2), fmt((s + n) / 2), Math.min(maxZoom, minZoom + 3)].join(',')],
    ['minzoom', String(minZoom)],
    ['maxzoom', String(maxZoom)],
  ]
}

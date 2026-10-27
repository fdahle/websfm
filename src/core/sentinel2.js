// Sentinel-2 L2A scenes as a Find GCPs reference: the Earth Search catalogue (STAC,
// keyless, CORS) lists the scenes over the search area, and their bands are
// Cloud-Optimised GeoTIFFs on AWS Open Data, read a window at a time over HTTP ranges
// (workers/ops/io.js fetchSentinel2Window). Copernicus data are free and open; a
// product made from them must say "Contains modified Copernicus Sentinel data [year]".
// Pure: plain data in, plain data out.

export const S2_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search'
export const S2_COLLECTION = 'sentinel-2-l2a'
// The 10 m visible bands, in RGB order (Earth Search asset keys).
export const S2_RGB_ASSETS = ['red', 'green', 'blue']

export const s2Attribution = (year) => `Contains modified Copernicus Sentinel data ${year}`

// The catalogue query: scenes over `bbox` [west, south, east, north] (degrees) with
// less than `maxCloud` % cloud, optionally between two ISO dates, least cloudy first.
export function s2SearchBody({ bbox, from = '', to = '', maxCloud = 20, limit = 50 }) {
  const body = {
    collections: [S2_COLLECTION],
    bbox,
    limit,
    query: { 'eo:cloud_cover': { lt: maxCloud } },
    sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
  }
  if (from || to) body.datetime = `${from ? `${from}T00:00:00Z` : '..'}/${to ? `${to}T23:59:59Z` : '..'}`
  return body
}

// The lon/lat box of some lon/lat points: [west, south, east, north].
export function lonLatBbox(points) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity
  for (const [lon, lat] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    w = Math.min(w, lon)
    e = Math.max(e, lon)
    s = Math.min(s, lat)
    n = Math.max(n, lat)
  }
  return Number.isFinite(w) ? [w, s, e, n] : null
}

function inRing(ring, x, y) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function inGeometry(geometry, x, y) {
  const polys =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : []
  return polys.some((rings) => inRing(rings[0], x, y) && !rings.slice(1).some((hole) => inRing(hole, x, y)))
}

// The share of a lon/lat box inside a scene's footprint, on a 9 × 9 grid of points.
export function bboxCoverage(geometry, [w, s, e, n], N = 9) {
  let hit = 0
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      if (inGeometry(geometry, w + ((e - w) * (i + 0.5)) / N, s + ((n - s) * (j + 0.5)) / N)) hit++
  return hit / (N * N)
}

// The catalogue's answer as scenes: { id, date, tile, cloud, snow, nodata, coverage
// (share of `bbox`), epsg, transform, shape, hrefs: { red, green, blue } }. Scenes
// without the three 10 m bands or a projection are left out.
export function s2Scenes(featureCollection, bbox) {
  const out = []
  for (const f of featureCollection?.features ?? []) {
    const p = f.properties ?? {},
      a = f.assets ?? {}
    if (!S2_RGB_ASSETS.every((k) => a[k]?.href)) continue
    const red = a.red
    const epsg = p['proj:epsg'] ?? red['proj:epsg'] ?? Number(String(p['proj:code'] ?? '').split(':')[1])
    if (!Number.isFinite(epsg) || !red['proj:transform'] || !red['proj:shape']) continue
    out.push({
      id: f.id,
      date: String(p.datetime ?? '').slice(0, 10),
      tile: p['grid:code']?.replace(/^MGRS-/, '') ?? '',
      cloud: p['eo:cloud_cover'] ?? null,
      snow: p['s2:snow_ice_percentage'] ?? null,
      nodata: p['s2:nodata_pixel_percentage'] ?? null,
      coverage: bbox ? bboxCoverage(f.geometry, bbox) : null,
      epsg,
      transform: red['proj:transform'],
      shape: red['proj:shape'],
      hrefs: Object.fromEntries(S2_RGB_ASSETS.map((k) => [k, a[k].href])),
    })
  }
  return out
}

// Best first: a scene covering the whole area, then the least cloud, then the fewest
// empty pixels, then the newest.
export function rankScenes(scenes) {
  const full = (s) => (s.coverage == null || s.coverage >= 0.99 ? 0 : 1)
  return [...scenes].sort(
    (a, b) =>
      full(a) - full(b) ||
      (b.coverage ?? 1) - (a.coverage ?? 1) ||
      (a.cloud ?? 100) - (b.cloud ?? 100) ||
      (a.nodata ?? 100) - (b.nodata ?? 100) ||
      b.date.localeCompare(a.date),
  )
}

// The pixel window of a scene over `points` (in the scene's CRS), padded by
// `padFraction` of the area's larger side and at least `minPad` metres:
// { x, y, width, height, originX, originY, res }. `transform` is the asset's
// [a, b, c, d, e, f] (x = c + a·col, y = f + e·row). Throws when the area misses the
// scene or is wider than `maxPx`.
export function sceneWindow(transform, [rows, cols], points, { padFraction = 0.25, minPad = 1000, maxPx = 6000 } = {}) {
  const [a, , c, , e, f] = transform
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  if (!Number.isFinite(x0)) throw new Error('The search area has no points')
  const pad = Math.max(minPad, padFraction * Math.max(x1 - x0, y1 - y0))
  const col = (x) => (x - c) / a,
    row = (y) => (y - f) / e
  const c0 = Math.max(0, Math.floor(Math.min(col(x0 - pad), col(x1 + pad)))),
    c1 = Math.min(cols, Math.ceil(Math.max(col(x0 - pad), col(x1 + pad)))),
    r0 = Math.max(0, Math.floor(Math.min(row(y0 - pad), row(y1 + pad)))),
    r1 = Math.min(rows, Math.ceil(Math.max(row(y0 - pad), row(y1 + pad))))
  if (c1 <= c0 || r1 <= r0) throw new Error('The search area lies outside this scene')
  const width = c1 - c0,
    height = r1 - r0
  if (Math.max(width, height) > maxPx)
    throw new Error(
      `The search area is ${((Math.max(width, height) * Math.abs(a)) / 1000).toFixed(0)} km across with its margin; ` +
        `at most ${((maxPx * Math.abs(a)) / 1000).toFixed(0)} km is read. Choose a smaller search area.`,
    )
  return { x: c0, y: r0, width, height, originX: c + a * c0, originY: f + e * r0, res: Math.abs(a) }
}

// Three bands of 16-bit reflectance (0 = no data) as 8-bit RGB, interleaved, with one
// stretch for all three (so colours keep their balance) from the `loQ`–`hiQ`
// quantiles of the valid values. A fixed true-colour scale saturates on snow; this
// keeps the texture of a glacier. Valid pixels are 1–255, so 0 stays "no data".
export function stretchBands(bands, { loQ = 0.005, hiQ = 0.995 } = {}) {
  const n = bands[0].length
  const hist = new Uint32Array(65536)
  let count = 0
  for (let i = 0; i < n; i++) {
    if (!bands[0][i] || !bands[1][i] || !bands[2][i]) continue
    for (const b of bands) hist[b[i]]++
    count += 3
  }
  let lo = 0,
    hi = 65535
  if (count) {
    const loT = Math.floor(loQ * (count - 1)),
      hiT = Math.floor(hiQ * (count - 1))
    let acc = 0,
      haveLo = false
    for (let v = 0; v < 65536; v++) {
      acc += hist[v]
      if (!haveLo && acc > loT) {
        lo = v
        haveLo = true
      }
      if (acc > hiT) {
        hi = v
        break
      }
    }
  }
  if (hi <= lo) hi = lo + 1
  const out = new Uint8Array(3 * n)
  const scale = 254 / (hi - lo)
  for (let i = 0; i < n; i++) {
    if (!bands[0][i] || !bands[1][i] || !bands[2][i]) continue
    for (let k = 0; k < 3; k++) {
      const v = (bands[k][i] - lo) * scale
      out[3 * i + k] = 1 + (v <= 0 ? 0 : v >= 254 ? 254 : Math.round(v))
    }
  }
  return { rgb: out, lo, hi }
}

export const s2RasterName = (scene) => `Sentinel-2 ${scene.date} ${scene.tile || scene.id}.tif`

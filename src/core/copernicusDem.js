// The Copernicus DEM (GLO-30) as a reference DEM: the TanDEM-X DEM, edited (water
// flattened, voids filled), global at 1 arc-second, heights above the EGM2008 geoid.
// TanDEM-X itself needs a DLR login; this copy is keyless. Microsoft's Planetary
// Computer serves the 1° tiles as Cloud-Optimised GeoTIFFs with CORS: its catalogue
// (STAC) lists the tiles over an area, a token it hands out to anyone signs the file
// URLs, and the tiles are read a window at a time over HTTP ranges
// (workers/ops/io.js fetchCopDemMosaic). AWS holds the same tiles, but sends no CORS
// headers, so a browser cannot read them. Pure: plain data in, plain data out.

export const COP_DEM_SEARCH_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
export const COP_DEM_COLLECTION = 'cop-dem-glo-30'
export const COP_DEM_TOKEN_URL = `https://planetarycomputer.microsoft.com/api/sas/v1/token/${COP_DEM_COLLECTION}`
export const COP_DEM_DATUM = 'geoid:EGM2008'

// The product's stated accuracy (Copernicus DEM Product Handbook): absolute horizontal
// < 6 m CE90 and vertical < 4 m LE90, as 1σ: CE90 / 2.146, LE90 / 1.645.
export const COP_DEM_SIGMA = { horizontal: 2.8, vertical: 2.4 }

// The attribution the licence asks of a product made with it.
export const copDemAttribution = () =>
  'Contains Copernicus DEM GLO-30 data, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH ' +
  '2014–2018, provided under COPERNICUS by the European Union and ESA'

// The catalogue query: the tiles over `bbox` [west, south, east, north] (degrees).
export function copDemSearchBody(bbox) {
  return { collections: [COP_DEM_COLLECTION], bbox, limit: 100 }
}

// The catalogue's answer as [{ id, href }]: the tiles' file URLs, unsigned.
export function copDemTiles(featureCollection) {
  const out = []
  for (const f of featureCollection?.features ?? []) {
    const href = f.assets?.data?.href
    if (href && !out.some((t) => t.href === href)) out.push({ id: f.id, href })
  }
  return out
}

// A file URL with the catalogue's token, which lets anyone read for about an hour.
export const signedHref = (href, token) => `${href}${href.includes('?') ? '&' : '?'}${token}`

// The box to fetch around a DEM: its lon/lat corners, padded by `pad` of the larger
// side (at least `minPadDeg`), so a shifted DEM still lies on the reference.
// → [west, south, east, north], or null without corners.
export function paddedBox(lonLats, { pad = 0.1, minPadDeg = 0.01 } = {}) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity
  for (const [lon, lat] of lonLats) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    w = Math.min(w, lon)
    e = Math.max(e, lon)
    s = Math.min(s, lat)
    n = Math.max(n, lat)
  }
  if (!Number.isFinite(w)) return null
  const p = Math.max(minPadDeg, pad * Math.max(e - w, n - s))
  return [Math.max(-180, w - p), Math.max(-90, s - p), Math.min(180, e + p), Math.min(90, n + p)]
}

// The pixel window of one tile over `bbox`: { x0, y0, x1, y1 } (end exclusive), or
// null when they do not meet. A tile is { west, north, dx, dy, width, height }, dy
// positive (rows run south).
export function tileWindow(tile, [west, south, east, north]) {
  const x0 = Math.max(0, Math.floor((west - tile.west) / tile.dx))
  const x1 = Math.min(tile.width, Math.ceil((east - tile.west) / tile.dx))
  const y0 = Math.max(0, Math.floor((tile.north - north) / tile.dy))
  const y1 = Math.min(tile.height, Math.ceil((tile.north - south) / tile.dy))
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null
}

// The grid the tiles are joined on: the finest spacing among them (tiles nearer the
// poles are narrower in longitude), on the lattice of the finest tile, over `bbox`.
// → { west, north, dx, dy, width, height }. Throws when it is wider than `maxPx`.
export function mosaicGrid(tiles, [west, south, east, north], { maxPx = 6000 } = {}) {
  if (!tiles.length) throw new Error('The Copernicus DEM has no tile over this area')
  const ref = tiles.reduce((a, t) => (t.dx < a.dx ? t : a))
  const dx = ref.dx,
    dy = Math.min(...tiles.map((t) => t.dy))
  // A tolerance, so an edge that lies on the lattice in exact arithmetic (11.1° at
  // 1/3600°) is not pushed out by a whole cell by its rounding.
  const down = (v) => Math.floor(v + 1e-6),
    up = (v) => Math.ceil(v - 1e-6)
  const gw = ref.west + down((west - ref.west) / dx) * dx
  const ge = ref.west + up((east - ref.west) / dx) * dx
  const gn = ref.north - down((ref.north - north) / dy) * dy
  const gs = ref.north - up((ref.north - south) / dy) * dy
  const width = Math.round((ge - gw) / dx),
    height = Math.round((gn - gs) / dy)
  if (Math.max(width, height) > maxPx) {
    const km = (Math.max(width * dx * Math.cos(((north + south) / 2) * (Math.PI / 180)), height * dy) * 111.32).toFixed(
      0,
    )
    throw new Error(
      `The DEM with its margin is about ${km} km across; at most ${maxPx.toLocaleString()} reference cells a side ` +
        'are read. Co-register a smaller DEM, or a part of it.',
    )
  }
  return { west: gw, north: gn, dx, dy, width, height }
}

// Join the tiles' windows on `grid`: each cell takes the nearest height of the tile
// that holds its centre, NaN where none does (the sea has no tiles) or where a tile
// has no data (−32767 and below). A window is a tile with its `data` (Float32Array,
// width × height, rows south) and its own west, north, dx, dy, width, height.
export function mosaicDem(windows, grid) {
  const out = new Float32Array(grid.width * grid.height).fill(NaN)
  for (const w of windows) {
    const east = w.west + w.width * w.dx,
      south = w.north - w.height * w.dy
    for (let r = 0; r < grid.height; r++) {
      const lat = grid.north - (r + 0.5) * grid.dy
      if (lat > w.north || lat <= south) continue
      const y = Math.min(w.height - 1, Math.floor((w.north - lat) / w.dy))
      for (let c = 0; c < grid.width; c++) {
        const lon = grid.west + (c + 0.5) * grid.dx
        if (lon < w.west || lon >= east) continue
        const x = Math.min(w.width - 1, Math.floor((lon - w.west) / w.dx))
        const v = w.data[y * w.width + x]
        if (Number.isFinite(v) && v > -32767) out[r * grid.width + c] = v
      }
    }
  }
  return out
}

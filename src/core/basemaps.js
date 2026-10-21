// The 2D map's base layers: the catalogue the ribbon (View ▸ Map ▸ Basemap ▾) and
// Settings list, which of them a frame can show, and the terrain hillshade.
// Pure — ViewerMap builds the OpenLayers layers from this.
//
// Satellite and Terrain are Web-Mercator tile sets: OL reprojects them into any
// CRS whose area lies inside the tiles (they stop at ±85°), so a polar CRS greys
// them out rather than drawing a ring with a hole at the pole. "Automatic" keeps
// the CRS-aware default (OSM, or NASA GIBS for the polar presets).

export const BASEMAPS = [
  {
    value: 'auto',
    label: 'Automatic',
    icon: 'sparkles',
    blurb: 'Street map, or the matching NASA layer for polar CRSs',
  },
  { value: 'streets', label: 'Streets', icon: 'map-pin', blurb: 'OpenStreetMap' },
  {
    value: 'satellite',
    label: 'Satellite',
    icon: 'ortho',
    blurb: 'Esri World Imagery, or your own source (Settings)',
    mercator: true,
  },
  {
    value: 'terrain',
    label: 'Terrain',
    icon: 'dem',
    blurb: 'Shaded relief of a global elevation model',
    mercator: true,
  },
  { value: 'none', label: 'None', icon: 'grid', blurb: 'Grid only' },
]
export const BASEMAP_VALUES = BASEMAPS.map((b) => b.value)

export const SATELLITE = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  // Deeper levels exist only in places; past 19 the service returns "no data"
  // placeholder tiles, so OL upsamples level 19 instead.
  maxZoom: 19,
  attributions:
    'Tiles © <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> — Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  // World Imagery is under the Esri Master License Agreement, not an open
  // licence, so Settings lets a user swap in a provider they hold a licence or
  // API key for (custom tile source below).
  terms: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
}

// A user's own satellite source: an XYZ template in Web Mercator. Its zoom range
// is unknown; past 20 most commercial imagery runs out, so OL upsamples from there.
export const CUSTOM_SATELLITE_MAX_ZOOM = 20

/** Why `url` is not a usable XYZ tile template, or '' (empty = use the default). */
export function tileUrlError(url) {
  const u = url.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) return 'The URL must start with https://'
  if (!u.includes('{z}') || !u.includes('{x}') || !(u.includes('{y}') || u.includes('{-y}')))
    return 'The URL needs {z}, {x} and {y} placeholders'
  return ''
}

/** Attribution HTML for a custom source: the user's text (escaped), else its host. */
export function customAttribution(url, text) {
  const label =
    text.trim() ||
    (() => {
      try {
        return new URL(url.replace(/[{}]/g, '')).host
      } catch {
        return 'Custom source'
      }
    })()
  return label.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

// Terrarium-encoded elevation PNGs (AWS Open Data, Mapzen Terrain Tiles).
export const TERRAIN = {
  url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  // Levels past 13 mostly resample the ~30 m sources, which shades as striping;
  // OL upsamples the level-13 hillshade instead.
  maxZoom: 13,
  attributions:
    'Elevation: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen Terrain Tiles</a> (USGS, NASA SRTM, NOAA ETOPO1 and others)',
}

// True when the CRS's area reaches a pole without crossing the equator — a polar
// projection the Mercator tiles cannot cover. The polar presets say so directly.
function isPolar(info) {
  if (info.basemap === 'gibs') return true
  const w = info.worldExtent
  if (!w || info.geographic) return false
  return (w[1] <= -85 && w[3] <= 0) || (w[3] >= 85 && w[1] >= 0)
}

/**
 * Why `value` cannot be the base layer of this frame, or '' when it can.
 * `info` is the project CRS's crsInfo(), or null for the model frame.
 */
export function basemapReason(value, info) {
  if (!info) return 'The model frame has no position on Earth'
  const b = BASEMAPS.find((m) => m.value === value)
  if (b?.mercator && isPolar(info)) return 'Not available for polar coordinate systems'
  return ''
}

// ── Terrain hillshade ─────────────────────────────────────────────────────────

const EARTH_CIRCUMFERENCE = 40075016.686
const SUN_AZIMUTH = (315 * Math.PI) / 180 // from the north-west, the cartographic convention
const SUN_ELEVATION = (45 * Math.PI) / 180

/** Terrarium RGBA → elevation in metres: R·256 + G + B/256 − 32768. */
export function decodeTerrarium(rgba, w, h) {
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768
  return out
}

/**
 * Grey hillshade RGBA for one Web-Mercator tile (z, tile row y) of elevations.
 * Slopes use each row's true ground pixel size (Mercator stretches by 1/cos φ).
 * Low zooms average the relief nearly flat, so they are steepened.
 */
export function hillshade(elev, w, h, z, y) {
  const out = new Uint8ClampedArray(w * h * 4)
  const n = w * 2 ** z
  const exaggeration = Math.max(1, 2 ** ((11 - z) / 2))
  const lx = Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION)
  const ly = Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ELEVATION)
  const lz = Math.sin(SUN_ELEVATION)
  for (let r = 0; r < h; r++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * h + r + 0.5)) / n)))
    const px = (EARTH_CIRCUMFERENCE * Math.cos(lat)) / n
    // One-sided differences at the tile edge (no neighbour tile to read).
    const r0 = Math.max(0, r - 1),
      r1 = Math.min(h - 1, r + 1)
    for (let c = 0; c < w; c++) {
      const c0 = Math.max(0, c - 1),
        c1 = Math.min(w - 1, c + 1)
      const east = ((elev[r * w + c1] - elev[r * w + c0]) / ((c1 - c0) * px)) * exaggeration
      const north = ((elev[r0 * w + c] - elev[r1 * w + c]) / ((r1 - r0) * px)) * exaggeration
      const shade = Math.max(0, (-east * lx - north * ly + lz) / Math.sqrt(east * east + north * north + 1))
      const v = 255 * (0.25 + 0.75 * shade)
      const i = (r * w + c) * 4
      out[i] = out[i + 1] = out[i + 2] = v
      out[i + 3] = 255
    }
  }
  return out
}

// The 2D map's base layers as OpenLayers layers. OSM, satellite and terrain are
// Web-Mercator tiles (auto-reprojected by OL) for Mercator-compatible CRS; NASA
// GIBS WMTS for polar CRS. Which one a frame gets is core/basemapChoice.js; the
// catalogue is core/basemaps.js.

import TileLayer from 'ol/layer/Tile'
import OSM from 'ol/source/OSM'
import XYZ from 'ol/source/XYZ'
import ImageTileSource from 'ol/source/ImageTile'
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS'
import WMTSCapabilities from 'ol/format/WMTSCapabilities'
import {
  SATELLITE, TERRAIN, CUSTOM_SATELLITE_MAX_ZOOM, customAttribution, decodeTerrarium, hillshade,
} from '../../../core/basemaps.js'

function makeOsmLayer() {
  return new TileLayer({ source: new OSM() })
}

// Esri World Imagery, or the user's own XYZ source from Settings.
function makeSatelliteLayer(url, attribution) {
  const options = url
    ? { url, maxZoom: CUSTOM_SATELLITE_MAX_ZOOM, attributions: customAttribution(url, attribution) }
    : { url: SATELLITE.url, maxZoom: SATELLITE.maxZoom, attributions: SATELLITE.attributions }
  return new TileLayer({ source: new XYZ({ ...options, crossOrigin: 'anonymous' }) })
}

// Terrain: elevation tiles shaded on a canvas per tile. Shading the source tile
// (not the screen) keeps the slopes true to the ground and lets OL reproject
// and upsample the result like any image tile.
async function loadHillshadeTile(z, x, y, { signal }) {
  const res = await fetch(TERRAIN.url(z, x, y), { signal })
  if (!res.ok) throw new Error(`Terrain tile ${z}/${x}/${y}: HTTP ${res.status}`)
  // The PNG's bytes ARE the elevations: no colour management, no premultiply.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const { width: w, height: h } = bitmap
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const shaded = hillshade(decodeTerrarium(ctx.getImageData(0, 0, w, h).data, w, h), w, h, z, y)
  ctx.putImageData(new ImageData(shaded, w, h), 0, 0)
  return canvas
}

function makeTerrainLayer() {
  return new TileLayer({ source: new ImageTileSource({
    loader: loadHillshadeTile, maxZoom: TERRAIN.maxZoom, attributions: TERRAIN.attributions,
  }) })
}

/**
 * The tile layer for a synchronous basemap kind ('satellite' | 'terrain' |
 * 'osm'; core/basemapChoice.js). `satellite` is the Settings source
 * `{ url, attribution }` ('' url = Esri World Imagery).
 */
export function makeBasemapLayer(kind, satellite) {
  if (kind === 'satellite') return makeSatelliteLayer(satellite.url, satellite.attribution)
  if (kind === 'terrain') return makeTerrainLayer()
  if (kind === 'osm') return makeOsmLayer()
  return null
}

/** The polar GIBS layer for `info.gibs`: fetches + parses the WMTS capabilities. */
export async function makeGibsLayer(info) {
  const url = `${info.gibs.endpoint}?SERVICE=WMTS&REQUEST=GetCapabilities`
  const text = await (await fetch(url)).text()
  const caps = new WMTSCapabilities().read(text)
  const opts = optionsFromCapabilities(caps, {
    layer: info.gibs.layer,
    matrixSet: info.gibs.matrixSet,
  })
  if (!opts) throw new Error('GIBS layer not found in capabilities')
  return new TileLayer({ source: new WMTS(opts) })
}

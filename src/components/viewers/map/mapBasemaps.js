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
  SATELLITE, TERRAIN, CUSTOM_SATELLITE_MAX_ZOOM, customAttribution, hillshade,
} from '../../../core/basemaps.js'
import { fetchTerrariumTile } from '../../../core/terrainHeights.js'

// Every basemap layer preloads all coarser levels under the view. Online this
// fills the screen sooner; offline it is what lets the service worker's cached
// low-zoom tiles (core/offlineCache.js) stand in, upsampled, for the detailed
// levels it never stored.
const basemapLayer = (source) => new TileLayer({ source, preload: Infinity })

function makeOsmLayer() {
  return basemapLayer(new OSM())
}

// Esri World Imagery, or the user's own XYZ source from Settings.
function makeSatelliteLayer(url, attribution) {
  const options = url
    ? { url, maxZoom: CUSTOM_SATELLITE_MAX_ZOOM, attributions: customAttribution(url, attribution) }
    : { url: SATELLITE.url, maxZoom: SATELLITE.maxZoom, attributions: SATELLITE.attributions }
  return basemapLayer(new XYZ({ ...options, crossOrigin: 'anonymous' }))
}

// Terrain: elevation tiles shaded on a canvas per tile. Shading the source tile
// (not the screen) keeps the slopes true to the ground and lets OL reproject
// and upsample the result like any image tile.
async function loadHillshadeTile(z, x, y, { signal }) {
  const { elev, w, h } = await fetchTerrariumTile(z, x, y, { signal })
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').putImageData(new ImageData(hillshade(elev, w, h, z, y), w, h), 0, 0)
  return canvas
}

function makeTerrainLayer() {
  return basemapLayer(new ImageTileSource({
    loader: loadHillshadeTile, maxZoom: TERRAIN.maxZoom, attributions: TERRAIN.attributions,
  }))
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
  // CORS (GIBS allows it), so the service worker can cache the tiles: it stores
  // no opaque responses.
  return basemapLayer(new WMTS({ ...opts, crossOrigin: 'anonymous' }))
}

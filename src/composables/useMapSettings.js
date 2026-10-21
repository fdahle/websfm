import { ref } from 'vue'
import { BASEMAP_VALUES as VALUES, tileUrlError } from '../core/basemaps.js'

// Machine-level map preference, set from Settings or View ▸ Map ▸ Basemap ▾
// (catalogue: core/basemaps.js). "auto" keeps the CRS-aware default (OSM for
// ordinary CRSs, NASA GIBS for the polar presets).
const STORAGE_KEY = 'mapBasemap'
const stored = localStorage.getItem(STORAGE_KEY)
const basemap = ref(VALUES.includes(stored) ? stored : 'auto')

// The Satellite layer's source: '' = Esri World Imagery, else the user's own XYZ
// template (it may carry their API key, so it stays in this browser only).
const SAT_URL_KEY = 'mapSatelliteUrl'
const SAT_ATTRIBUTION_KEY = 'mapSatelliteAttribution'
const readKey = (key) => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
const satelliteUrl = ref(tileUrlError(readKey(SAT_URL_KEY)) ? '' : readKey(SAT_URL_KEY))
const satelliteAttribution = ref(readKey(SAT_ATTRIBUTION_KEY))

export function useMapSettings() {
  function setBasemap(value) {
    if (!VALUES.includes(value)) return
    basemap.value = value
    localStorage.setItem(STORAGE_KEY, value)
  }

  // Returns why `url` was refused, or '' once both values are saved.
  function setSatelliteSource(url, attribution) {
    const error = tileUrlError(url)
    if (error) return error
    satelliteUrl.value = url.trim()
    satelliteAttribution.value = attribution.trim()
    localStorage.setItem(SAT_URL_KEY, satelliteUrl.value)
    localStorage.setItem(SAT_ATTRIBUTION_KEY, satelliteAttribution.value)
    return ''
  }

  return { basemap, setBasemap, satelliteUrl, satelliteAttribution, setSatelliteSource }
}

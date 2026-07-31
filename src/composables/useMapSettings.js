import { ref } from 'vue'

// Machine-level map preference. "auto" keeps the CRS-aware default (OSM for
// ordinary CRSs, NASA GIBS for the polar presets); the explicit choices are
// useful offline, for screenshots, or when a background is distracting.
const STORAGE_KEY = 'mapBasemap'
const VALUES = ['auto', 'streets', 'none']
const stored = localStorage.getItem(STORAGE_KEY)
const basemap = ref(VALUES.includes(stored) ? stored : 'auto')

export function useMapSettings() {
  function setBasemap(value) {
    if (!VALUES.includes(value)) return
    basemap.value = value
    localStorage.setItem(STORAGE_KEY, value)
  }

  return { basemap, setBasemap }
}

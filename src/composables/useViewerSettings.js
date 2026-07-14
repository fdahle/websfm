import { ref } from 'vue'

// 3D-viewer display preferences. Persisted to localStorage (like useTheme /
// useGlossarySettings) so they survive reloads, held in a single shared ref so the
// Settings toggle and the viewer read/write the same state.

// Vertical placement of the ground graticule relative to the loaded point cloud:
// 'min' = bottom of the cloud, 'avg' = middle, 'max' = top.
const GRATICULE_Z_KEY = 'graticuleZ'
const GRATICULE_Z_VALUES = ['min', 'avg', 'max']
const stored = localStorage.getItem(GRATICULE_Z_KEY)
const graticuleZ = ref(GRATICULE_Z_VALUES.includes(stored) ? stored : 'avg') // default middle

export function useViewerSettings() {
  function setGraticuleZ(v) {
    if (!GRATICULE_Z_VALUES.includes(v)) return
    graticuleZ.value = v
    localStorage.setItem(GRATICULE_Z_KEY, v)
  }
  return { graticuleZ, setGraticuleZ }
}

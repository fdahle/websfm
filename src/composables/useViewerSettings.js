import { ref } from 'vue'

// 3D-viewer display preferences. Persisted to localStorage (like useTheme /
// useGlossarySettings) so they survive reloads, held in a single shared ref so the
// Settings toggle and the viewer read/write the same state.

// Vertical placement of the ground grid relative to the loaded point cloud:
// 'min' = bottom of the cloud, 'avg' = middle, 'max' = top.
const GRID_Z_KEY = 'gridZ'
const LEGACY_GRID_Z_KEY = 'graticuleZ'   // pre-rename projects keep their choice
const GRID_Z_VALUES = ['min', 'avg', 'max']
const stored = localStorage.getItem(GRID_Z_KEY) ?? localStorage.getItem(LEGACY_GRID_Z_KEY)
const gridZ = ref(GRID_Z_VALUES.includes(stored) ? stored : 'avg') // default middle

export function useViewerSettings() {
  function setGridZ(v) {
    if (!GRID_Z_VALUES.includes(v)) return
    gridZ.value = v
    localStorage.setItem(GRID_Z_KEY, v)
  }
  return { gridZ, setGridZ }
}

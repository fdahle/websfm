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

const BACKGROUND_KEY = 'viewer3dBackground'
const BACKGROUND_VALUES = ['theme', 'dark', 'light', 'black']
const storedBackground = localStorage.getItem(BACKGROUND_KEY)
const background = ref(BACKGROUND_VALUES.includes(storedBackground) ? storedBackground : 'theme')
const NEAR_KEY = 'viewer3dNearClip'
const storedNear = Number(localStorage.getItem(NEAR_KEY))
const nearClip = ref(Number.isFinite(storedNear) && storedNear >= 0 && storedNear <= 1000 ? storedNear : 0)

export function useViewerSettings() {
  function setGridZ(v) {
    if (!GRID_Z_VALUES.includes(v)) return
    gridZ.value = v
    localStorage.setItem(GRID_Z_KEY, v)
  }
  function setBackground(v) {
    if (!BACKGROUND_VALUES.includes(v)) return
    background.value = v
    localStorage.setItem(BACKGROUND_KEY, v)
  }
  function setNearClip(value) {
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0 || number > 1000) return
    nearClip.value = number === 0 ? 0 : Math.max(0.000001, number)
    localStorage.setItem(NEAR_KEY, String(nearClip.value))
  }
  return { gridZ, setGridZ, background, setBackground, nearClip, setNearClip }
}

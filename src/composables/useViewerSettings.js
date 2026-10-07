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

// Point-cloud dot size (px, no size attenuation) and the multiplier on the auto
// camera-frustum size. Set from the ribbon's View ▸ Scene steppers.
const POINT_SIZE_KEY = 'viewer3dPointSize'
const CAMERA_SCALE_KEY = 'viewer3dCameraScale'
function readNumber(key, min, max, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const v = Number(raw)
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback
  } catch { return fallback }
}
function writeValue(key, v) {
  try { localStorage.setItem(key, String(v)) } catch { /* private mode: session only */ }
}
const pointSize = ref(readNumber(POINT_SIZE_KEY, 1, 8, 3))
const cameraScale = ref(readNumber(CAMERA_SCALE_KEY, 0.2, 3, 1))

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
  function setPointSize(value) {
    const v = Number(value)
    if (!Number.isFinite(v) || v < 1 || v > 8) return
    pointSize.value = v
    writeValue(POINT_SIZE_KEY, v)
  }
  function setCameraScale(value) {
    const v = Number(value)
    if (!Number.isFinite(v) || v < 0.2 || v > 3) return
    cameraScale.value = v
    writeValue(CAMERA_SCALE_KEY, v)
  }
  return {
    gridZ, setGridZ, background, setBackground, nearClip, setNearClip,
    pointSize, setPointSize, cameraScale, setCameraScale,
  }
}

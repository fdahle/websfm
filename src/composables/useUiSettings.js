import { ref } from 'vue'

// UI preferences for the pipeline-stage modals. Persisted to localStorage (like
// useGlossarySettings/useTheme) so they survive reloads. A single shared ref so the
// Settings toggle and every AdvancedDisclosure read/write the same state.
//
// advancedSettingsExpanded: whether pipeline modals open with their "Advanced settings"
// disclosure already expanded (all knobs visible) vs collapsed to just the preset cards.
// Default off — most runs are "pick a preset and go".
const STORAGE_KEY = 'advancedSettingsExpanded'
const advancedExpanded = ref(localStorage.getItem(STORAGE_KEY) === 'true') // default off

const MOTION_KEY = 'websfm.ui.motion'
const MOTION_VALUES = ['system', 'reduce']
const storedMotion = localStorage.getItem(MOTION_KEY)
const motion = ref(MOTION_VALUES.includes(storedMotion) ? storedMotion : 'system')

function applyUiPreferences() {
  document.documentElement.toggleAttribute('data-reduce-motion', motion.value === 'reduce')
}

applyUiPreferences()

export function useUiSettings() {
  function setAdvancedExpanded(v) {
    advancedExpanded.value = !!v
    localStorage.setItem(STORAGE_KEY, String(!!v))
  }
  function setMotion(v) {
    if (!MOTION_VALUES.includes(v)) return
    motion.value = v
    localStorage.setItem(MOTION_KEY, v)
    applyUiPreferences()
  }
  return {
    advancedSettingsExpanded: advancedExpanded,
    setAdvancedSettingsExpanded: setAdvancedExpanded,
    motion,
    setMotion,
  }
}

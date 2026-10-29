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

// confirmRemoveMark: ask before removing one image mark of a control point/marker.
// The dialog's "Don't ask again" turns it off; the Settings toggle turns it back on.
const CONFIRM_REMOVE_MARK_KEY = 'websfm.ui.confirmRemoveMark'
const confirmRemoveMark = ref(localStorage.getItem(CONFIRM_REMOVE_MARK_KEY) !== 'false') // default on

// keepAwake: hold a screen wake lock while a stage or workflow runs, so the display
// (and with it, on most systems, the machine) does not go to sleep mid-run. Default on.
const KEEP_AWAKE_KEY = 'websfm.ui.keepAwake'
const keepAwake = ref(localStorage.getItem(KEEP_AWAKE_KEY) !== 'false')

// notifyWhenDone: a desktop notification when a long run ends while the tab is hidden.
// Default off: it needs the browser's permission, asked when the user turns it on.
const NOTIFY_KEY = 'websfm.ui.notifyWhenDone'
const notifySupported = typeof Notification !== 'undefined'
const notifyWhenDone = ref(
  notifySupported && localStorage.getItem(NOTIFY_KEY) === 'true' && Notification.permission === 'granted',
)

// showBugButton: the floating "report a bug" button at the bottom right (App.vue).
// Default on; Other ▸ About links to GitHub's issues either way.
const BUG_BUTTON_KEY = 'websfm.ui.showBugButton'
const showBugButton = ref(localStorage.getItem(BUG_BUTTON_KEY) !== 'false')

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
  function setConfirmRemoveMark(v) {
    confirmRemoveMark.value = !!v
    localStorage.setItem(CONFIRM_REMOVE_MARK_KEY, String(!!v))
  }
  function setShowBugButton(v) {
    showBugButton.value = !!v
    localStorage.setItem(BUG_BUTTON_KEY, String(!!v))
  }
  function setKeepAwake(v) {
    keepAwake.value = !!v
    localStorage.setItem(KEEP_AWAKE_KEY, String(!!v))
  }
  // Turning it on asks for the permission; a refusal leaves it off. Returns the
  // permission state, so the caller can say why it stayed off.
  async function setNotifyWhenDone(v) {
    let permission = notifySupported ? Notification.permission : 'unsupported'
    if (v && permission === 'default') {
      try {
        permission = await Notification.requestPermission()
      } catch {
        permission = 'denied'
      }
    }
    notifyWhenDone.value = !!v && permission === 'granted'
    localStorage.setItem(NOTIFY_KEY, String(notifyWhenDone.value))
    return permission
  }
  return {
    keepAwake,
    setKeepAwake,
    notifySupported,
    notifyWhenDone,
    setNotifyWhenDone,
    advancedSettingsExpanded: advancedExpanded,
    setAdvancedSettingsExpanded: setAdvancedExpanded,
    motion,
    setMotion,
    confirmRemoveMark,
    setConfirmRemoveMark,
    showBugButton,
    setShowBugButton,
  }
}

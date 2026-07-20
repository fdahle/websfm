import { ref, computed } from 'vue'

// Shared state for the non-Chromium browser warning (see BrowserWarning.vue).
// The warning fires only on non-Chromium engines AND only while not dismissed;
// "Don't show this again" and the Settings ▸ Display toggle write the same
// localStorage flag through this one shared ref so they can't drift.
const STORAGE_KEY = 'browserWarningDismissed'

// Chromium-based: Chrome, Edge, Opera, Brave, … all report the "Chromium" brand
// (or match the Chrome UA token without being Firefox/Safari). Everything else
// (Firefox, Safari) is treated as potentially unsupported.
function detectChromium() {
  const brands = navigator.userAgentData?.brands
  if (Array.isArray(brands)) {
    return brands.some(b => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand))
  }
  const ua = navigator.userAgent || ''
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua)
}

const dismissed = ref(localStorage.getItem(STORAGE_KEY) === 'true')
const isChromium = detectChromium()

export function useBrowserWarning() {
  // The toast is only ever relevant on a non-Chromium browser.
  const shouldWarn = computed(() => !isChromium && !dismissed.value)

  function dismiss() {
    dismissed.value = true
    localStorage.setItem(STORAGE_KEY, 'true')
  }
  // Settings toggle: "Warn on unsupported browsers" — on ⇒ not dismissed.
  function setEnabled(v) {
    dismissed.value = !v
    localStorage.setItem(STORAGE_KEY, String(!v))
  }

  return {
    isChromium,
    warningEnabled: computed(() => !dismissed.value),
    shouldWarn,
    dismiss,
    setEnabled,
  }
}

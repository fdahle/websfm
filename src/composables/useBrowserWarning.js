import { ref, computed } from 'vue'
import { browserWarnings } from '../core/browserSupport.js'
import { browserCaps } from '../utils/browserCaps.js'

// Shared state for the browser warning (see BrowserWarning.vue). It lists what this
// browser lacks (core/browserSupport.js), in any engine: a Chrome without a WebGPU
// adapter is named too. It shows while something is missing AND it is not dismissed;
// "Don't show this again" and the Settings ▸ Display toggle write the same
// localStorage flag through this one shared ref so they can't drift.
const STORAGE_KEY = 'browserWarningDismissed'

// Chromium-based: Chrome, Edge, Opera, Brave, … all report the "Chromium" brand
// (or match the Chrome UA token without being Firefox/Safari). Everything else
// (Firefox, Safari) is treated as potentially unsupported.
function detectChromium() {
  const brands = navigator.userAgentData?.brands
  if (Array.isArray(brands)) {
    return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand))
  }
  const ua = navigator.userAgent || ''
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua)
}

const dismissed = ref(localStorage.getItem(STORAGE_KEY) === 'true')
const isChromium = detectChromium()
// What the warning lists, once the probe has answered.
const gaps = ref([])
browserCaps()
  .then((caps) => (gaps.value = browserWarnings(caps)))
  .catch(() => {})

export function useBrowserWarning() {
  const shouldWarn = computed(() => gaps.value.length > 0 && !dismissed.value)

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
    gaps,
    warningEnabled: computed(() => !dismissed.value),
    shouldWarn,
    dismiss,
    setEnabled,
  }
}

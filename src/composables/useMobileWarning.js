import { ref, computed } from 'vue'

// Shared state for the mobile / touch-device warning (see MobileWarning.vue).
// websfm is a desktop application: it runs SIFT, bundle adjustment and dense MVS
// in WASM workers, keeps whole projects in OPFS, and its layout (ribbon, sidebar,
// canvas viewers) assumes a pointer and a wide window. None of that has a mobile
// story, so the first thing a phone/tablet user sees is a blocking acknowledgement.
//
// Same two-flag pattern as useBrowserWarning: one localStorage key, written by both
// the modal's confirm button and the Settings ▸ Display toggle through this one
// shared ref so the two can't drift.
const STORAGE_KEY = 'mobileWarningAcknowledged'

// Detect the *device*, not the window size — a narrow desktop window is still a
// desktop, and shrinking one must not raise a blocking dialog. Signals in order of
// authority:
//   1. userAgentData.mobile — Chromium's explicit answer, no sniffing.
//   2. UA tokens — the classic phone/tablet markers.
//   3. iPadOS 13+ ships a desktop Safari UA ("Macintosh"), so a Mac reporting real
//      touch points is an iPad.
//   4. Media queries — a coarse primary pointer that can't hover: the generic
//      touch-only fallback for anything the above missed.
function detectMobile() {
  if (typeof navigator === 'undefined') return false

  if (typeof navigator.userAgentData?.mobile === 'boolean') {
    if (navigator.userAgentData.mobile) return true
  }

  const ua = navigator.userAgent || ''
  if (/Android|iPhone|iPad|iPod|Windows Phone|IEMobile|Opera Mini|Mobile Safari/i.test(ua)) return true
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true

  const mq = typeof window !== 'undefined' ? window.matchMedia : null
  if (mq) {
    return mq.call(window, '(pointer: coarse)').matches && mq.call(window, '(hover: none)').matches
  }
  return false
}

const acknowledged = ref(localStorage.getItem(STORAGE_KEY) === 'true')
const isMobile = detectMobile()

export function useMobileWarning() {
  // Only ever relevant on a touch/mobile device that hasn't acknowledged yet.
  const shouldWarn = computed(() => isMobile && !acknowledged.value)

  function acknowledge() {
    acknowledged.value = true
    localStorage.setItem(STORAGE_KEY, 'true')
  }
  // Settings toggle: "Warn on mobile devices" — on ⇒ not acknowledged.
  function setEnabled(v) {
    acknowledged.value = !v
    localStorage.setItem(STORAGE_KEY, String(!v))
  }

  return {
    isMobile,
    warningEnabled: computed(() => !acknowledged.value),
    shouldWarn,
    acknowledge,
    setEnabled,
  }
}

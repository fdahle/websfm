import { ref } from 'vue'

// Image-view toggles: the overlay switches (keypoints/mask/depth/GCPs/fiducials) and
// the edit modes (mask paint / GCP marking). These are GLOBAL, not per-tab — every
// image tab renders from this one shared ref, so switching images (or reopening an
// already-open tab) never changes them. Persisted to localStorage (like
// useUiSettings/useViewerSettings) so a reload looks identical too.
//
// The one per-image nuance stays out of here: the keypoint overlay can only draw on a
// detected image, so App.vue gates the (global) showKeypoints on each image's kpStatus.
//
// Invariants mirrored from App.vue's toggle handlers, enforced here so a corrupted or
// hand-edited localStorage entry can't restore an impossible combination:
//   - mask and depth overlays are mutually exclusive
//   - mask-edit and gcp-edit are mutually exclusive
const STORAGE_KEY = 'imageViewToggles'

const DEFAULTS = {
  showKeypoints: true,
  showMask:      false,
  showDepth:     false,
  showGcps:      false,
  showFiducials: true,
  maskEdit:      false,
  gcpEdit:       false,
}

function normalize(p) {
  const out = {}
  for (const k of Object.keys(DEFAULTS)) out[k] = typeof p?.[k] === 'boolean' ? p[k] : DEFAULTS[k]
  if (out.showMask) out.showDepth = false
  if (out.maskEdit) { out.gcpEdit = false; out.showDepth = false }
  if (out.gcpEdit) out.showGcps = true
  return out
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalize(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULTS }
  }
}

const imageViewPrefs = ref(load())

export function useImageViewSettings() {
  function setImageViewPrefs(p) {
    imageViewPrefs.value = normalize(p)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(imageViewPrefs.value))
    } catch {
      // storage full / disabled — prefs still stick for this session
    }
  }
  return { imageViewPrefs, setImageViewPrefs }
}

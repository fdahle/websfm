import { computed, ref, watch } from 'vue'

// Appearance. The user's *preference* is one of 'system' | 'light' | 'dark';
// 'system' follows the OS via `prefers-color-scheme` and re-resolves live when
// the OS flips (a macOS/Windows auto light-dark schedule changes it under a
// running tab). `theme` is the *resolved* value — the only thing the UI and the
// 3D viewer should ever branch on. Module-scoped refs so every consumer shares
// one value (same pattern as useUiSettings / useGlossarySettings).
const STORAGE_KEY = 'theme'
const PREFERENCES = ['system', 'light', 'dark']

const media = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function storedPreference() {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  // Older builds only ever stored 'dark'/'light', both still valid. No stored
  // value ⇒ follow the OS rather than the old hardcoded dark default.
  return PREFERENCES.includes(v) ? v : 'system'
}

const themePreference = ref(storedPreference())
const systemDark = ref(media ? media.matches : true)

if (media) {
  const onChange = (e) => { systemDark.value = e.matches }
  // Safari <14 has no addEventListener on MediaQueryList.
  if (media.addEventListener) media.addEventListener('change', onChange)
  else media.addListener(onChange)
}

const theme = computed(() => (
  themePreference.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themePreference.value
))

// `data-theme` is always written explicitly (never removed for dark): rules keyed
// on [data-theme="dark"] — ViewerMap's OpenLayers attribution, for one — only
// match when the attribute is present. `color-scheme` makes native scrollbars and
// form controls follow along.
function applyTheme(t = theme.value) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark')
  document.documentElement.style.colorScheme = t === 'light' ? 'light' : 'dark'
}

function setTheme(pref) {
  const next = PREFERENCES.includes(pref) ? pref : 'system'
  themePreference.value = next
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* private mode */ }
}

// Order matches the settings toggle, so the quick button and the settings panel
// tell the same story.
function cycleTheme() {
  const i = PREFERENCES.indexOf(themePreference.value)
  setTheme(PREFERENCES[(i + 1) % PREFERENCES.length])
}

watch(theme, (t) => applyTheme(t), { immediate: true })

export function useTheme() {
  return { theme, themePreference, systemDark, applyTheme, setTheme, cycleTheme, THEME_PREFERENCES: PREFERENCES }
}

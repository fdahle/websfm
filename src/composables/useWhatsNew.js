import { computed, ref } from 'vue'
import { countNewEntries, latestRelease, parseChangelog } from '../core/help/changelog.js'

// Help ▸ What's New: CHANGELOG.md, and how many of its entries shipped since this
// browser last opened it (the ribbon's badge). The changelog (~80 KB) is fetched
// after start-up, not in the entry chunk. The first visit counts nothing as new:
// a new user has not missed anything, so it only records the current version.

const STORAGE_KEY = 'whatsNewSeen'

function readSeen() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export const releases = ref(null) // parseChangelog(CHANGELOG.md) once loaded
const seen = ref(readSeen())
let loading = null

export function loadChangelog() {
  loading ??= import('../../CHANGELOG.md?raw').then(
    (m) => {
      releases.value = parseChangelog(m.default)
      if (!seen.value) markSeen()
    },
    (error) => {
      loading = null
      console.warn("[help] could not load What's New:", error)
    },
  )
  return loading
}

// Entries released since the version this browser last saw (0 until loaded).
export const newCount = computed(() => (releases.value ? countNewEntries(releases.value, seen.value) : 0))
export const seenVersion = computed(() => seen.value)

export function markSeen() {
  const latest = releases.value && latestRelease(releases.value)
  if (!latest) return
  seen.value = latest
  try {
    localStorage.setItem(STORAGE_KEY, latest)
  } catch {
    // private window or blocked storage: the badge just comes back next visit
  }
}

import { ref } from 'vue'

// Module-level singleton — any file can import useLog() and share the same entries.
const entries = ref([])
let _seq = 0

export function useLog() {
  function log(message, level = 'info', source = null) {
    const now = new Date()
    const hms = now.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const ms  = now.getMilliseconds().toString().padStart(3, '0')
    // Globally-unique id: the wall-clock stamp disambiguates across page reloads
    // (where _seq resets to 0), _seq disambiguates entries within the same ms. A
    // plain ++_seq collides with persisted-then-restored entries — duplicate Vue
    // :key — which surfaced as doubled console lines after reopening a project.
    entries.value.push({ id: `${now.getTime().toString(36)}-${(++_seq).toString(36)}`, time: `${hms}.${ms}`, level, message, source })
    if (entries.value.length > 1000) entries.value.shift()
  }

  function clear() {
    entries.value = []
  }

  return { entries, log, clear }
}

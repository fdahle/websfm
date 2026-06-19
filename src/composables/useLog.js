import { ref } from 'vue'

// Module-level singleton — any file can import useLog() and share the same entries.
const entries = ref([])
let _seq = 0

export function useLog() {
  function log(message, level = 'info') {
    const now = new Date()
    const hms = now.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const ms  = now.getMilliseconds().toString().padStart(3, '0')
    entries.value.push({ id: ++_seq, time: `${hms}.${ms}`, level, message })
    if (entries.value.length > 1000) entries.value.shift()
  }

  function clear() {
    entries.value = []
  }

  return { entries, log, clear }
}

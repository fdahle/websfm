import { ref } from 'vue'
// Re-export the pure formatter so existing consumers keep importing it from here;
// its implementation lives in utils/ (Vue-free) so it can be unit-tested.
export { stripSourcePrefix } from '../utils/logFormat.js'

// Module-level singleton — any file can import useLog() and share the same entries.
const entries = ref([])
let _seq = 0

// The live display window is capped: only the most recent MAX_BUFFER lines stay
// in memory (a full SfM/dense run logs many thousands). Older lines are shifted
// out of `entries` but are NOT lost — every line is also queued in `pending` for
// the store to append to the on-disk stream (utils/opfs `appendLog`), which is
// the full record scroll-back and export read from.
export const MAX_BUFFER = 5000

// Lines logged but not yet persisted. Separate from `entries` precisely because
// `entries` is capped: a shifted-out line must still reach the file. The store
// drains this via takePending() on a debounce; `onLog` lets it schedule that.
const pending = []
const listeners = new Set()

export function useLog() {
  // `opts.channel` separates the two kinds of line that share this stream:
  //   'pipeline' (default) — the scientific/process record: what a detector,
  //     matcher, SfM/dense run, or import actually did. This is the audit trail
  //     the user exports and reads back.
  //   'activity' — a one-line confirmation that the *user* just did something
  //     reversible (toggled a match, enabled a GCP, set a cloud as main…). Shown
  //     live so the action is acknowledged, kept for scroll-back, but off the
  //     default export so it never clogs the record.
  // The console renders them in separate tabs; entries persist either way.
  function log(message, level = 'info', source = null, opts = {}) {
    const channel = opts.channel === 'activity' ? 'activity' : 'pipeline'
    const now = new Date()
    const hms = now.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const ms  = now.getMilliseconds().toString().padStart(3, '0')
    // Globally-unique id: the wall-clock stamp disambiguates across page reloads
    // (where _seq resets to 0), _seq disambiguates entries within the same ms. A
    // plain ++_seq collides with persisted-then-restored entries — duplicate Vue
    // :key — which surfaced as doubled console lines after reopening a project.
    // The id is also the anchor scroll-back uses to locate a line in the stream.
    const entry = { id: `${now.getTime().toString(36)}-${(++_seq).toString(36)}`, time: `${hms}.${ms}`, level, message, source, channel }
    entries.value.push(entry)
    if (entries.value.length > MAX_BUFFER) entries.value.shift()
    pending.push(entry)
    for (const fn of listeners) fn()
  }

  function clear() {
    entries.value = []
  }

  // Subscribe to logging activity (the store uses this to schedule a flush).
  // Returns an unsubscribe fn.
  function onLog(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  // Hand off the queued-but-unpersisted lines, clearing the queue.
  function takePending() {
    return pending.length ? pending.splice(0, pending.length) : []
  }

  return { entries, log, clear, onLog, takePending, MAX_BUFFER }
}

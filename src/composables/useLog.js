import { shallowRef, triggerRef } from 'vue'
// Re-export the pure formatter so existing consumers keep importing it from here;
// its implementation lives in utils/ (Vue-free) so it can be unit-tested.
export { stripSourcePrefix } from '../utils/logFormat.js'

// Module-level singleton — any file can import useLog() and share the same entries.
//
// A shallowRef over a plain array, NOT a deep ref: a pipeline logs one line per
// matched pair (8128 on a 128-image exhaustive run) and a deep reactive array made
// each line cost O(buffer) — `shift()` re-triggers every index once the buffer is
// full, and every consumer re-walks the whole array. Lines are appended in place and
// consumers are notified at most every NOTIFY_MS (`triggerRef`); everything that
// replaces the buffer assigns a new array, which notifies on its own.
//
// Dev only: the state lives in `import.meta.hot.data` so it survives a hot update of
// THIS file. Without that, an edit here gave the re-mounted console a fresh, empty
// buffer while every already-created Pinia store kept logging into the old module's
// — the console went silent with no error until a full reload (2026-10-05).
const shared = import.meta.hot?.data?.logState
  ?? { entries: shallowRef([]), pending: [], listeners: new Set(), seq: 0 }
if (import.meta.hot) import.meta.hot.data.logState = shared
const entries = shared.entries
const NOTIFY_MS = 50
let notifyTimer = null
function notifySoon() {
  if (notifyTimer != null) return
  notifyTimer = setTimeout(() => { notifyTimer = null; triggerRef(entries) }, NOTIFY_MS)
}

// The live display window is capped: only the most recent MAX_BUFFER lines stay
// in memory (a full SfM/dense run logs many thousands). Older lines are shifted
// out of `entries` but are NOT lost — every line is also queued in `pending` for
// the store to append to the on-disk stream (utils/opfs `appendLog`), which is
// the full record scroll-back and export read from.
export const MAX_BUFFER = 5000
// Overflow is trimmed in chunks, so the O(buffer) array move happens once per
// TRIM_CHUNK lines rather than on every line; the window holds MAX_BUFFER − TRIM_CHUNK
// … MAX_BUFFER lines.
const TRIM_CHUNK = 500

// Lines logged but not yet persisted. Separate from `entries` precisely because
// `entries` is capped: a shifted-out line must still reach the file. The store
// drains this via takePending() on a debounce; `onLog` lets it schedule that.
const pending = shared.pending
const listeners = shared.listeners

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
    // (where seq resets to 0), seq disambiguates entries within the same ms. A
    // plain ++seq collides with persisted-then-restored entries — duplicate Vue
    // :key — which surfaced as doubled console lines after reopening a project.
    // The id is also the anchor scroll-back uses to locate a line in the stream.
    const entry = { id: `${now.getTime().toString(36)}-${(++shared.seq).toString(36)}`, time: `${hms}.${ms}`, level, message, source, channel }
    const buf = entries.value
    buf.push(entry)
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - (MAX_BUFFER - TRIM_CHUNK))
    notifySoon()
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

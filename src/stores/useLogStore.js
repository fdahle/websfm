import { defineStore } from 'pinia'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'

// Project-scoped persistence for the dev console.
//
// The console entries live in the useLog() singleton (shared by every logging
// call). This store gives them a per-project lifecycle and, crucially, streams
// *every* line to an append-only OPFS file (`log.ndjson`) so the record is
// complete even though the in-memory display window is capped (MAX_BUFFER). That
// file is the source of truth: scroll-back loads older chunks from it, and TXT
// export reads all of it. So:
//   a) opening a different project starts from that project's own console,
//   b) reopening a project restores the tail it had when you left, and
//   c) no line is ever lost to the buffer cap — only shifted out of view.
export const useLogStore = registerProjectStore(defineStore('log', () => {
  const { entries, onLog, takePending, MAX_BUFFER } = useLog()
  const projects = useProjectsStore()

  const isPersisting = () => projects.isPersisting

  // Debounced, single-flight appender. Logging bursts (hundreds of lines during
  // a pipeline), so coalesce into batched appends ~0.8s after activity. Appends
  // must serialise — each reads the file size to seek to the end — so keep ≤1 in
  // flight with a trailing re-run, mirroring useImagesStore.sync().
  let timer = null
  let inFlight = false
  let again = false
  function cancelTimer() {
    if (timer) { clearTimeout(timer); timer = null }
  }
  function schedule() {
    if (!isPersisting()) return
    cancelTimer()
    timer = setTimeout(flush, 800)
  }
  async function flush() {
    cancelTimer()
    if (inFlight) { again = true; return }
    const pid = projects.currentProjectId
    // Not attributable to a project (pre-open boot logs): drop from the queue so
    // it can't grow unbounded, but leave the display window intact.
    if (!isPersisting() || !pid) { takePending(); return }
    const batch = takePending()
    if (batch.length === 0) return
    inFlight = true
    try { await opfs.appendLog(pid, batch) } catch {}
    inFlight = false
    if (again) { again = false; flush() }
  }
  // Every logged line schedules a flush; the queue itself lives in useLog.
  onLog(schedule)

  // Await all queued lines onto disk — used before reading the stream (export /
  // scroll-back) so the file reflects everything currently displayed.
  async function flushNow() {
    cancelTimer()
    while (inFlight) await new Promise(r => setTimeout(r, 20))
    const pid = projects.currentProjectId
    if (!isPersisting() || !pid) { takePending(); return }
    const batch = takePending()
    if (batch.length === 0) return
    inFlight = true
    try { await opfs.appendLog(pid, batch) } catch {}
    inFlight = false
  }

  // The complete stream for this project (export + scroll-back read from here).
  async function readAll() {
    const pid = projects.currentProjectId
    if (!pid) return []
    await flushNow()
    return (await opfs.readLog(pid)) || []
  }

  // Project-store contract: load this project's saved console.
  //
  // Seeds the display with the *tail* of the stream (last MAX_BUFFER lines),
  // placed in front of whatever restore-time messages have already accumulated
  // this open (sensors/images restore before us), so the user sees prior history
  // followed by the fresh restore activity. Unlike the old whole-array save,
  // appends are incremental, so no de-duplication is needed here.
  async function restore({ projectId }) {
    cancelTimer()
    let saved = await opfs.readLog(projectId)
    if (saved === null) {
      // Migrate the legacy whole-array log.json into the stream, once.
      const legacy = await opfs.loadLegacyLog(projectId)
      if (Array.isArray(legacy) && legacy.length) {
        await opfs.appendLog(projectId, legacy).catch(() => {})
        saved = legacy
      }
      await opfs.deleteLegacyLog(projectId)
    }
    if (!Array.isArray(saved) || saved.length === 0) return
    const tail = saved.slice(-MAX_BUFFER)
    entries.value = [...tail, ...entries.value]
    if (entries.value.length > MAX_BUFFER) entries.value = entries.value.slice(-MAX_BUFFER)
  }

  // Project-store contract: reset the console. On a plain clear (leaving a
  // project) flush any queued lines so reopening restores them; on a purge (new
  // project / delete) drop the saved stream entirely.
  function clear(opts = {}) {
    cancelTimer()
    const pid = projects.currentProjectId
    if (opts.purge) {
      takePending()
      if (isPersisting() && pid) opfs.deleteLog(pid).catch(() => {})
    } else {
      const batch = takePending()
      if (isPersisting() && pid && batch.length) opfs.appendLog(pid, batch).catch(() => {})
    }
    entries.value = []
  }

  // User "Clear" button: wipe both the display and the on-disk stream for the
  // current project (distinct from the lifecycle clear() above, which preserves
  // the file when leaving a project).
  async function clearConsole() {
    cancelTimer()
    takePending()
    entries.value = []
    const pid = projects.currentProjectId
    if (isPersisting() && pid) await opfs.truncateLog(pid).catch(() => {})
  }

  return {
    // project-store contract
    clear,
    restore,
    // console-facing API
    flushNow,
    readAll,
    clearConsole,
  }
}))

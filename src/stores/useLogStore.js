import { watch } from 'vue'
import { defineStore } from 'pinia'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'

// Project-scoped persistence for the dev console.
//
// The console entries live in the useLog() singleton (shared by every logging
// call). This store gives them a per-project lifecycle so that:
//   a) opening a different project starts from that project's own console
//      (not the previous project's leftover output), and
//   b) reopening a project restores the console it had when you left it.
//
// Entries are autosaved (debounced) as they arrive, and flushed on leave, so an
// in-progress project's console survives a page reload too.
export const useLogStore = registerProjectStore(defineStore('log', () => {
  const { entries } = useLog()
  const projects = useProjectsStore()

  const isPersisting = () => projects.isPersisting

  // Debounced writer — logging can burst (hundreds of lines during a pipeline),
  // so coalesce into one write ~1s after the last entry.
  let timer = null
  function cancelTimer() {
    if (timer) { clearTimeout(timer); timer = null }
  }
  function scheduleSave() {
    if (!isPersisting()) return
    cancelTimer()
    timer = setTimeout(flush, 1000)
  }
  function flush() {
    cancelTimer()
    if (!isPersisting()) return
    const pid = projects.currentProjectId
    if (!pid) return
    opfs.saveLog(pid, entries.value.slice()).catch(() => {})
  }

  // Distinguish our own programmatic rewrites (restore/clear) from genuine
  // logging so those don't trigger (or misdirect) a save. Sync flush keeps the
  // flag valid for the exact mutation that set it.
  let internal = false
  watch(() => entries.value.length, () => {
    if (internal) return
    scheduleSave()
  }, { flush: 'sync' })

  // Project-store contract: load this project's saved console.
  //
  // Prepends the saved history in front of whatever restore-time messages have
  // already accumulated this open (sensors/images restore before us), so the
  // user sees the old console followed by the fresh restore activity.
  async function restore({ projectId }) {
    cancelTimer()
    const saved = await opfs.loadLog(projectId)
    if (!Array.isArray(saved) || saved.length === 0) return
    internal = true
    // The stores that restore before us (sensors/images/matches/reconstruction)
    // have already logged this open's banner lines ("… restored"). The saved
    // console ends with the *previous* open's identical banners, so prepending it
    // verbatim stacks a duplicate copy on every reopen. Trim the contiguous tail
    // of `saved` whose content matches a fresh line before prepending; older
    // history (different content) is untouched.
    const sig = (e) => `${e.level}|${e.source}|${e.message}`
    const freshSigs = new Set(entries.value.map(sig))
    let end = saved.length
    while (end > 0 && freshSigs.has(sig(saved[end - 1]))) end--
    entries.value = [...saved.slice(0, end), ...entries.value]
    internal = false
  }

  // Project-store contract: reset the console. On a plain clear (leaving a
  // project) persist its console first so reopening restores it; on a purge
  // (new project / delete) drop the saved console entirely.
  function clear(opts = {}) {
    cancelTimer()
    const pid = projects.currentProjectId
    if (opts.purge) {
      if (isPersisting() && pid) opfs.deleteLog(pid).catch(() => {})
    } else if (isPersisting() && pid && entries.value.length) {
      opfs.saveLog(pid, entries.value.slice()).catch(() => {})
    }
    internal = true
    entries.value = []
    internal = false
  }

  return {
    // project-store contract
    clear,
    restore,
  }
}))

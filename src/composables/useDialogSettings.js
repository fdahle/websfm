import { ref, watch } from 'vue'
import * as opfs from '../utils/opfs.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useLog } from './useLog.js'
import { normalizeSettings, changedSettings, presetName } from '../core/dialogSettings.js'

// A processing dialog's settings, kept between runs (plan-after-0.7 ▸ PRE):
// - the last run's settings per project (`dialogs.json` in the project folder, so they
//   travel with it), which the dialog opens on;
// - named presets per browser (`dialog-presets.json` beside the project index), for a
//   kind of project one comes back to ("Film scans", "Fast preview");
// - Reset to the defaults.
// Only what differs from the defaults is kept, and it comes back through
// core/dialogSettings.js normalizeSettings, so a setting renamed since falls back to its
// default instead of reaching the run. `op` names the dialog (its guide article's id).
//
// useDialogSettings(op, defaults, { initial, exclude }) → { settings, presets, source,
//   remember, savePreset, applyPreset, deletePreset, reset }
//   initial   settings the dialog was opened with (a prefill, a Try again); they win
//             over the last run's
//   exclude   keys whose default depends on the project's state at the time (Match
//             only new pairs): never kept, never brought back
//   source    'last' when the dialog opened on the last run's settings, a preset's name
//             after one was applied, null otherwise

const PRESETS = 'dialog-presets.json'
const LAST = 'dialogs.json'
let presetsCache = null

async function allPresets() {
  if (!presetsCache) presetsCache = (await opfs.readAppJson(PRESETS).catch(() => null)) ?? {}
  return presetsCache
}

async function readLastFile(projectId) {
  const file = await opfs.getProjectFile(projectId, LAST).catch(() => null)
  if (!file) return {}
  try {
    return JSON.parse(await file.text()) ?? {}
  } catch {
    return {}
  }
}

// The open project's dialogs.json, read once when it opens (preloadDialogSettings, from
// useProjectLifecycle), so a dialog starts on its last run's settings before anything
// in it reacts to them.
let lastCache = { projectId: null, data: null }
async function readLast(projectId) {
  if (lastCache.projectId === projectId && lastCache.data) return lastCache.data
  const data = await readLastFile(projectId)
  lastCache = { projectId, data }
  return data
}
export function preloadDialogSettings(projectId) {
  if (projectId) readLast(projectId).catch(() => {})
}

export function useDialogSettings(op, defaults, { initial = null, exclude = [] } = {}) {
  const kept = Object.fromEntries(Object.entries(defaults).filter(([k]) => !exclude.includes(k)))
  const projects = useProjectsStore()
  const { log } = useLog()
  const settings = ref({ ...defaults, ...(initial ?? {}) })
  const presets = ref([])
  const source = ref(null)
  // Anything the user changes before the saved settings arrive stays.
  let touched = false
  const stop = watch(
    settings,
    () => {
      touched = true
    },
    { deep: true },
  )
  const projectId = projects.currentProjectId
  const applyLast = (data) => {
    const last = data?.[op]
    if (!last || touched || projects.currentProjectId !== projectId) return
    settings.value = { ...settings.value, ...normalizeSettings(last, kept).settings }
    source.value = 'last'
  }
  // Preloaded: in place before the dialog's own watchers run.
  if (!initial && projectId && lastCache.projectId === projectId && lastCache.data) applyLast(lastCache.data)
  if (presetsCache) presets.value = [...(presetsCache[op] ?? [])]

  ;(async () => {
    presets.value = [...((await allPresets())[op] ?? [])]
    if (initial || !projectId || source.value === 'last') return
    applyLast(await readLast(projectId))
  })()

  // The run's settings, kept as this project's last for the dialog.
  async function remember() {
    stop()
    if (!projectId) return
    try {
      const all = { ...(await readLast(projectId)) }
      all[op] = changedSettings(settings.value, kept)
      lastCache = { projectId, data: all }
      await opfs.writeProjectFile(projectId, LAST, JSON.stringify(all))
    } catch (err) {
      log(`Could not keep the dialog's settings (${err?.message ?? err})`, 'debug', 'Project')
    }
  }

  async function savePreset(name) {
    const n = presetName(name)
    if (!n) return false
    const all = await allPresets()
    const list = (all[op] ?? []).filter((p) => p.name !== n)
    list.push({ name: n, settings: changedSettings(settings.value, kept) })
    list.sort((a, b) => a.name.localeCompare(b.name))
    all[op] = list
    presets.value = [...list]
    source.value = n
    await opfs.writeAppJson(PRESETS, all)
    return true
  }

  function applyPreset(name) {
    const p = presets.value.find((x) => x.name === name)
    if (!p) return
    settings.value = { ...settings.value, ...normalizeSettings(p.settings, kept).settings }
    source.value = name
  }

  async function deletePreset(name) {
    const all = await allPresets()
    all[op] = (all[op] ?? []).filter((p) => p.name !== name)
    presets.value = [...all[op]]
    if (source.value === name) source.value = null
    await opfs.writeAppJson(PRESETS, all)
  }

  function reset() {
    settings.value = { ...settings.value, ...kept }
    source.value = null
  }

  return { settings, presets, source, remember, savePreset, applyPreset, deletePreset, reset }
}

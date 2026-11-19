import {
  PORTABLE_KEYS,
  RESET_KEYS,
  mergeDialogPresets,
  mergeTemplates,
  readSettingsFile,
  settingsExport,
} from '../core/preferences.js'
import { downloadBlob } from '../utils/download.js'
import { APP_VERSION } from '../utils/appBuild.js'
import { flushPersistence } from '../utils/persistence.js'
import * as opfs from '../utils/opfs.js'
import { PRESETS } from './useDialogSettings.js'
import { TEMPLATE_KEY } from '../stores/useWorkflowsStore.js'
import { useLog } from './useLog.js'

// Settings ▸ Storage ▸ Settings: this browser's preferences, dialog presets and
// workflow templates to a file and back, and Reset all settings. Which keys are which is
// core/preferences.js. Every setting is read once, when the app loads, so an import or a
// reset applies by reloading the page (the caller does, once these resolve).

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}
const presetCount = (all) => Object.values(all ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0)

export function useSettingsTransfer() {
  const { log } = useLog()

  async function exportSettings() {
    const stored = Object.fromEntries(PORTABLE_KEYS.map((k) => [k, localStorage.getItem(k)]))
    const dialogPresets = (await opfs.readAppJson(PRESETS).catch(() => null)) ?? {}
    const workflowTemplates = readJson(TEMPLATE_KEY, [])
    const file = settingsExport({ stored, dialogPresets, workflowTemplates, appVersion: APP_VERSION })
    downloadBlob('websfm-settings.json', JSON.stringify(file, null, 2), 'application/json')
    log(
      `Settings exported to websfm-settings.json: ${Object.keys(file.preferences).length.toLocaleString('en')} ` +
        `preferences, ${presetCount(dialogPresets).toLocaleString('en')} dialog presets, ` +
        `${workflowTemplates.length.toLocaleString('en')} workflow templates`,
      'info',
      'Export',
    )
  }

  // The file's contents checked, before the user is asked: { preferences, … } or { error }.
  async function readFile(file) {
    try {
      return readSettingsFile(JSON.parse(await file.text()))
    } catch {
      return { error: 'settings.transfer.notSettings' }
    }
  }

  // Applies what readFile returned: the preferences replace this browser's, the presets
  // and templates are merged (core/preferences.js).
  async function applyImport({ preferences, dialogPresets, workflowTemplates }, fileName) {
    for (const [key, value] of Object.entries(preferences)) localStorage.setItem(key, value)
    const presets = mergeDialogPresets((await opfs.readAppJson(PRESETS).catch(() => null)) ?? {}, dialogPresets)
    await opfs.writeAppJson(PRESETS, presets)
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(mergeTemplates(readJson(TEMPLATE_KEY, []), workflowTemplates)))
    log(
      `Settings imported from "${fileName}": ${Object.keys(preferences).length.toLocaleString('en')} preferences, ` +
        `${presetCount(dialogPresets).toLocaleString('en')} dialog presets, ` +
        `${workflowTemplates.length.toLocaleString('en')} workflow templates; reloading to apply them`,
      'info',
      'System',
    )
    await flushPersistence()
  }

  async function resetSettings() {
    for (const key of RESET_KEYS) localStorage.removeItem(key)
    log('All settings reset to their defaults; reloading to apply them', 'info', 'System')
    await flushPersistence()
  }

  return { exportSettings, readFile, applyImport, resetSettings }
}

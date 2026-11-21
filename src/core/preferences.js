// Every key WebSfM keeps in this browser's localStorage, by what Settings ▸ Storage ▸
// Reset all settings and Export settings do with it. preferences.test.js fails on a key
// the code uses that is not listed here, so a new preference is never left out.
//
//   portable  a preference: reset to its default, and carried by an export
//   machine   fits this computer only (memory, workers, GPU): reset, never exported
//   layout    how the window was left (sidebar width, console, open steps): reset only
//   state     what WebSfM remembers, not a setting (history, the last project, the
//             tabs, workflow templates): neither reset nor exported as a preference
//             (workflow templates travel in the export as their own part)
export const STORED_KEYS = {
  'theme': 'portable',
  'websfm.ui.motion': 'portable',
  'uiLanguage': 'portable',
  'glossaryTermsEnabled': 'portable',
  'advancedSettingsExpanded': 'portable',
  'websfm.ui.confirmRemoveMark': 'portable',
  'websfm.ui.keepAwake': 'portable',
  'websfm.ui.notifyWhenDone': 'portable',
  'websfm.ui.showBugButton': 'portable',
  'websfm.ui.openLastProject': 'portable',
  'browserWarningDismissed': 'portable',
  'mobileWarningAcknowledged': 'portable',
  'mapBasemap': 'portable',
  'mapSatelliteUrl': 'portable',
  'mapSatelliteAttribution': 'portable',
  'viewer3dBackground': 'portable',
  'gridZ': 'portable',
  'viewer3dNearClip': 'portable',
  'viewer3dPointBudget': 'portable',
  'viewer3dPointSize': 'portable',
  'viewer3dCameraScale': 'portable',
  'viewer3dTurntableSeconds': 'portable',
  'websfm.images.groupBy': 'portable',
  'whatsNewMode': 'portable',

  'websfm.dense.memBudgetGb': 'machine',
  'websfm.compute.useGpu': 'machine',
  'websfm.compute.workerCount': 'machine',
  // Debug ▸ Flags kept after reload: an experiment in this browser, so reset with the
  // settings and never carried to another computer.
  'websfm.flags.v1': 'machine',

  'sidebarWidth': 'layout',
  'consoleOpen': 'layout',
  'websfm.ui.openSteps': 'layout',

  'consoleHistory': 'state',
  'whatsNewSeen': 'state',
  'websfm.ui.lastProject': 'state',
  'websfm.ui.openingProject': 'state',
  'websfm.ui.tabs': 'state',
  'websfm-workflow-templates-v1': 'state',
}

const keysOf = (...kinds) => Object.keys(STORED_KEYS).filter((k) => kinds.includes(STORED_KEYS[k]))

/** The keys Reset all settings removes, so each setting falls back to its default. */
export const RESET_KEYS = keysOf('portable', 'machine', 'layout')
/** The keys an export carries. */
export const PORTABLE_KEYS = keysOf('portable')

// An export file: what it is, so an import can refuse anything else.
export const SETTINGS_FILE = { app: 'WebSfM', kind: 'settings', version: 1 }

/**
 * The export file's content. `stored` maps a key to its stored string (null when
 * unset); `dialogPresets` is dialog-presets.json ({ dialog: [{ name, settings }] }),
 * `workflowTemplates` the Workflow Builder's templates.
 */
export function settingsExport({ stored, dialogPresets = {}, workflowTemplates = [], appVersion = '' }) {
  const preferences = {}
  for (const key of PORTABLE_KEYS) if (typeof stored[key] === 'string') preferences[key] = stored[key]
  return { ...SETTINGS_FILE, exportedWith: appVersion, preferences, dialogPresets, workflowTemplates }
}

/**
 * An export file's content, checked: { preferences, dialogPresets, workflowTemplates },
 * or { error } with a message key when it is not a WebSfM settings file. Unknown and
 * non-portable keys are left out (a file never sets this computer's memory limit).
 */
export function readSettingsFile(data) {
  if (!data || typeof data !== 'object' || data.app !== SETTINGS_FILE.app || data.kind !== SETTINGS_FILE.kind)
    return { error: 'settings.transfer.notSettings' }
  if (!(data.version <= SETTINGS_FILE.version)) return { error: 'settings.transfer.newer' }
  const preferences = {}
  for (const [key, value] of Object.entries(data.preferences ?? {}))
    if (STORED_KEYS[key] === 'portable' && typeof value === 'string') preferences[key] = value
  const presets = data.dialogPresets
  const dialogPresets = presets && typeof presets === 'object' && !Array.isArray(presets) ? presets : {}
  const workflowTemplates = Array.isArray(data.workflowTemplates) ? data.workflowTemplates : []
  return { preferences, dialogPresets, workflowTemplates }
}

/**
 * Presets after an import (dialog-presets.json: { dialog: [{ name, settings }] }): per
 * dialog, the imported ones added and those of the same name replaced, the others kept,
 * sorted by name as the dialogs keep them.
 */
export function mergeDialogPresets(current, imported) {
  const out = { ...(current ?? {}) }
  for (const [dialog, list] of Object.entries(imported ?? {})) {
    if (!Array.isArray(list)) continue
    const byName = new Map((out[dialog] ?? []).map((p) => [p.name, p]))
    for (const p of list)
      if (p && typeof p.name === 'string' && p.settings && typeof p.settings === 'object') byName.set(p.name, p)
    out[dialog] = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  return out
}

/** Workflow templates after an import: those of the same name replaced, the rest added. */
export function mergeTemplates(current, imported) {
  const byName = new Map((current ?? []).map((t) => [t?.name, t]))
  for (const t of imported ?? []) if (t && typeof t.name === 'string') byName.set(t.name, t)
  return [...byName.values()]
}

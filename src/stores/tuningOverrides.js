// Overrides of internal tuning knobs ("flags"), set from the console (`set
// sfm.minPnpInlierRatio 0.5`, core/help/consoleSettings.js) or Debug ▸ Flags
// (FlagsModal.vue): one store for both. Never saved with the project: they are an
// experiment, not a setting. Session-only by default; with the dialog's "Keep after
// reload" they are kept in this browser's storage and checked against today's tuning.js
// when the app starts. The runs they reach merge them into their settings on the main
// thread (applyTuningOverrides), and log them, so a run made with one says so; the
// Project Summary, the Quality Report, the bug-report summary and the status bar show
// them too.

import { shallowRef, computed } from 'vue'
import {
  TUNING_GROUPS,
  mergeOverrides,
  setPath,
  getPath,
  describeOverrides,
  changedTuning,
  validateKeptOverrides,
} from '../core/help/consoleSettings.js'
import { editCommand } from '../core/help/consoleEdits.js'
import { useLog } from '../composables/useLog.js'
import { registerProjectStore } from './projectStores.js'

// This browser's copy, with "Keep after reload" on: { keep: true, overrides }.
const STORAGE_KEY = 'websfm.flags.v1'

const state = shallowRef({})
const keep = shallowRef(false)

/** The changed knobs, [{ key, group, value, def }] in tuning.js order (reactive). */
export const changedFlags = computed(() => changedTuning(state.value))
export const flagCount = computed(() => changedFlags.value.length)
/** "Keep after reload (this browser only)" (reactive). */
export const keepFlags = computed(() => keep.value)

export function tuningOverrides(group) {
  return state.value[group] ?? {}
}

function store() {
  try {
    if (keep.value) localStorage.setItem(STORAGE_KEY, JSON.stringify({ keep: true, overrides: state.value }))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage blocked or full: the flags stay for this session */
  }
}

/** Set (or, with `value` undefined, remove) one override. */
export function setTuningOverride(group, path, value) {
  const next = setPath(state.value[group], path, value)
  state.value = { ...state.value, [group]: next }
  store()
}

const valueText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

/**
 * A flag changed by hand in Debug ▸ Flags: set (or, with `value` undefined, reset) it and
 * confirm it on the Activity channel with the console command that does the same.
 */
export function editFlag(group, path, value) {
  const { log } = useLog()
  const key = [group, ...path].join('.')
  const def = getPath(TUNING_GROUPS[group].defaults, path)
  const old = getPath(state.value[group], path)
  setTuningOverride(group, path, value)
  const now = value === undefined ? def : value
  log(
    `Flag ${key}: ${JSON.stringify(old === undefined ? def : old)} → ${JSON.stringify(now)}` +
      (value === undefined ? ' (default)' : ` (default ${JSON.stringify(def)})`),
    'info',
    TUNING_GROUPS[group].logSource,
    { channel: 'activity', command: editCommand('set', [key, value === undefined ? 'default' : valueText(value)]) },
  )
}

/** Debug ▸ Flags ▸ Reset all: every flag back to its default, confirmed as `set default`. */
export function resetAllFlags() {
  const { log } = useLog()
  const keys = changedFlags.value.map((c) => c.key)
  if (!keys.length) return
  state.value = {}
  store()
  log(`Flags reset to their defaults: ${keys.join(', ')}`, 'info', 'System', {
    channel: 'activity',
    command: editCommand('set', ['default']),
  })
}

/** Turn "Keep after reload" on (the flags are stored in this browser now) or off. */
export function setKeepFlags(on) {
  keep.value = !!on
  store()
}

/**
 * A run's settings with the group's overrides on top. `log(message)` hears about them
 * when there are any, so the run log records what was changed.
 */
export function applyTuningOverrides(group, settings, log = null) {
  const o = state.value[group]
  if (!o || !Object.keys(o).length) return settings
  log?.(`Changed flags in effect (${group}): ${describeOverrides(o)}`)
  return mergeOverrides(settings, o)
}

/**
 * At start: the flags kept in this browser, each checked against today's tuning.js. A key
 * that is gone, or a value whose type changed, is dropped; the rest are in effect again.
 * What was dropped is logged when the first project opens (a line logged before that is
 * cleared with the console as the project's own log loads). `storage` is injectable for
 * the tests.
 */
export function restoreKeptFlags({ storage = globalThis.localStorage } = {}) {
  let saved = null
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
  } catch {
    saved = null
  }
  if (!saved?.keep) return
  keep.value = true
  const { byGroup, dropped } = validateKeptOverrides(saved.overrides)
  droppedAtStart = dropped
  state.value = byGroup
  if (dropped.length) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ keep: true, overrides: byGroup }))
    } catch {
      /* storage blocked: dropped again at the next start */
    }
  }
}

let droppedAtStart = []

/**
 * As a project opens, its log records the flags in effect (kept from an earlier session
 * or set in this one), and, once, the kept flags dropped at start. `log` is injectable
 * for the tests.
 */
export function logFlagsOnOpen(log = useLog().log) {
  for (const d of droppedAtStart) log(`Kept flag ${d.key} dropped: ${d.reason}`, 'warn', 'System')
  droppedAtStart = []
  const changed = changedFlags.value
  if (changed.length)
    log(
      `Changed flags in effect (Other ▸ Debug ▸ Flags${keep.value ? ', kept in this browser' : ''}): ` +
        changed.map((c) => `${c.key}=${JSON.stringify(c.value)}`).join(', '),
      'warn',
      'System',
    )
}

// Not project state (flags are never saved with a project): this only takes part in a
// project's opening, for the log lines above.
const ON_OPEN = { $id: 'flags', restore: async () => logFlagsOnOpen(), clear() {} }
registerProjectStore(() => ON_OPEN)

/** Tests only: back to no flags, not kept. */
export function _resetFlagsForTests() {
  state.value = {}
  keep.value = false
  droppedAtStart = []
}

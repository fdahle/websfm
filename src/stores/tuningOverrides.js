// Session-only overrides of internal tuning knobs, set from the console (`set
// sfm.minPnpInlierRatio 0.5`, core/help/consoleSettings.js). Not saved with the project
// and gone on reload: they are an experiment, not a setting. The runs they reach merge
// them into their settings on the main thread (applyTuningOverrides), and log them, so
// a run made with one says so.

import { mergeOverrides, setPath, describeOverrides } from '../core/help/consoleSettings.js'

let overrides = {}

export function tuningOverrides(group) {
  return overrides[group] ?? {}
}

/** Set (or, with `value` undefined, remove) one override. */
export function setTuningOverride(group, path, value) {
  const next = setPath(overrides[group], path, value)
  overrides = { ...overrides, [group]: next }
}

/**
 * A run's settings with the group's overrides on top. `log(message)` hears about them
 * when there are any, so the run log records what was changed.
 */
export function applyTuningOverrides(group, settings, log = null) {
  const o = overrides[group]
  if (!o || !Object.keys(o).length) return settings
  log?.(`Console overrides in effect (${group}): ${describeOverrides(o)}`)
  return mergeOverrides(settings, o)
}

// The console's `set`: session overrides of the internal tuning knobs (tuning.js),
// validated against their defaults. Pure: the overrides object is passed in and
// returned, never held here (stores/tuningOverrides.js keeps it for the session).
//
// Only knobs no dialog exposes are settable. A dialog setting typed here is refused
// with the dialog's name, because an override the dialog does not show would make the
// dialog lie about what runs. Each group lists where its overrides take effect: the
// settings of that run are merged with them on the main thread, before the worker.

import { SFM_TUNING, MATCH_TUNING } from '../tuning.js'
import { RECONSTRUCT_DEFAULTS, MATCH_DEFAULTS } from '../defaults.user.js'

export const TUNING_GROUPS = {
  sfm: {
    defaults: SFM_TUNING,
    dialog: RECONSTRUCT_DEFAULTS,
    dialogName: 'Sparse Model',
    appliesTo: 'the next Sparse Model run',
  },
  match: {
    defaults: MATCH_TUNING,
    dialog: MATCH_DEFAULTS,
    dialogName: 'Match Features',
    appliesTo: 'the next matching run',
  },
}

const isGroup = (v) => v != null && typeof v === 'object' && !Array.isArray(v)

export function getPath(obj, path) {
  let v = obj
  for (const k of path) {
    if (v == null || typeof v !== 'object') return undefined
    v = v[k]
  }
  return v
}

/** A copy of `obj` with `path` set to `value`, or removed when `value` is undefined. */
export function setPath(obj, path, value) {
  const [head, ...rest] = path
  const out = { ...(obj ?? {}) }
  if (rest.length) {
    const child = setPath(out[head], rest, value)
    if (Object.keys(child).length) out[head] = child
    else delete out[head]
  } else if (value === undefined) delete out[head]
  else out[head] = value
  return out
}

/** Every settable key of a group, dotted ('sfm.baSolver.pcgMaxIter'). */
export function tuningKeys(group) {
  const out = []
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (isGroup(v)) walk(v, `${prefix}.${k}`)
      else out.push(`${prefix}.${k}`)
    }
  }
  if (TUNING_GROUPS[group]) walk(TUNING_GROUPS[group].defaults, group)
  return out
}

/**
 * 'sfm.minPnpInlierRatio' → { group, path, def } — `def` the default (an object for
 * a nested group such as sfm.baSolver) — or { error }.
 */
export function parseTuningKey(key) {
  const parts = String(key ?? '')
    .split('.')
    .filter(Boolean)
  const group = TUNING_GROUPS[parts[0]]
  if (!group)
    return { error: `Unknown group "${parts[0] ?? ''}" — settable groups: ${Object.keys(TUNING_GROUPS).join(', ')}` }
  const path = parts.slice(1)
  if (!path.length) return { group: parts[0], path, def: group.defaults }
  if (path.length === 1 && path[0] in group.dialog && !(path[0] in group.defaults)) {
    return { error: `${parts[0]}.${path[0]} is a ${group.dialogName} dialog setting — set it there` }
  }
  const def = getPath(group.defaults, path)
  if (def === undefined) {
    const near = tuningKeys(parts[0]).filter((k) =>
      k.toLowerCase().includes(path[path.length - 1].toLowerCase().slice(0, 6)),
    )
    return {
      error: `Unknown key ${key}${near.length ? ` — did you mean ${near.slice(0, 3).join(', ')}?` : ` — "set ${parts[0]}" lists the keys`}`,
    }
  }
  return { group: parts[0], path, def }
}

/** A typed value for a knob whose default is `def`, or { error }. */
export function parseTuningValue(raw, def) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
  if (typeof def === 'number' || def === null) {
    if (def === null && /^(null|none|auto)$/i.test(text)) return { value: null }
    const n = Number(text)
    if (text === '' || !Number.isFinite(n))
      return { error: `expects a number${def === null ? ' or null' : ''}, got "${text}"` }
    return { value: n }
  }
  if (typeof def === 'boolean') {
    if (/^(true|on|yes|1)$/i.test(text)) return { value: true }
    if (/^(false|off|no|0)$/i.test(text)) return { value: false }
    return { error: `expects true or false, got "${text}"` }
  }
  if (typeof def === 'string') return text ? { value: text } : { error: 'expects a value' }
  return { error: 'is a group of settings — set one of its keys' }
}

/** Settings for a run with the group's overrides merged on top (nested groups merge key by key). */
export function mergeOverrides(settings, overrides) {
  const out = { ...(settings ?? {}) }
  for (const [k, v] of Object.entries(overrides ?? {})) {
    out[k] = isGroup(v) ? { ...(isGroup(out[k]) ? out[k] : {}), ...v } : v
  }
  return out
}

/** 'minPnpInlierRatio=0.5, baSolver.pcgMaxIter=400' — for the run log. */
export function describeOverrides(overrides, prefix = '') {
  const parts = []
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (isGroup(v)) parts.push(describeOverrides(v, `${prefix}${k}.`))
    else parts.push(`${prefix}${k}=${JSON.stringify(v)}`)
  }
  return parts.filter(Boolean).join(', ')
}

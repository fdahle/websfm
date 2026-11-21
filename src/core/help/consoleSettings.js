// The console's `set` and Debug ▸ Flags: session overrides of the internal tuning knobs
// (tuning.js), validated against their defaults. Pure: the overrides object is passed in
// and returned, never held here (stores/tuningOverrides.js keeps it for the session, and
// in this browser when the Flags dialog's "Keep after reload" is on).
//
// Only knobs no dialog exposes are settable. A dialog setting typed here is refused
// with the dialog's name, because an override the dialog does not show would make the
// dialog lie about what runs. Each group lists where its overrides take effect: the
// settings of that run are merged with them on the main thread, before the worker.

import { SFM_TUNING, MATCH_TUNING } from '../tuning.js'
import { RECONSTRUCT_DEFAULTS, MATCH_DEFAULTS } from '../defaults.user.js'

// `exportName`: the object's name in tuning.js, where core/tuningHelp.js finds each
// knob's comment; `logSource`: the area a flag edited by hand is logged under.
export const TUNING_GROUPS = {
  sfm: {
    defaults: SFM_TUNING,
    exportName: 'SFM_TUNING',
    dialog: RECONSTRUCT_DEFAULTS,
    dialogName: 'Sparse Model',
    appliesTo: 'the next Sparse Model run',
    logSource: 'Sparse',
  },
  match: {
    defaults: MATCH_TUNING,
    exportName: 'MATCH_TUNING',
    dialog: MATCH_DEFAULTS,
    dialogName: 'Match Features',
    appliesTo: 'the next matching run',
    logSource: 'Matching',
  },
}

// The values a knob takes where the code reads a fixed set: the Flags dialog offers them
// as a list, and `set` refuses anything else. A knob whose text is free (a comma list of
// calibration terms) is not here. Each list holds its default (consoleSettings.test.js).
export const TUNING_CHOICES = {
  'sfm.baPreFilterLoss': ['huber', 'cauchy', 'geman-mcclure'], // bundleSession.js
  'sfm.trackStore': ['typed', 'map'], // singleModel.js
  'sfm.baSolver.direct': [true, false, 'implicit'], // reconstruction.js solver options
  'match.bridgeVerifier': ['ransac', 'magsac'], // features/verify.js
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

/**
 * What kind of value a knob takes: 'choice' (TUNING_CHOICES), 'number' (a null default
 * takes a number or null: "automatic"), 'boolean', 'text', 'list' (an array, as JSON).
 */
export function tuningType(def, choices = null) {
  if (choices) return 'choice'
  if (typeof def === 'number' || def === null) return 'number'
  if (typeof def === 'boolean') return 'boolean'
  if (typeof def === 'string') return 'text'
  if (Array.isArray(def)) return 'list'
  return 'group'
}

const sameKind = (a, b) => (a === null ? typeof b === 'number' : typeof a === typeof b)

/** A typed value for a knob whose default is `def`, or { error }. */
export function parseTuningValue(raw, def, choices = null) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
  if (choices) {
    const hit = choices.find((c) => String(c).toLowerCase() === text.toLowerCase())
    if (hit !== undefined) return { value: hit }
    return { error: `expects one of ${choices.map(String).join(', ')}, got "${text}"` }
  }
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
  if (Array.isArray(def)) {
    let v
    try {
      v = JSON.parse(text)
    } catch {
      return { error: `expects a JSON list such as ${JSON.stringify(def)}, got "${text}"` }
    }
    return checkTuningValue(v, def)
  }
  return { error: 'is a group of settings — set one of its keys' }
}

/**
 * A value that is already typed (the dialog's fields, a value kept in this browser),
 * checked as `set` checks typed text: { value } or { error }.
 */
export function checkTuningValue(value, def, choices = null) {
  if (choices) {
    return choices.includes(value)
      ? { value }
      : { error: `expects one of ${choices.map(String).join(', ')}, got ${JSON.stringify(value)}` }
  }
  if (typeof def === 'number' || def === null) {
    if (value === null && def === null) return { value }
    return typeof value === 'number' && Number.isFinite(value)
      ? { value }
      : { error: `expects a number${def === null ? ' or null' : ''}, got ${JSON.stringify(value)}` }
  }
  if (typeof def === 'boolean')
    return typeof value === 'boolean' ? { value } : { error: `expects true or false, got ${JSON.stringify(value)}` }
  if (typeof def === 'string')
    return typeof value === 'string' && value.trim()
      ? { value: value.trim() }
      : { error: `expects a value, got ${JSON.stringify(value)}` }
  if (Array.isArray(def)) {
    if (!Array.isArray(value)) return { error: `expects a list such as ${JSON.stringify(def)}` }
    const bad = def.length
      ? value.find((x) => !sameKind(def[0], x) || (typeof x === 'number' && !Number.isFinite(x)))
      : undefined
    if (bad !== undefined) return { error: `expects a list of ${typeof def[0]}s, got ${JSON.stringify(bad)}` }
    return { value }
  }
  return { error: 'is a group of settings — set one of its keys' }
}

/**
 * Every knob of the console's groups: { key, group, path, def, choices, type }, in
 * tuning.js order — the rows of the Flags dialog.
 */
export function tuningEntries() {
  return Object.keys(TUNING_GROUPS).flatMap((group) =>
    tuningKeys(group).map((key) => {
      const path = key.split('.').slice(1)
      const def = getPath(TUNING_GROUPS[group].defaults, path)
      const choices = TUNING_CHOICES[key] ?? null
      return { key, group, path, def, choices, type: tuningType(def, choices) }
    }),
  )
}

/** The knobs changed in `byGroup` ({ sfm: overrides, match: … }): [{ key, value, def }]. */
export function changedTuning(byGroup) {
  const out = []
  for (const e of tuningEntries()) {
    const value = getPath(byGroup?.[e.group], e.path)
    if (value !== undefined) out.push({ key: e.key, group: e.group, value, def: e.def })
  }
  return out
}

/** 'sfm.minPnpInlierRatio=0.5 (default 0.3), …' — for a bug report and the summaries. */
export function describeChanged(changed) {
  return changed.map((c) => `${c.key}=${JSON.stringify(c.value)} (default ${JSON.stringify(c.def)})`).join(', ')
}

/**
 * Overrides kept in this browser, checked against today's tuning.js: a key that is gone
 * or now a dialog setting, or a value whose type no longer fits, is dropped with the
 * reason. → { byGroup, dropped: [{ key, reason }] }.
 */
export function validateKeptOverrides(stored) {
  const byGroup = {}
  const dropped = []
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const key = `${prefix}.${k}`
      if (isGroup(v)) {
        walk(v, key)
        continue
      }
      const parsed = parseTuningKey(key)
      if (parsed.error || !parsed.path.length) {
        dropped.push({ key, reason: 'no longer an internal tuning value' })
        continue
      }
      const checked = checkTuningValue(v, parsed.def, TUNING_CHOICES[key] ?? null)
      if (checked.error) {
        dropped.push({ key, reason: `the value no longer fits: ${key} ${checked.error}` })
        continue
      }
      byGroup[parsed.group] = setPath(byGroup[parsed.group], parsed.path, checked.value)
    }
  }
  for (const [group, o] of Object.entries(isGroup(stored) ? stored : {})) {
    if (!TUNING_GROUPS[group] || !isGroup(o)) {
      dropped.push({ key: group, reason: 'no longer a group of internal tuning values' })
      continue
    }
    walk(o, group)
  }
  return { byGroup, dropped }
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

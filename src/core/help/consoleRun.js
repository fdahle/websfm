// The console's `run`: every processing step a workflow can run unattended is a stage
// it takes, with that step's settings as key=value (docs/conventions.md ▸ The console ▸
// Everything can be typed). Derived from the workflow blocks (core/workflow.js), so a
// new automated block is a `run` stage the moment it exists, with the same settings the
// Workflow Builder shows. Pure.
//
//   run dense minViews=3 removeIsolated=false mesh preset=high

import { WORKFLOW_BLOCKS } from '../workflow.js'

// The word typed for a block, beyond its id: the short names people use.
const STAGE_WORDS = {
  'detect-features': ['detect'],
  'match-features': ['match'],
  'reconstruct': ['sparse', 'reconstruct'],
  'compute-depth': ['depth', 'depthmaps'],
  'dense': ['dense'],
  'gen-dem': ['dem'],
  'gen-ortho': ['ortho'],
  'gen-mesh': ['mesh'],
  'texture-mesh': ['texture'],
  'filter-cloud': ['filter'],
  'estimate-normals': ['normals'],
  'align-icp': ['icp'],
  'clean-mesh': ['clean'],
  'smooth-mesh': ['smooth'],
  'decimate-mesh': ['decimate'],
}

/** The blocks `run` takes: automated, not a control block (Quality Gate, Go to). */
export const RUN_BLOCKS = WORKFLOW_BLOCKS.filter((b) => b.automated && !b.control)

/** Word typed → block id: each block's short names, then its id. */
export const RUN_STAGES = Object.fromEntries(
  RUN_BLOCKS.flatMap((b) => [...(STAGE_WORDS[b.id] ?? []), b.id].map((w) => [w, b.id])),
)

/** One word per stage, for help and Tab: the first short name, else the id. */
export const RUN_STAGE_NAMES = RUN_BLOCKS.map((b) => STAGE_WORDS[b.id]?.[0] ?? b.id)

const BY_ID = new Map(RUN_BLOCKS.map((b) => [b.id, b]))

const BOOLEAN = { true: true, on: true, yes: true, false: false, off: false, no: false }

// A typed value for one of a block's fields → { value } | { error }.
function fieldValue(field, raw) {
  const r = String(raw).trim()
  if (field.type === 'boolean') {
    const v = BOOLEAN[r.toLowerCase()]
    return v === undefined ? { error: `${field.key} is true or false` } : { value: v }
  }
  if (field.type === 'number') {
    const v = Number(r)
    if (r === '' || !Number.isFinite(v)) return { error: `${field.key} is a number` }
    if (field.min != null && v < field.min) return { error: `${field.key} is at least ${field.min}` }
    if (field.max != null && v > field.max) return { error: `${field.key} is at most ${field.max}` }
    return { value: v }
  }
  if (field.type === 'select') {
    const hit = (field.options ?? []).find((o) => String(o).toLowerCase() === r.toLowerCase())
    return hit === undefined ? { error: `${field.key} is one of ${field.options.join(', ')}` } : { value: hit }
  }
  if (field.type === 'multi') {
    const parts = r
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const bad = parts.filter((p) => !field.options.some((o) => String(o).toLowerCase() === p.toLowerCase()))
    if (bad.length) return { error: `${field.key} takes ${field.options.join(',')} (a comma list)` }
    return { value: parts.map((p) => field.options.find((o) => String(o).toLowerCase() === p.toLowerCase())) }
  }
  return { value: r }
}

/**
 * Read `run`'s arguments: stages, each followed by its key=value settings.
 * → { stages: [{ id, settings }] } | { error }.
 */
export function parseRunArgs(tokens) {
  const stages = []
  for (const tok of tokens) {
    const kv = tok.match(/^([A-Za-z]\w*)=(.*)$/)
    if (!kv) {
      const id = RUN_STAGES[tok.toLowerCase()]
      if (!id) return { error: `Unknown stage: ${tok}. Stages: ${RUN_STAGE_NAMES.join(' ')}` }
      stages.push({ id, settings: {} })
      continue
    }
    const stage = stages[stages.length - 1]
    if (!stage) return { error: `${tok}: a setting follows the stage it is for ("run dense minViews=3")` }
    const fields = BY_ID.get(stage.id).fields ?? []
    const field = fields.find((f) => f.key.toLowerCase() === kv[1].toLowerCase())
    if (!field) {
      return {
        error: `${stageName(stage.id)} has no setting "${kv[1]}". Its settings: ${fields.map((f) => f.key).join(', ') || 'none'}`,
      }
    }
    const v = fieldValue(field, kv[2])
    if (v.error) return { error: `${stageName(stage.id)}: ${v.error}` }
    stage.settings[field.key] = v.value
  }
  return { stages }
}

function stageName(id) {
  return STAGE_WORDS[id]?.[0] ?? id
}

/** `help run <stage>`: the stage's settings with their defaults and values. → lines | null. */
export function runStageHelp(word) {
  const block = BY_ID.get(RUN_STAGES[String(word ?? '').toLowerCase()])
  if (!block) return null
  const lines = [`run ${stageName(block.id)} — ${block.label}; settings (key=value):`]
  for (const f of block.fields ?? []) {
    const values =
      f.type === 'boolean'
        ? 'true|false'
        : f.type === 'select'
          ? f.options.join('|')
          : f.type === 'multi'
            ? `${f.options.join(',')} (a comma list)`
            : f.type === 'number'
              ? `number${f.min != null ? ` ≥ ${f.min}` : ''}${f.max != null ? ` ≤ ${f.max}` : ''}`
              : 'text'
    const def = block.settings[f.key]
    lines.push(`  ${f.key} = ${values}   (${f.label}; default ${JSON.stringify(def)})`)
  }
  if (!block.fields?.length) lines.push('  (none)')
  return lines
}

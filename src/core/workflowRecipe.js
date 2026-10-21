// The Workflow Builder's recipe text: the block graph as editable lines, and back.
// Pure (no Vue). The two directions are exact inverses over normalised workflows —
// recipeText → parseRecipe gives back the same name, defaults, blocks, names,
// settings, policies and jumps (only ids and timestamps are not in the text) — and
// the parser refuses anything it would otherwise have to drop or guess, with the
// line number.
//
//   workflow "Survey with checks"
//   defaults warning=pause reuse=valid display=standard
//   detect-features detector="sift" preset="medium" maxDim=3200 …   # Detect Features
//   reconstruct preset="medium" …                                    # Sparse Model
//   gate metric="reprojMedianPx" op="<" threshold=1 onFail="branch" failTarget="hq"
//   goto target="dense"
//   hq: reconstruct @reuse=rerun preset="high" …
//   dense: compute-depth quality="medium" …
//   filter-cloud @off preset="light"
//
// One block per line: an optional `name:` (what jumps refer to), the block type,
// `@off` / `@reuse=…` / `@warning=…` modifiers, then key=value settings. A value is
// JSON (strings quoted, arrays in brackets); a bare word that is not JSON reads as a
// string. `#` starts a comment outside quotes.
import {
  BLOCK_NAME_RE,
  DISPLAY_LEVELS,
  REUSE_POLICIES,
  WARNING_POLICIES,
  WORKFLOW_BLOCK_BY_ID,
  blockTargets,
  createWorkflowBlock,
  normalizeWorkflow,
  workflowSettingKeys,
} from './workflow.js'
import { END_TARGET, GATE_METRIC_BY_ID, formatGateNumber } from './workflowGate.js'

const WORKFLOW_WARNING = ['pause', 'continue', 'stop']
const WORKFLOW_REUSE = ['valid', 'ask', 'rerun']

export function workflowRecipeText(workflow) {
  const lines = [
    `workflow ${JSON.stringify(workflow.name)}`,
    `defaults warning=${workflow.defaults.warningPolicy} reuse=${workflow.defaults.reusePolicy} display=${workflow.displayLevel ?? 'standard'}`,
  ]
  for (const block of workflow.blocks) {
    const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
    const parts = []
    if (block.name) parts.push(`${block.name}:`)
    parts.push(block.type)
    if (!block.enabled) parts.push('@off')
    if (block.reusePolicy && block.reusePolicy !== 'inherit') parts.push(`@reuse=${block.reusePolicy}`)
    if (block.warningPolicy && block.warningPolicy !== 'inherit') parts.push(`@warning=${block.warningPolicy}`)
    for (const [key, value] of Object.entries(block.settings || {})) {
      if (value === undefined) continue
      // An unset value (null, or an empty jump target) equal to the default is
      // implied; any other value is written out, so a later change of a default
      // cannot change what a saved recipe means.
      if ((value === null || value === '') && (spec?.settings?.[key] ?? null) === value) continue
      parts.push(`${key}=${JSON.stringify(value)}`)
    }
    lines.push(`${parts.join(' ')}  # ${describeBlock(block)}`)
  }
  return lines.join('\n')
}

// The trailing comment: the block's label, and for control blocks what they do.
function describeBlock(block) {
  const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
  const label = spec?.label ?? block.type
  if (block.type === 'gate') {
    const s = block.settings
    const m = GATE_METRIC_BY_ID.get(s.metric)
    const unit = m?.unit ? ` ${m.unit}` : ''
    const fail = s.onFail === 'branch' ? `go to ${s.failTarget || '?'}` : s.onFail
    return `${label}: ${m?.label ?? s.metric} ${s.op} ${formatGateNumber(s.threshold)}${unit}, else ${fail}`
  }
  if (block.type === 'goto') return `${label} ${block.settings.target || '?'}`
  return label
}

// Parse recipe text. `base` (the workflow being edited) keeps its id and timestamps,
// and lends its block ids to the parsed blocks of the same type and name, in order,
// so run statuses and the selection survive an edit.
// → { workflow, errors: [] } on success; { workflow: null, errors: [{ line, message }] }.
export function parseWorkflowRecipe(text, base = null) {
  const errors = []
  const fail = (line, message) => errors.push({ line, message })
  let name = null
  let defaults = null
  let displayLevel = null
  const blocks = []

  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = i + 1
      let tokens
      try {
        tokens = tokenize(raw)
      } catch (err) {
        fail(line, err.message)
        return
      }
      if (!tokens.length) return
      const head = tokens[0]

      if (head.text === 'workflow' && !head.value) {
        if (name != null) return fail(line, 'the workflow name is given twice')
        if (blocks.length) return fail(line, '“workflow” must come before the first block')
        if (tokens.length !== 2 || tokens[1].key != null || typeof tokens[1].value !== 'string') {
          return fail(line, 'expected workflow "Name"')
        }
        name = tokens[1].value
        return
      }
      if (head.text === 'defaults' && !head.value) {
        if (defaults) return fail(line, 'defaults are given twice')
        if (blocks.length) return fail(line, '“defaults” must come before the first block')
        defaults = { warningPolicy: 'pause', reusePolicy: 'valid' }
        for (const t of tokens.slice(1)) {
          if (t.key === 'warning' && WORKFLOW_WARNING.includes(t.value)) defaults.warningPolicy = t.value
          else if (t.key === 'reuse' && WORKFLOW_REUSE.includes(t.value)) defaults.reusePolicy = t.value
          else if (t.key === 'display' && DISPLAY_LEVELS.includes(t.value)) displayLevel = t.value
          else
            return fail(
              line,
              `defaults: “${t.text}” is not one of warning=${WORKFLOW_WARNING.join('|')}, reuse=${WORKFLOW_REUSE.join('|')}, display=${DISPLAY_LEVELS.join('|')}`,
            )
        }
        return
      }

      // A block line.
      let rest = tokens
      let blockName = ''
      if (rest[0].key == null && rest[0].text.endsWith(':')) {
        blockName = rest[0].text.slice(0, -1)
        if (!BLOCK_NAME_RE.test(blockName) || blockName === END_TARGET) {
          return fail(line, `“${blockName}” is not a usable block name (letters, digits, - and _; not “end”)`)
        }
        rest = rest.slice(1)
      }
      if (!rest.length) return fail(line, `“${blockName}:” names no block`)
      const type = rest[0].text
      const spec = rest[0].key == null ? WORKFLOW_BLOCK_BY_ID.get(type) : null
      if (!spec) return fail(line, `unknown block “${type}”`)
      const block = createWorkflowBlock(type, blockName)
      const keys = workflowSettingKeys(type)
      const seen = new Set()
      for (const t of rest.slice(1)) {
        if (t.text === '@off' && t.key == null) {
          if (!block.enabled) return fail(line, '@off is given twice')
          block.enabled = false
          continue
        }
        if (t.key === '@reuse' || t.key === '@warning') {
          const allowed = t.key === '@reuse' ? REUSE_POLICIES : WARNING_POLICIES
          if (!allowed.includes(t.value)) return fail(line, `${t.key} must be one of ${allowed.join(', ')}`)
          if (seen.has(t.key)) return fail(line, `${t.key} is given twice`)
          seen.add(t.key)
          block[t.key === '@reuse' ? 'reusePolicy' : 'warningPolicy'] = t.value
          continue
        }
        if (t.key == null) return fail(line, `“${t.text}” is not a setting (expected key=value)`)
        if (!keys.has(t.key)) {
          return fail(line, `${type} has no setting “${t.key}” (settings: ${[...keys].join(', ')})`)
        }
        if (seen.has(t.key)) return fail(line, `setting “${t.key}” is given twice`)
        seen.add(t.key)
        const problem = settingProblem(spec, t.key, t.value)
        if (problem) return fail(line, `${type} ${t.key}: ${problem}`)
        block.settings[t.key] = t.value
      }
      block.line = line
      blocks.push(block)
    })

  // Jumps must name a block of this recipe (or `end`).
  const names = new Map()
  for (const b of blocks) {
    if (!b.name) continue
    if (names.has(b.name)) fail(b.line, `another block (line ${names.get(b.name)}) is already named “${b.name}”`)
    else names.set(b.name, b.line)
  }
  for (const b of blocks) {
    for (const { key, target } of blockTargets(b)) {
      if (target && target !== END_TARGET && !names.has(target)) fail(b.line, `${key}: no block is named “${target}”`)
    }
  }
  if (errors.length) return { workflow: null, errors: errors.sort((a, b) => a.line - b.line) }

  const unused = [...(base?.blocks ?? [])]
  const workflow = normalizeWorkflow({
    ...(base ? { id: base.id, createdAt: base.createdAt } : {}),
    name: name ?? base?.name ?? 'Untitled workflow',
    displayLevel: displayLevel ?? base?.displayLevel ?? 'standard',
    defaults: defaults ?? base?.defaults,
    blocks: blocks.map(({ line, ...b }) => {
      const k = unused.findIndex((u) => u.type === b.type && (u.name || '') === b.name)
      return k < 0 ? b : { ...b, id: unused.splice(k, 1)[0].id }
    }),
  })
  return { workflow, errors: [] }
}

// Type-check a value against the field (or the default's type when the setting has
// no field). null always means "not set". → message | null.
function settingProblem(spec, key, value) {
  if (value === null) return null
  const field = spec.fields.find((f) => f.key === key)
  const fallback = spec.settings[key]
  const type = field?.type ?? (Array.isArray(fallback) ? 'array' : fallback == null ? null : typeof fallback)
  const optionValues = (field?.options ?? []).map((o) => (o && typeof o === 'object' ? o.value : o))
  if (type === 'select') {
    return optionValues.map(String).includes(String(value)) ? null : `expected one of ${optionValues.join(', ')}`
  }
  if (type === 'multi') {
    if (!Array.isArray(value)) return 'expected a list, e.g. ["a", "b"]'
    const bad = value.find((v) => !optionValues.includes(v))
    if (bad !== undefined) return `“${bad}” is not one of ${optionValues.join(', ')}`
    return new Set(value).size === value.length ? null : 'a step is listed twice'
  }
  if (type === 'number') return typeof value === 'number' ? null : 'expected a number'
  if (type === 'boolean') return typeof value === 'boolean' ? null : 'expected true or false'
  if (type === 'text' || type === 'target' || type === 'string')
    return typeof value === 'string' ? null : 'expected a quoted string'
  if (type === 'array') return Array.isArray(value) ? null : 'expected a list'
  return null
}

// Split a line into tokens: { text, key, value }. `key=value` tokens carry the parsed
// value; a bare token has key null and its text. Throws with a column on a broken
// quote or bracket.
export function tokenize(line) {
  const tokens = []
  let i = 0
  const n = line.length
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++
    if (i >= n || line[i] === '#') break
    const start = i
    // A bare quoted token (the workflow name).
    if (line[i] === '"') {
      const end = scanString(line, i)
      tokens.push({ text: line.slice(start, end), key: null, value: JSON.parse(line.slice(start, end)) })
      i = end
      continue
    }
    while (i < n && !/\s/.test(line[i]) && line[i] !== '=') i++
    if (line[i] !== '=') {
      tokens.push({ text: line.slice(start, i), key: null, value: undefined })
      continue
    }
    const key = line.slice(start, i)
    if (!key) throw new Error(`column ${start + 1}: “=” without a setting name`)
    i++
    const vStart = i
    let end
    if (line[i] === '"') end = scanString(line, i)
    else if (line[i] === '[' || line[i] === '{') end = scanBracket(line, i)
    else {
      end = i
      while (end < n && !/\s/.test(line[end])) end++
    }
    const rawValue = line.slice(vStart, end)
    if (!rawValue) throw new Error(`column ${vStart + 1}: “${key}=” has no value`)
    let value
    try {
      value = JSON.parse(rawValue)
    } catch {
      if (/^["[{]/.test(rawValue)) throw new Error(`column ${vStart + 1}: “${rawValue}” is not valid JSON`)
      value = rawValue
    }
    tokens.push({ text: line.slice(start, end), key, value })
    i = end
  }
  return tokens
}

function scanString(line, i) {
  let j = i + 1
  while (j < line.length) {
    if (line[j] === '\\') j += 2
    else if (line[j] === '"') return j + 1
    else j++
  }
  throw new Error(`column ${i + 1}: unterminated string`)
}

function scanBracket(line, i) {
  let depth = 0
  let j = i
  while (j < line.length) {
    const c = line[j]
    if (c === '"') {
      j = scanString(line, j)
      continue
    }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  throw new Error(`column ${i + 1}: unclosed “${line[i]}”`)
}

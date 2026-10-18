import { describe, expect, it } from 'vitest'
import {
  DISPLAY_LEVELS, REUSE_POLICIES, WARNING_POLICIES, WORKFLOW_BLOCKS,
  createWorkflow, createWorkflowBlock, normalizeWorkflow,
} from './workflow.js'
import { parseWorkflowRecipe, tokenize, workflowRecipeText } from './workflowRecipe.js'
import { getGuideDoc, getParam } from './help/guide.js'

// Seeded so a failure reproduces: mulberry32.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, list) => list[Math.floor(r() * list.length)]
const STRINGS = ['scan', 'Reference scan 2024', 'quote " inside', 'hash # inside', 'back\\slash', 'ünïcode — ✓', '']

function randomNumber(r) {
  return pick(r, [null, 0, 1, -3, 12, 0.5, 1e-7, 123456789, -0.25, Math.round(r() * 1e6) / 1e3, r() * 1000 - 500])
}

function randomValue(r, field, fallback) {
  const type = field?.type ?? (Array.isArray(fallback) ? 'array' : typeof fallback)
  const options = (field?.options ?? []).map((o) => (o && typeof o === 'object' ? o.value : o))
  if (type === 'select') {
    const o = pick(r, options)
    // The inspector's <select> stores numeric options as strings.
    return typeof o === 'number' && r() < 0.5 ? String(o) : o
  }
  if (type === 'multi') return options.filter(() => r() < 0.5)
  if (type === 'number') return randomNumber(r)
  if (type === 'boolean') return r() < 0.5
  if (type === 'text' || type === 'string') return pick(r, STRINGS)
  return fallback
}

// A random workflow over the whole catalogue: every block type, names, disabled
// blocks, policy overrides, random settings and gates/Go to jumps to later blocks.
function randomWorkflow(seed) {
  const r = rng(seed)
  const w = createWorkflow(pick(r, ['Survey', 'Survey "B" #2', 'tab\there', 'line\nbreak', 'ünïcode — ✓']))
  w.displayLevel = pick(r, DISPLAY_LEVELS)
  w.defaults = { warningPolicy: pick(r, ['pause', 'continue', 'stop']), reusePolicy: pick(r, ['valid', 'ask', 'rerun']) }
  const count = Math.floor(r() * 14)
  w.blocks = Array.from({ length: count }, (_, i) => {
    const spec = r() < 0.25 ? pick(r, WORKFLOW_BLOCKS.filter((b) => b.control)) : pick(r, WORKFLOW_BLOCKS)
    const block = createWorkflowBlock(spec.id, r() < 0.4 ? pick(r, [`b${i}`, `step_${i}`, `X-${i}`]) : '')
    block.enabled = r() < 0.8
    block.reusePolicy = pick(r, REUSE_POLICIES)
    block.warningPolicy = pick(r, WARNING_POLICIES)
    for (const key of Object.keys(block.settings)) {
      if (r() < 0.5) block.settings[key] = randomValue(r, spec.fields.find((f) => f.key === key), block.settings[key])
    }
    return block
  })
  // Jumps name a later block (or end); the recipe carries them whether or not
  // preflight would accept the result.
  w.blocks.forEach((block, i) => {
    const later = w.blocks.slice(i + 1).filter((b) => b.name).map((b) => b.name)
    const target = () => pick(r, ['', 'end', ...later])
    if (block.type === 'gate') {
      block.settings.onFail = pick(r, ['pause', 'stop', 'continue', 'branch'])
      block.settings.failTarget = target()
      block.settings.passTarget = target()
      block.settings.op = pick(r, ['>=', '>', '<=', '<'])
    }
    if (block.type === 'goto') block.settings.target = target()
  })
  return normalizeWorkflow(w)
}

const comparable = (w) => ({
  name: w.name, displayLevel: w.displayLevel, defaults: w.defaults,
  blocks: w.blocks.map(({ id, ...b }) => b),
})

describe('recipe text round trip', () => {
  it('graph → text → graph is the identity over the block catalogue (500 random workflows)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const w = randomWorkflow(seed)
      const text = workflowRecipeText(w)
      const { workflow, errors } = parseWorkflowRecipe(text)
      expect(errors, `seed ${seed}\n${text}`).toEqual([])
      expect(comparable(workflow), `seed ${seed}\n${text}`).toEqual(comparable(w))
      // …and text → graph → text is a fixpoint.
      expect(workflowRecipeText(workflow)).toBe(text)
    }
  })

  it('covers every block type with its default settings', () => {
    const w = createWorkflow('All', WORKFLOW_BLOCKS.map((b) => b.id))
    const { workflow } = parseWorkflowRecipe(workflowRecipeText(w))
    expect(comparable(workflow)).toEqual(comparable(normalizeWorkflow(w)))
  })

  it('keeps the edited workflow’s ids for unchanged blocks', () => {
    const w = randomWorkflow(7)
    const { workflow } = parseWorkflowRecipe(workflowRecipeText(w), w)
    expect(workflow.id).toBe(w.id)
    expect(workflow.blocks.map((b) => b.id)).toEqual(w.blocks.map((b) => b.id))
  })

  it('writes gates, names, jumps and modifiers readably', () => {
    const w = createWorkflow('G', ['reconstruct', 'gate', 'goto', 'reconstruct'])
    w.blocks[3].name = 'hq'
    w.blocks[3].reusePolicy = 'rerun'
    w.blocks[3].enabled = false
    Object.assign(w.blocks[1].settings, { metric: 'reprojMedianPx', op: '<', threshold: 1, onFail: 'branch', failTarget: 'hq' })
    w.blocks[2].settings.target = 'end'
    const lines = workflowRecipeText(w).split('\n')
    expect(lines[3]).toMatch(/^gate metric="reprojMedianPx" op="<" threshold=1 onFail="branch" failTarget="hq" {2}# Quality Gate: Reprojection median < 1 px, else go to hq$/)
    expect(lines[4]).toMatch(/^goto target="end" {2}# Go to end$/)
    expect(lines[5]).toMatch(/^hq: reconstruct @off @reuse=rerun preset="medium"/)
  })
})

describe('recipe text parsing', () => {
  const parse = (text) => parseWorkflowRecipe(text)

  it('reads hand-written lines: bare words, defaults, comments', () => {
    const { workflow, errors } = parse([
      '# my survey',
      'workflow "Hand"',
      'defaults warning=continue reuse=rerun',
      '',
      'reconstruct preset=high   # trailing comment',
      'sp: compute-depth quality=low geomConsistency=false',
      'gate metric=depthCoveragePct op=">=" threshold=40 onFail=branch failTarget=end',
      'filter-cloud methods=["voxel", "sor"] voxelCell=0.05',
    ].join('\n'))
    expect(errors).toEqual([])
    expect(workflow.name).toBe('Hand')
    expect(workflow.defaults).toEqual({ warningPolicy: 'continue', reusePolicy: 'rerun' })
    expect(workflow.blocks.map((b) => b.type)).toEqual(['reconstruct', 'compute-depth', 'gate', 'filter-cloud'])
    expect(workflow.blocks[0].settings.preset).toBe('high')
    expect(workflow.blocks[1]).toMatchObject({ name: 'sp', settings: { quality: 'low', geomConsistency: false } })
    expect(workflow.blocks[2].settings).toMatchObject({ metric: 'depthCoveragePct', threshold: 40, failTarget: 'end' })
    expect(workflow.blocks[3].settings).toMatchObject({ methods: ['voxel', 'sor'], voxelCell: 0.05 })
  })

  it('reports every problem with its line number and drops nothing silently', () => {
    const { workflow, errors } = parse([
      'workflow "Bad"',          // 1
      'reconstrct preset=high',  // 2 unknown block
      'reconstruct presett=high', // 3 unknown setting
      'reconstruct baIterations="ten"', // 4 wrong type
      'compute-depth quality=extreme', // 5 not an option
      'gate failTarget="nowhere" onFail=branch', // 6 dangling target
      'dense minViews=2 minViews=3', // 7 duplicate setting
      'dense stray',             // 8 bare word
      'filter-cloud methods=["sor", "magic"]', // 9 bad list item
      'detect-features maxDim="unterminated', // 10 broken quote
      'a: dense',                // 11
      'a: dense',                // 12 duplicate name
      'end: dense',              // 13 reserved name
      'dense @reuse=sometimes',  // 14 bad policy
      'workflow "Again"',        // 15 header twice
    ].join('\n'))
    expect(workflow).toBeNull()
    const byLine = Object.fromEntries(errors.map((e) => [e.line, e.message]))
    expect(byLine[2]).toMatch(/unknown block “reconstrct”/)
    expect(byLine[3]).toMatch(/has no setting “presett”/)
    expect(byLine[4]).toMatch(/expected a number/)
    expect(byLine[5]).toMatch(/expected one of low, medium, high, ultra/)
    expect(byLine[6]).toMatch(/no block is named “nowhere”/)
    expect(byLine[7]).toMatch(/given twice/)
    expect(byLine[8]).toMatch(/not a setting/)
    expect(byLine[9]).toMatch(/“magic” is not one of/)
    expect(byLine[10]).toMatch(/unterminated string/)
    expect(byLine[12]).toMatch(/already named “a”/)
    expect(byLine[13]).toMatch(/not a usable block name/)
    expect(byLine[14]).toMatch(/@reuse must be one of/)
    expect(byLine[15]).toMatch(/given twice/)
    expect(errors.map((e) => e.line)).toEqual([...errors.map((e) => e.line)].sort((a, b) => a - b))
  })

  it('an empty recipe is an empty workflow; base keeps its name', () => {
    const base = createWorkflow('Kept')
    const { workflow } = parseWorkflowRecipe('', base)
    expect(workflow).toMatchObject({ id: base.id, name: 'Kept', blocks: [] })
  })

  it('reads the Guide’s example recipe, and every help label has its Guide section', () => {
    const doc = getGuideDoc('workflow-builder')
    const example = /```\n([\s\S]*?)```/.exec(doc.params.get('recipe-text').body)[1]
    const { workflow, errors } = parse(example)
    expect(errors).toEqual([])
    expect(workflow.blocks.map((b) => b.type)).toEqual(['reconstruct', 'gate', 'reconstruct', 'compute-depth', 'filter-cloud'])
    for (const spec of WORKFLOW_BLOCKS) {
      for (const field of spec.fields.filter((f) => f.help)) {
        expect(getParam('workflow-builder', field.key), `${spec.id}.${field.key}`).not.toBeNull()
      }
    }
    expect(getParam('workflow-builder', 'name')).not.toBeNull()
  })

  it('tokenizes quoted values, brackets and comments', () => {
    expect(tokenize('a: gate x="p # q" y=[1, "]"]  # c').map((t) => [t.key, t.value ?? t.text]))
      .toEqual([[null, 'a:'], [null, 'gate'], ['x', 'p # q'], ['y', [1, ']']]])
    expect(() => tokenize('dense y=[1, 2')).toThrow(/column 9: unclosed/)
  })
})

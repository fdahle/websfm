import { describe, expect, it } from 'vitest'
import {
  blockOutputValid, createWorkflow, createWorkflowBlock,
  normalizeWorkflow, renameWorkflowBlock, resolveWorkflowSettings, updateWorkflowSetting, workflowPreflight,
} from './workflow.js'
import { workflowRecipeText } from './workflowRecipe.js'

// A workflow from [type, name?, settings?] rows.
function graph(rows, initialName = 'g') {
  const w = createWorkflow(initialName)
  w.blocks = rows.map(([type, name = '', settings = {}]) => {
    const b = createWorkflowBlock(type, name)
    b.settings = { ...b.settings, ...settings }
    return b
  })
  return w
}
const errorsOf = (items) => items.filter((x) => x.level === 'error').map((x) => x.message)

describe('workflow schema', () => {
  it('creates independent settings for each block', () => {
    const a = createWorkflowBlock('detect-features')
    const b = createWorkflowBlock('detect-features')
    a.settings.maxDim = 99
    expect(b.settings.maxDim).not.toBe(99)
  })

  it('drops unknown blocks and backfills defaults', () => {
    const w = normalizeWorkflow({ name: 'Old', blocks: [
      { id: 'a', type: 'detect-features', settings: { maxDim: 1234 } },
      { id: 'b', type: 'removed-command' },
    ] })
    expect(w.blocks).toHaveLength(1)
    expect(w.blocks[0].settings.maxDim).toBe(1234)
    expect(w.blocks[0].settings.maxKeypoints).toBeGreaterThan(0)
  })

  it('validates dependencies through preceding outputs', () => {
    const good = createWorkflow('Sparse', ['detect-features', 'match-features', 'reconstruct'])
    expect(workflowPreflight(good, { images: true })).toEqual([])
    const bad = createWorkflow('Broken', ['match-features'])
    expect(workflowPreflight(bad, { images: true })[0]).toMatchObject({ level: 'error' })
  })

  it('marks interactive steps without treating them as errors', () => {
    const w = createWorkflow('Scale', ['scale-bars'])
    const result = workflowPreflight(w, { sparse: true })
    expect(result.some((x) => x.level === 'info')).toBe(true)
    expect(result.some((x) => x.level === 'error')).toBe(false)
  })

  it('starts empty and builds recipe text from user-added blocks', () => {
    const w = createWorkflow()
    expect(w.blocks).toEqual([])
    w.blocks.push(createWorkflowBlock('detect-features'))
    expect(workflowRecipeText(w)).toContain('detect-features')
  })

  it('does not offer input or export operations as workflow blocks', () => {
    expect(() => createWorkflowBlock('import-images')).toThrow('Unknown workflow block')
    expect(() => createWorkflowBlock('export-cloud')).toThrow('Unknown workflow block')
  })

  it('recognises reusable outputs', () => {
    expect(blockOutputValid('reconstruct', { sparse: true })).toBe(true)
    expect(blockOutputValid('gen-ortho', { ortho: false })).toBe(false)
  })

  it('resolves preset deltas and modal unit conversions', () => {
    expect(resolveWorkflowSettings('reconstruct', { preset: 'high' }).baIterations).toBe(60)
    expect(resolveWorkflowSettings('dense', { depthTolPct: 2 }, { memBudgetBytes: 123 }).depthTolRel).toBe(0.02)
    expect(resolveWorkflowSettings('gen-ortho', { depthTolRel: 3 }).depthTolRel).toBe(0.03)
    expect(resolveWorkflowSettings('gen-ortho', {}, { memBudgetBytes: 123 }).memBudgetBytes).toBe(123)
  })

  it('resolves automatic pairing per run, as the Match Features dialog opens', () => {
    const auto = createWorkflowBlock('match-features').settings
    expect(auto.strategy).toBe('auto')
    expect(resolveWorkflowSettings('match-features', auto, {}).strategy).toBe('exhaustive')
    expect(resolveWorkflowSettings('match-features', auto, { video: true }).strategy).toBe('sequential')
    expect(resolveWorkflowSettings('match-features', auto, { video: true, posedImageCount: 12 }).strategy).toBe('preselect')
    // A chosen pairing stands.
    expect(resolveWorkflowSettings('match-features', { ...auto, strategy: 'exhaustive' }, { video: true }).strategy).toBe('exhaustive')
  })

  it('resets detector-specific limits when switching to SuperPoint', () => {
    const sift = createWorkflowBlock('detect-features').settings
    const superpoint = updateWorkflowSetting(sift, 'detector', 'superpoint')
    expect(superpoint).toMatchObject({
      detector: 'superpoint', preset: 'medium', maxDim: 1600, maxKeypoints: 2048,
    })
    expect(superpoint.contrastThreshold).toBeUndefined()
  })

  it('maps custom detector settings to the safe default preset on a detector switch', () => {
    const superpoint = updateWorkflowSetting({
      detector: 'sift', preset: 'custom', maxDim: 9999, maxKeypoints: 50000, overwrite: true,
    }, 'detector', 'superpoint')
    expect(superpoint).toMatchObject({ preset: 'medium', maxDim: 1600, maxKeypoints: 2048, overwrite: true })
  })

  it('textures a mesh once there is a mesh and a sparse model', () => {
    const wf = createWorkflow('t', ['gen-mesh', 'texture-mesh'])
    expect(workflowPreflight(wf, { dense: true, sparse: true }).filter((x) => x.level === 'error')).toEqual([])
    expect(workflowPreflight(createWorkflow('t', ['texture-mesh']), { sparse: true }).some((x) => x.level === 'error')).toBe(true)
    expect(blockOutputValid('texture-mesh', { texturedMesh: true })).toBe(true)
    const s = resolveWorkflowSettings('texture-mesh', { ...wf.blocks[1].settings, maxScale: '0.5', decimateTo: 2e5 }, { useGpu: true, memBudgetBytes: 1 })
    expect(s).toMatchObject({ maxScale: 0.5, decimateTo: 200000, useGpu: true, memBudgetBytes: 1, unseen: 'colour' })
  })
})

describe('quality gates and jumps', () => {
  const sparse = [['detect-features'], ['match-features'], ['reconstruct']]

  it('accepts a gate on a metric an earlier block produces', () => {
    const w = graph([...sparse, ['gate', '', { metric: 'reprojMedianPx', op: '<', threshold: 1 }]])
    expect(errorsOf(workflowPreflight(w, { images: true }))).toEqual([])
  })

  it('refuses a gate whose metric no earlier block produces', () => {
    const w = graph([...sparse, ['gate', '', { metric: 'depthCoveragePct', op: '>=', threshold: 50 }]])
    expect(errorsOf(workflowPreflight(w, { images: true }))[0]).toMatch(/Depth-map coverage is measured on depthMaps/)
    // …but the project may already have it.
    expect(errorsOf(workflowPreflight(w, { images: true, depthMaps: true }))).toEqual([])
  })

  it('refuses unknown metrics, missing thresholds and unknown actions', () => {
    const w = graph([['gate', '', { metric: 'nope', threshold: null, onFail: 'explode' }]])
    const errors = errorsOf(workflowPreflight(w, {})).join('\n')
    expect(errors).toMatch(/unknown metric/)
    expect(errors).toMatch(/set a threshold/)
    expect(errors).toMatch(/unknown failure action/)
  })

  it('validates branch targets: present, named, forward only', () => {
    const missing = graph([...sparse, ['gate', '', { onFail: 'branch', failTarget: '' }]])
    expect(errorsOf(workflowPreflight(missing, { images: true }))[0]).toMatch(/choose where/)
    const dangling = graph([...sparse, ['gate', '', { onFail: 'branch', failTarget: 'hq' }]])
    expect(errorsOf(workflowPreflight(dangling, { images: true }))[0]).toMatch(/no block is named “hq”/)
    const backward = graph([['detect-features'], ['match-features'], ['reconstruct', 'sparse'],
      ['gate', '', { onFail: 'branch', failTarget: 'sparse' }]])
    expect(errorsOf(workflowPreflight(backward, { images: true }))[0]).toMatch(/jumps only go forward/)
    const toEnd = graph([...sparse, ['gate', '', { onFail: 'branch', failTarget: 'end' }]])
    expect(errorsOf(workflowPreflight(toEnd, { images: true }))).toEqual([])
  })

  it('refuses duplicate and unusable names', () => {
    const w = graph([['detect-features', 'a'], ['match-features', 'a'], ['reconstruct', 'end']])
    const errors = errorsOf(workflowPreflight(w, { images: true }))
    expect(errors.some((m) => /already named “a”/.test(m))).toBe(true)
    expect(errors.some((m) => /not a usable name/.test(m))).toBe(true)
  })

  it('requires an output on every path that reaches a block', () => {
    // The pass path jumps over Depth Maps straight to Dense Model.
    const w = graph([...sparse,
      ['gate', '', { metric: 'registeredPct', onFail: 'branch', failTarget: 'depth', passTarget: 'fuse' }],
      ['compute-depth', 'depth'], ['dense', 'fuse']])
    expect(errorsOf(workflowPreflight(w, { images: true }))).toEqual(['Dense Model: requires depthMaps'])
    // A diamond whose both arms produce depth maps is fine.
    const diamond = graph([...sparse,
      ['gate', '', { metric: 'registeredPct', onFail: 'branch', failTarget: 'hq' }],
      ['compute-depth'], ['goto', '', { target: 'fuse' }],
      ['compute-depth', 'hq', { quality: 'high' }], ['dense', 'fuse']])
    expect(errorsOf(workflowPreflight(diamond, { images: true }))).toEqual([])
  })

  it('warns about blocks no path reaches', () => {
    const w = graph([['goto', '', { target: 'end' }], ['detect-features']])
    expect(workflowPreflight(w, { images: true }).find((x) => x.level === 'warning')?.message).toMatch(/never runs/)
    const stop = graph([['gate', '', { metric: 'sparsePoints', onFail: 'stop', passTarget: 'end' }], ['detect-features']])
    expect(workflowPreflight(stop, { sparse: true, images: true }).some((x) => /never runs/.test(x.message))).toBe(true)
  })

  it('checks partial runs from the selected block', () => {
    const w = graph([...sparse, ['gate', '', { metric: 'reprojMedianPx' }]])
    expect(errorsOf(workflowPreflight(w, { images: true }, { fromIndex: 3 }))[0]).toMatch(/measured on sparse/)
    expect(errorsOf(workflowPreflight(w, { sparse: true }, { fromIndex: 3 }))).toEqual([])
  })

  it('resets op and threshold when the metric changes', () => {
    const s = createWorkflowBlock('gate').settings
    expect(updateWorkflowSetting({ ...s, threshold: 3 }, 'metric', 'reprojMedianPx')).toMatchObject({ op: '<', threshold: 1 })
    expect(updateWorkflowSetting(s, 'metric', 'depthCoveragePct')).toMatchObject({ op: '>=', threshold: 50 })
  })

  it('renames a block and every jump that points at it', () => {
    const w = graph([['gate', '', { onFail: 'branch', failTarget: 'hq', passTarget: 'hq' }], ['goto', '', { target: 'hq' }], ['reconstruct', 'hq']])
    const blocks = renameWorkflowBlock(w, w.blocks[2].id, 'better')
    expect(blocks[2].name).toBe('better')
    expect(blocks[0].settings).toMatchObject({ failTarget: 'better', passTarget: 'better' })
    expect(blocks[1].settings.target).toBe('better')
  })
})

describe('tool blocks', () => {
  it('need a dense cloud or a mesh, and always run', () => {
    expect(errorsOf(workflowPreflight(graph([['filter-cloud']]), {}))).toEqual(['Filter Point Cloud: requires dense'])
    expect(errorsOf(workflowPreflight(graph([['gen-mesh'], ['clean-mesh'], ['decimate-mesh'], ['texture-mesh']]),
      { dense: true, sparse: true }))).toEqual([])
    expect(blockOutputValid('filter-cloud', { dense: true })).toBe(false)
  })

  it('build the requests their dialogs emit', () => {
    const f = resolveWorkflowSettings('filter-cloud', { ...createWorkflowBlock('filter-cloud').settings, preset: 'strong' }, { mergeCell: 0.02 })
    expect(f).toMatchObject({ methods: ['isolated', 'sor'], sor: { stdRatio: 1 }, voxel: { cell: 0.02 }, range: { zMin: null } })
    const d = createWorkflowBlock('decimate-mesh').settings
    expect(resolveWorkflowSettings('decimate-mesh', d)).toEqual({ targetRatio: 0.25, preserveBoundary: true })
    expect(resolveWorkflowSettings('decimate-mesh', { ...d, targetMode: 'count', targetTriangles: 1e5 }))
      .toEqual({ targetTriangles: 100000, preserveBoundary: true })
    expect(resolveWorkflowSettings('clean-mesh', { ...createWorkflowBlock('clean-mesh').settings, maxHoleEdges: -1 }).maxHoleEdges).toBe(0)
    expect(resolveWorkflowSettings('align-icp', { reference: ' scan ', maxDistance: 0 })).toMatchObject({ reference: 'scan', maxDistance: 0 })
  })

  it('ICP needs a named reference', () => {
    expect(errorsOf(workflowPreflight(graph([['align-icp']]), { dense: true }))[0]).toMatch(/name the reference/)
    expect(errorsOf(workflowPreflight(graph([['align-icp', '', { reference: 'scan' }]]), { dense: true }))).toEqual([])
  })

  it('normalisation keeps only known settings', () => {
    const w = normalizeWorkflow({ blocks: [{ type: 'smooth-mesh', settings: { iterations: 3, bogus: 1, lambda: Infinity } }] })
    expect(w.blocks[0].settings).toMatchObject({ iterations: 3, lambda: null })
    expect('bogus' in w.blocks[0].settings).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  blockOutputValid, createWorkflow, createWorkflowBlock,
  normalizeWorkflow, resolveWorkflowSettings, updateWorkflowSetting, workflowPreflight, workflowRecipeText,
} from './workflow.js'

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

  it('migrates the untouched version 1 starter to an empty canvas', () => {
    const old = {
      version: 1,
      name: 'Aerial DEM + orthophoto',
      blocks: ['detect-features', 'match-features', 'reconstruct', 'compute-depth', 'dense', 'gen-dem', 'gen-ortho']
        .map((type) => ({ type })),
    }
    expect(normalizeWorkflow(old)).toMatchObject({ version: 2, name: 'Untitled workflow', blocks: [] })
  })

  it('recognises reusable outputs', () => {
    expect(blockOutputValid('reconstruct', { sparse: true })).toBe(true)
    expect(blockOutputValid('gen-ortho', { ortho: false })).toBe(false)
  })

  it('resolves preset deltas and modal unit conversions', () => {
    expect(resolveWorkflowSettings('reconstruct', { preset: 'high' }).baIterations).toBe(60)
    expect(resolveWorkflowSettings('dense', { depthTolPct: 2 }, { memBudgetBytes: 123 }).depthTolRel).toBe(0.02)
    expect(resolveWorkflowSettings('gen-ortho', { depthTolRel: 3 }).depthTolRel).toBe(0.03)
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
})

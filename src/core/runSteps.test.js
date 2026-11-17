import { describe, expect, it } from 'vitest'
import { SPARSE_STEPS, autoMaskSteps, depthMapSteps, matchSteps, phaseUnit, stepStates } from './runSteps.js'
import { SFM_PHASES } from './sfm/progressPlan.js'

describe('run steps', () => {
  it('lists the depth-map steps the method runs', () => {
    expect(depthMapSteps({ geomPass: true }).map((s) => s.id)).toEqual(['pass1', 'pass2', 'filter'])
    expect(depthMapSteps({ geomPass: false, filter: false }).map((s) => s.label)).toEqual(['PatchMatch'])
  })

  it('lists the Auto Mask steps the settings run', () => {
    expect(autoMaskSteps({ edges: 'frame', text: true }).map((s) => s.id)).toEqual(['edges', 'read', 'mask'])
    expect(autoMaskSteps({ edges: 'strip' }).map((s) => s.label)).toEqual(['Masking the edge strips'])
    expect(autoMaskSteps({ edges: 'off', text: true }).map((s) => s.id)).toEqual(['read', 'mask'])
  })

  it('follows the sparse run phases', () => {
    expect(SPARSE_STEPS.map((s) => s.id)).toEqual(SFM_PHASES.map((p) => p.key))
  })

  it('marks steps done, running, to come or skipped', () => {
    const steps = depthMapSteps({ geomPass: true })
    expect(stepStates(steps, 'pass2', ['pass1', 'pass2']).map((s) => s.state)).toEqual(['done', 'running', 'todo'])
    // A step before the current one that never reported was left out.
    expect(stepStates(steps, 'filter', ['filter']).map((s) => s.state)).toEqual(['skipped', 'skipped', 'running'])
    expect(stepStates(steps, 'unknown')).toEqual([])
    expect(stepStates(steps, '')).toEqual([])
  })

  it('lists the matching passes that can run, the later ones optional', () => {
    expect(matchSteps().map((s) => s.id)).toEqual(['pairs'])
    const all = matchSteps({ retrieval: true, rescue: true, bridge: true, gap: true, turn: true })
    expect(all.map((s) => s.id)).toEqual(['retrieval', 'pairs', 'rescue', 'bridge', 'gap', 'turn'])
    expect(all.filter((s) => s.optional).map((s) => s.id)).toEqual(['rescue', 'bridge', 'gap', 'turn'])
  })

  it('lets a step own its sub-phases', () => {
    const steps = matchSteps({ bridge: true, turn: true })
    // Bridge repair's rounds and the turn search's three parts are one step each.
    expect(stepStates(steps, 'bridge-2', ['pairs', 'bridge-1']).map((s) => s.state)).toEqual([
      'done',
      'running',
      'todo',
    ])
    expect(stepStates(steps, 'turn-detect', ['pairs', 'turn-probe']).map((s) => s.state)).toEqual([
      'done',
      'skipped',
      'running',
    ])
    // A phase that only shares the start of an id is not the step's.
    expect(stepStates([{ id: 'turn', label: '' }], 'turnover')).toEqual([])
  })

  it('counts a phase in its own unit', () => {
    const steps = matchSteps({ gap: true, turn: true })
    expect(phaseUnit(steps, 'turn-detect', 'pairs')).toBe('images')
    expect(phaseUnit(steps, 'turn-probe', 'pairs')).toBe('')
    expect(phaseUnit(steps, 'turn-match', 'pairs')).toBe('pairs')
    expect(phaseUnit(steps, 'pairs', 'pairs')).toBe('pairs')
  })
})

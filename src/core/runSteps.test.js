import { describe, expect, it } from 'vitest'
import { SPARSE_STEPS, autoMaskSteps, depthMapSteps, stepStates } from './runSteps.js'
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
})

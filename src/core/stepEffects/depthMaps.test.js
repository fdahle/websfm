import { describe, it, expect } from 'vitest'
import { depthMapEffects } from './depthMaps.js'
import { DEPTHMAP_DEFAULTS } from '../defaults.user.js'

const project = { registered: 42, nativeLong: 6000 }

describe('depthMapEffects', () => {
  it('states the working resolution Quality gives, as the run resolves it', () => {
    const e = depthMapEffects(DEPTHMAP_DEFAULTS, project)
    expect(e.resolution).toMatch(/^42 depth maps, one per registered image, at up to 1,500 px/)
    expect(e.resolution).toMatch(/Medium: ¼ of the largest original, 6,000 px/)
    expect(e.resolution).toMatch(/up to 10 neighbours/)
    expect(depthMapEffects({ ...DEPTHMAP_DEFAULTS, maxDim: 2400 }, project).resolution).toMatch(
      /up to 2,400 px on the long side \(fixed here\)/,
    )
    expect(depthMapEffects(DEPTHMAP_DEFAULTS, { registered: 0 }).resolution).toMatch(/Build the sparse model first/)
  })

  it('describes the window, the filters, and what turning a filter off means', () => {
    const e = depthMapEffects(DEPTHMAP_DEFAULTS, project)
    expect(e.patchMatch).toMatch(/^A 7×7 px correlation window; 5 propagation sweeps/)
    expect(e.speckle).toMatch(/more than 10 %/)
    expect(e.crossView).toMatch(/at least 2 other views \(auto for an aerial \/ mapping project\) agree on/)
    const obj = depthMapEffects(DEPTHMAP_DEFAULTS, { ...project, sceneType: 'object' })
    expect(obj.crossView).toMatch(/at least 1 other view \(auto for an object capture project\) agrees on/)
    expect(depthMapEffects({ ...DEPTHMAP_DEFAULTS, minConsistent: 3 }, project).crossView).toMatch(
      /at least 3 other views agree on/,
    )
    const off = depthMapEffects({ ...DEPTHMAP_DEFAULTS, speckleFilter: false, geomConsistency: false }, project)
    expect(off.speckle).toMatch(/^Off/)
    expect(off.crossView).toMatch(/^Off/)
  })

  it('names the view selection, auto resolved by the backend', () => {
    expect(depthMapEffects(DEPTHMAP_DEFAULTS, { ...project, gpu: true }).patchMatch).toMatch(
      /Full method \(auto, on the GPU\)/,
    )
    expect(depthMapEffects(DEPTHMAP_DEFAULTS, { ...project, gpu: false }).patchMatch).toMatch(
      /Fast method \(auto, without a GPU\)/,
    )
    expect(depthMapEffects({ ...DEPTHMAP_DEFAULTS, method: 'full' }, project).patchMatch).toMatch(
      /Full method: ACMH view selection/,
    )
  })
})

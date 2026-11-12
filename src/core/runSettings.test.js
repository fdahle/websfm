import { describe, it, expect } from 'vitest'
import {
  depthRunSettings,
  denseRunSettings,
  demRunSettings,
  orthoRunSettings,
  meshRunSettings,
  textureRunSettings,
} from './runSettings.js'
import { resolveWorkflowSettings } from './workflow.js'
import {
  DEPTHMAP_DEFAULTS,
  DENSE_FUSE_DEFAULTS,
  DEM_DEFAULTS,
  ORTHO_DEFAULTS,
  MESH_DEFAULTS,
  TEXTURE_DEFAULTS,
} from './defaults.user.js'

const runtime = { useGpu: true, memBudgetBytes: 4e9, ramBudgetBytes: 16e9 }

describe('a workflow block runs as its dialog would', () => {
  it.each([
    ['compute-depth', DEPTHMAP_DEFAULTS, depthRunSettings],
    ['dense', DENSE_FUSE_DEFAULTS, denseRunSettings],
    ['gen-dem', DEM_DEFAULTS, demRunSettings],
    ['gen-ortho', ORTHO_DEFAULTS, orthoRunSettings],
    ['gen-mesh', MESH_DEFAULTS, meshRunSettings],
  ])('%s with the defaults', (type, defaults, convert) => {
    expect(resolveWorkflowSettings(type, { ...defaults }, runtime)).toEqual(convert({ ...defaults }, runtime))
  })

  it('texture-mesh with the defaults, plus the block’s own decimation', () => {
    expect(resolveWorkflowSettings('texture-mesh', { decimateTo: 2e5, ...TEXTURE_DEFAULTS }, runtime)).toEqual({
      ...textureRunSettings(TEXTURE_DEFAULTS, runtime),
      decimateTo: 200000,
    })
  })

  it.each(['dense', 'gen-dem', 'gen-ortho', 'gen-mesh'])('%s keeps Replace the main product', (type) => {
    expect(resolveWorkflowSettings(type, { replaceMain: true }, runtime).replaceMain).toBe(true)
  })
})

describe('unit conversion', () => {
  it('turns percentages into fractions and 0 into "no limit"', () => {
    expect(depthRunSettings({ filterRelTol: 10 }).filterRelTol).toBeCloseTo(0.1, 12)
    expect(denseRunSettings({ depthTolPct: 1 }).depthTolRel).toBeCloseTo(0.01, 12)
    const o = orthoRunSettings({ depthTolRel: 2, maxCost: 0 })
    expect(o.depthTolRel).toBeCloseTo(0.02, 12)
    expect(o.maxCost).toBe(Infinity)
  })

  it('automatic fusion thresholds leave minViews and maxCost to the run', () => {
    expect(denseRunSettings({ auto: true, minViews: 5, maxCost: 0.3 })).toMatchObject({ minViews: null, maxCost: null })
    expect(denseRunSettings({ auto: false, minViews: 5, maxCost: 0.3 })).toMatchObject({ minViews: 5, maxCost: 0.3 })
  })

  it('sends only the size field sizeBy names', () => {
    const dem = demRunSettings({ sizeBy: 'px', gsd: 0.05, longSide: 4000 })
    expect(dem.gsd).toBeUndefined()
    expect(dem.longSide).toBe(4000)
    expect(demRunSettings({ sizeBy: 'gsd', gsd: 0.05, longSide: 4000 })).toMatchObject({ gsd: 0.05 })
    expect(demRunSettings({ sizeBy: 'gsd', gsd: 0.05, longSide: 4000 }).longSide).toBeUndefined()
    const ortho = orthoRunSettings({ sizeBy: 'px', gsd: 0.05, longSide: 4000 })
    expect(ortho).toMatchObject({ gsd: 0, longSide: 4000 })
  })

  it('a workflow block uses the long side only when its GSD is 0', () => {
    expect(resolveWorkflowSettings('gen-dem', { gsd: 0.1, longSide: 3000 })).toMatchObject({ gsd: 0.1 })
    expect(resolveWorkflowSettings('gen-dem', { gsd: 0, longSide: 3000 })).toMatchObject({ longSide: 3000 })
    expect(resolveWorkflowSettings('gen-dem', { gsd: 0, longSide: 3000 }).gsd).toBeUndefined()
    expect(resolveWorkflowSettings('gen-ortho', { gsd: 0, longSide: 3000 })).toMatchObject({ gsd: 0, longSide: 3000 })
  })

  it('posts plain arrays, not the dialog’s reactive ones', () => {
    const classes = [2, 5]
    const out = demRunSettings({ classes })
    expect(out.classes).toEqual([2, 5])
    expect(out.classes).not.toBe(classes)
  })
})

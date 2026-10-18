import { describe, it, expect, vi } from 'vitest'
import { runConsoleLine, splitArgs, findImage, statsLines, matchStatsLines, argCompletionsFor } from './console.js'
import { completions } from './commands.js'
import {
  parseTuningKey, parseTuningValue, mergeOverrides, setPath, describeOverrides, tuningKeys,
} from './consoleSettings.js'
import { SFM_TUNING } from '../tuning.js'

const READY = {
  projectReady: true, imageCount: 3, kpImageCount: 3, matchCount: 2, sparseReady: true,
  depthMapCount: 3, cloudReady: true, denseReady: true, meshReady: true, sceneType: 'aerial',
}
const IMAGES = [
  { id: 1, uuid: 'u1', name: 'DJI_0001.JPG' },
  { id: 2, uuid: 'u2', name: 'DJI_0002.JPG' },
  { id: 3, uuid: 'u3', name: 'Other photo.jpg' },
]

// A fake console environment: records what the executor asked for.
function fakeEnv(over = {}) {
  let overrides = {}
  const env = {
    lines: [],
    log(m, level = 'info') { env.lines.push([level, m]) },
    clear: vi.fn(),
    state: () => READY,
    dispatch: vi.fn(),
    workflows: () => [{ id: 'w1', name: 'Full pipeline', blocks: [] }, { id: 'w2', name: 'Products', blocks: [] }],
    startWorkflow: vi.fn(async () => true),
    workflowStatus: () => ({ running: false, pause: null }),
    respond: vi.fn(),
    stopWorkflow: vi.fn(),
    images: () => IMAGES,
    pairState: vi.fn((a, b) => (a === 'u1' && b === 'u2' ? { pid: 'u1--u2', enabled: true, inliers: 120 } : null)),
    setPairEnabled: vi.fn(),
    selectImage: vi.fn(),
    tuning: { get: (g) => overrides[g] ?? {}, set: (g, path, v) => { overrides = { ...overrides, [g]: setPath(overrides[g], path, v) } } },
    ...over,
  }
  return env
}
const text = (env) => env.lines.map(([, m]) => m).join('\n')
const last = (env) => env.lines.at(-1)

describe('dispatch', () => {
  it('echoes, resolves and dispatches a ribbon command', () => {
    const env = fakeEnv()
    runConsoleLine('decimate', env)
    expect(env.lines[0][1]).toBe('› decimate')
    expect(env.dispatch).toHaveBeenCalledWith('decimate-mesh')
  })

  it('guards with the ribbon\'s prerequisites', () => {
    const env = fakeEnv({ state: () => ({ ...READY, meshReady: false }) })
    runConsoleLine('crop mesh', env)
    expect(env.dispatch).not.toHaveBeenCalled()
    expect(last(env)).toEqual(['warn', 'Build a mesh first'])
  })

  it('passes a stepper its value, in range only', () => {
    const env = fakeEnv()
    runConsoleLine('point size 4', env)
    expect(env.dispatch).toHaveBeenCalledWith('view-point-size', 4)
    runConsoleLine('point size 40', env)
    expect(env.dispatch).toHaveBeenCalledTimes(1)
    expect(last(env)[1]).toMatch(/Usage: point size <value>/)
  })

  it('suggests a command for a typo', () => {
    const env = fakeEnv()
    runConsoleLine('stast', env)
    expect(last(env)[0]).toBe('error')
    expect(last(env)[1]).toContain('stats')
  })
})

describe('help', () => {
  it('prints a command\'s usage and a tab\'s commands', () => {
    const env = fakeEnv()
    runConsoleLine('help pair', env)
    expect(text(env)).toContain('usage: pair disable <imageA> <imageB>')
    runConsoleLine('help export', env)
    expect(text(env)).toContain('export measurements')
    runConsoleLine('help nope', env)
    expect(last(env)).toEqual(['error', 'No such command or tab: nope'])
  })
})

describe('run', () => {
  it('chains stages into an always-rerun workflow', () => {
    const env = fakeEnv()
    runConsoleLine('run detect match sparse', env)
    const wf = env.startWorkflow.mock.calls[0][0]
    expect(wf.blocks.map((b) => b.type)).toEqual(['detect-features', 'match-features', 'reconstruct'])
    expect(wf.defaults.reusePolicy).toBe('rerun')
    expect(text(env)).toContain('Running detect-features → match-features → reconstruct')
  })

  it('runs a saved workflow by (the start of) its name', () => {
    const env = fakeEnv()
    runConsoleLine('run workflow full', env)
    expect(env.startWorkflow.mock.calls[0][0].id).toBe('w1')
    runConsoleLine('run workflow "Nope"', env)
    expect(last(env)[1]).toContain('saved: Full pipeline, Products')
  })

  it('refuses unknown stages and a second run', () => {
    const env = fakeEnv()
    runConsoleLine('run detect fly', env)
    expect(last(env)[1]).toMatch(/Unknown stage: fly/)
    const busy = fakeEnv({ workflowStatus: () => ({ running: true, pause: null }) })
    runConsoleLine('run dense', busy)
    expect(busy.startWorkflow).not.toHaveBeenCalled()
  })

  it('reports a blocked preflight and clears it', async () => {
    let pause = null
    const env = fakeEnv({
      startWorkflow: vi.fn(async () => { pause = { kind: 'blocked', message: 'Depth Maps: requires sparse' }; return false }),
      workflowStatus: () => ({ running: false, pause }),
    })
    runConsoleLine('run depth', env)
    await vi.waitFor(() => expect(env.respond).toHaveBeenCalledWith('dismiss'))
    expect(text(env)).toContain('Workflow blocked: Depth Maps: requires sparse')
  })

  it('continue / reuse / stop answer a paused run', () => {
    const env = fakeEnv({ workflowStatus: () => ({ running: true, pause: { kind: 'reuse', message: 'x' } }) })
    runConsoleLine('reuse', env)
    expect(env.respond).toHaveBeenCalledWith('reuse')
    runConsoleLine('stop', env)
    expect(env.stopWorkflow).toHaveBeenCalled()
    const idle = fakeEnv()
    runConsoleLine('continue', idle)
    expect(last(idle)).toEqual(['warn', 'No workflow is waiting'])
  })
})

describe('set', () => {
  it('echoes old → new and validates the type against the default', () => {
    const env = fakeEnv()
    runConsoleLine('set sfm.minPnpInlierRatio 0.5', env)
    expect(last(env)[1]).toBe(`sfm.minPnpInlierRatio: ${SFM_TUNING.minPnpInlierRatio} → 0.5 (default ${SFM_TUNING.minPnpInlierRatio}) — applies to the next Sparse Model run, this session only`)
    expect(env.tuning.get('sfm')).toEqual({ minPnpInlierRatio: 0.5 })
    runConsoleLine('set sfm.minPnpInlierRatio lots', env)
    expect(last(env)).toEqual(['error', 'sfm.minPnpInlierRatio expects a number, got "lots"'])
    runConsoleLine('set sfm.minPnpInlierRatio default', env)
    expect(last(env)[1]).toBe(`sfm.minPnpInlierRatio: 0.5 → ${SFM_TUNING.minPnpInlierRatio} (default)`)
    expect(env.tuning.get('sfm')).toEqual({})
  })

  it('sets nested and boolean keys, lists overrides and groups', () => {
    const env = fakeEnv()
    runConsoleLine('set sfm.baSolver.pcgMaxIter 400', env)
    runConsoleLine('set match.lgMinConf 0.1', env)
    runConsoleLine('set sfm.rescueStalled off', env)
    expect(env.tuning.get('sfm')).toEqual({ baSolver: { pcgMaxIter: 400 }, rescueStalled: false })
    env.lines = []
    runConsoleLine('set', env)
    expect(text(env)).toContain('sfm.baSolver.pcgMaxIter = 400 (default 200)')
    expect(text(env)).toContain('match.lgMinConf = 0.1')
    env.lines = []
    runConsoleLine('set sfm.baSolver', env)
    expect(text(env)).toContain('sfm.baSolver.pcgMaxIter = 400  (set; default 200)')
    expect(text(env)).toContain('sfm.baSolver.direct = true')
  })

  it('refuses dialog settings, unknown keys and whole groups', () => {
    const env = fakeEnv()
    runConsoleLine('set sfm.reprjThreshold 2', env)
    expect(last(env)).toEqual(['error', 'sfm.reprjThreshold is a Sparse Model dialog setting — set it there'])
    runConsoleLine('set sfm.minPnpRatio 2', env)
    expect(last(env)[1]).toMatch(/^Unknown key sfm.minPnpRatio/)
    runConsoleLine('set dense.x 1', env)
    expect(last(env)[1]).toMatch(/settable groups: sfm, match/)
    runConsoleLine('set sfm.baSolver 3', env)
    expect(last(env)[1]).toMatch(/is a group of settings/)
  })
})

describe('pair and select', () => {
  it('excludes a verified pair by image names', () => {
    const env = fakeEnv()
    runConsoleLine('pair disable DJI_0001 dji_0002.jpg', env)
    expect(env.setPairEnabled).toHaveBeenCalledWith('u1--u2', false)
    expect(last(env)[1]).toMatch(/DJI_0001.JPG ↔ DJI_0002.JPG \(120 inliers\) excluded from reconstruction/)
    runConsoleLine('pair enable DJI_0001 "Other photo.jpg"', env)
    expect(last(env)).toEqual(['error', 'No verified pair DJI_0001.JPG ↔ Other photo.jpg'])
    runConsoleLine('pair drop a b', env)
    expect(last(env)[1]).toMatch(/^Usage: pair/)
  })

  it('says when a pair is already in that state', () => {
    const env = fakeEnv()
    runConsoleLine('pair enable DJI_0001 DJI_0002', env)
    expect(env.setPairEnabled).not.toHaveBeenCalled()
    expect(last(env)[1]).toContain('already included')
  })

  it('selects an image by a unique part of its name', () => {
    const env = fakeEnv()
    runConsoleLine('select other photo', env)
    expect(env.selectImage).toHaveBeenCalledWith(3)
    runConsoleLine('select DJI', env)
    expect(last(env)[1]).toMatch(/matches 2 images/)
  })
})

describe('helpers', () => {
  it('splits quoted arguments', () => {
    expect(splitArgs('disable "A b.jpg" c')).toEqual(['disable', 'A b.jpg', 'c'])
  })

  it('finds images exactly before by prefix before by substring', () => {
    const imgs = [{ name: 'a.jpg' }, { name: 'a.jpg.bak' }, { name: 'xa.jpg' }]
    expect(findImage(imgs, 'A.JPG').image.name).toBe('a.jpg')
    expect(findImage(imgs, 'xa').image.name).toBe('xa.jpg')
    expect(findImage(imgs, 'nothing').error).toBe('No image named "nothing"')
  })

  it('formats stats and match stats', () => {
    const lines = statsLines({ images: 3, detected: 3, keypoints: 30000, pairs: { total: 3, verified: 2, excluded: 1 },
      sparse: { cameras: 3, points: 1234 }, dense: [{ name: 'Dense', points: 1e6 }], meshes: [], dem: null, ortho: null,
      frame: 'model units (no georeference or scale)' })
    expect(lines).toContain('Pairs: 2 verified of 3 matched, 1 excluded')
    expect(lines).toContain('Sparse model: 3 of 3 images registered, 1,234 points')
    const m = matchStatsLines([
      { nameA: 'a', nameB: 'b', idA: 1, idB: 2, inliers: 50, enabled: true },
      { nameA: 'a', nameB: 'c', idA: 1, idB: 3, inliers: 10, enabled: false },
    ], [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }])
    expect(m).toContain('No verified pair: c')
    expect(m).toContain('Excluded by you: a ↔ c')
  })

  it('completes tuning keys, stages and image names after a verb', () => {
    const args = argCompletionsFor(fakeEnv())
    expect(completions('set sfm.minpnpi', args)).toEqual(['set sfm.minPnpInlierRatio', 'set sfm.minPnpInliers'])
    expect(completions('run de', args)).toEqual(['run dem', 'run dense', 'run depth', 'run detect'])
    expect(completions('select oth', args)).toEqual(['select Other photo.jpg'])
  })
})

describe('consoleSettings', () => {
  it('parses keys and values by the default\'s type', () => {
    expect(parseTuningKey('sfm.baSolver.pcgMinN')).toMatchObject({ group: 'sfm', path: ['baSolver', 'pcgMinN'], def: null })
    expect(parseTuningValue('null', null)).toEqual({ value: null })
    expect(parseTuningValue('600', null)).toEqual({ value: 600 })
    expect(parseTuningValue('"response"', 'coarse-first')).toEqual({ value: 'response' })
    expect(parseTuningValue('maybe', true).error).toMatch(/true or false/)
  })

  it('merges nested overrides key by key and describes them', () => {
    const o = { baSolver: { pcgMaxIter: 400 }, minPnpInlierRatio: 0.5 }
    expect(mergeOverrides({ baSolver: { direct: false }, x: 1 }, o)).toEqual({ baSolver: { direct: false, pcgMaxIter: 400 }, x: 1, minPnpInlierRatio: 0.5 })
    expect(describeOverrides(o)).toBe('baSolver.pcgMaxIter=400, minPnpInlierRatio=0.5')
    expect(setPath(o, ['baSolver', 'pcgMaxIter'], undefined)).toEqual({ minPnpInlierRatio: 0.5 })
    expect(tuningKeys('sfm')).toContain('sfm.baSolver.pcgRelTol')
  })
})

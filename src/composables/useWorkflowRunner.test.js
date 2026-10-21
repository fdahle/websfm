import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createWorkflow } from '../core/workflow.js'
import { useWorkflowRunner } from './useWorkflowRunner.js'

describe('useWorkflowRunner', () => {
  it('executes automated blocks in order', async () => {
    const calls = []
    const workflow = createWorkflow('Sparse', ['detect-features', 'match-features', 'reconstruct'])
    const state = ref({ images: true })
    const runner = useWorkflowRunner({
      state,
      runAutomated: async (type) => {
        calls.push(type)
        if (type === 'detect-features') state.value.keypoints = true
        if (type === 'match-features') state.value.matches = true
        if (type === 'reconstruct') state.value.sparse = true
      },
      openInteractive: vi.fn(),
      recordRun: vi.fn(),
    })
    await runner.start(workflow)
    expect(calls).toEqual(['detect-features', 'match-features', 'reconstruct'])
  })

  it('reuses valid output by default', async () => {
    const run = vi.fn()
    const workflow = createWorkflow('Sparse', ['reconstruct'])
    const runner = useWorkflowRunner({
      state: ref({ matches: true, sparse: true }),
      runAutomated: run,
      openInteractive: vi.fn(),
      recordRun: vi.fn(),
    })
    await runner.start(workflow)
    expect(run).not.toHaveBeenCalled()
    expect(Object.values(runner.statuses.value)[0].status).toBe('reused')
  })

  it('fails a rerun when the stage reports failure even if old output exists', async () => {
    const workflow = createWorkflow('Retry', ['reconstruct'])
    workflow.defaults.reusePolicy = 'rerun'
    const recordRun = vi.fn()
    const runner = useWorkflowRunner({
      state: ref({ matches: true, sparse: true }),
      runAutomated: async () => ({ ok: false, reason: 'memory preflight refused the run' }),
      openInteractive: vi.fn(),
      recordRun,
    })

    expect(await runner.start(workflow)).toBe(false)
    expect(Object.values(runner.statuses.value)[0]).toMatchObject({
      status: 'failed',
      detail: 'memory preflight refused the run',
    })
    expect(recordRun.mock.calls[0][0]).toMatchObject({ outcome: 'failed' })
  })

  it('locks while awaiting a preflight warning so a second start cannot replace its decision', async () => {
    const workflow = createWorkflow('Reference', ['georeference'])
    const runner = useWorkflowRunner({
      state: ref({ sparse: true, sceneType: 'object' }),
      runAutomated: vi.fn(),
      openInteractive: vi.fn(),
      recordRun: vi.fn(),
    })

    const first = runner.start(workflow)
    await Promise.resolve()
    expect(runner.running.value).toBe(true)
    expect(runner.pause.value?.kind).toBe('warning')
    expect(await runner.start(workflow)).toBe(false)
    runner.respond('continue')
    await Promise.resolve()
    expect(runner.pause.value?.kind).toBe('interactive')
    runner.respond('stop')
    expect(await first).toBe(false)
  })

  it('cancels the active automated stage when stopped', async () => {
    const workflow = createWorkflow('Detect', ['detect-features'])
    let finish
    const cancelAutomated = vi.fn()
    const runner = useWorkflowRunner({
      state: ref({ images: true }),
      runAutomated: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      cancelAutomated,
      openInteractive: vi.fn(),
      recordRun: vi.fn(),
    })

    const run = runner.start(workflow)
    await Promise.resolve()
    runner.stop()
    expect(cancelAutomated).toHaveBeenCalledOnce()
    finish({ ok: false, cancelled: true })
    expect(await run).toBe(false)
    expect(Object.values(runner.statuses.value)[0].status).toBe('stopped')
  })
})

describe('useWorkflowRunner quality gates', () => {
  // Sparse model → gate on reprojection → (fail) high-preset retry at "hq", else on.
  function gated(gate, tail = [['compute-depth']]) {
    const w = createWorkflow('Gated', ['reconstruct', 'gate', ...tail.map(([t]) => t)])
    Object.assign(w.blocks[1].settings, { metric: 'reprojMedianPx', op: '<', threshold: 1 }, gate)
    tail.forEach(([, name], i) => {
      if (name) w.blocks[2 + i].name = name
    })
    return w
  }
  function harness(value) {
    const calls = []
    const state = ref({ matches: true })
    const recordRun = vi.fn()
    const runner = useWorkflowRunner({
      state,
      recordRun,
      openInteractive: vi.fn(),
      measure: vi.fn(async () => value),
      runAutomated: async (type, settings, context) => {
        calls.push(type)
        context.seen = (context.seen ?? 0) + 1
        if (type === 'reconstruct') state.value.sparse = true
        if (type === 'compute-depth') state.value.depthMaps = true
        return { ok: true }
      },
    })
    return { runner, calls, recordRun }
  }

  it('continues on a pass and records the measured value in the snapshot', async () => {
    const { runner, calls, recordRun } = harness(0.6)
    const w = gated({ onFail: 'stop' })
    expect(await runner.start(w)).toBe(true)
    expect(calls).toEqual(['reconstruct', 'compute-depth'])
    const snap = recordRun.mock.calls[0][0]
    expect(snap.outcome).toBe('completed')
    expect(snap.gates).toEqual([
      expect.objectContaining({
        metric: 'reprojMedianPx',
        value: 0.6,
        op: '<',
        threshold: 1,
        outcome: 'pass',
        action: 'continue',
        target: null,
      }),
    ])
    expect(snap.statuses[w.blocks[1].id]).toMatchObject({ status: 'passed', gate: { outcome: 'pass' } })
  })

  it('stops a run as failed when a stopping gate fails', async () => {
    const { runner, calls, recordRun } = harness(1.7)
    expect(await runner.start(gated({ onFail: 'stop' }))).toBe(false)
    expect(calls).toEqual(['reconstruct'])
    expect(recordRun.mock.calls[0][0]).toMatchObject({
      outcome: 'failed',
      error: expect.stringMatching(/Quality gate failed — Reprojection median 1.70 px/),
    })
  })

  it('branches forward on failure and marks the skipped blocks', async () => {
    const { runner, calls, recordRun } = harness(1.7)
    const w = gated({ onFail: 'branch', failTarget: 'hq' }, [['compute-depth'], ['reconstruct', 'hq']])
    w.blocks[3].reusePolicy = 'rerun'
    expect(await runner.start(w)).toBe(true)
    expect(calls).toEqual(['reconstruct', 'reconstruct'])
    const snap = recordRun.mock.calls[0][0]
    expect(snap.statuses[w.blocks[2].id].status).toBe('skipped')
    expect(snap.gates[0]).toMatchObject({ outcome: 'fail', action: 'branch', target: 'hq' })
  })

  it('a pass target jumps over the fail branch; Go to ends the run', async () => {
    const { runner, calls } = harness(0.5)
    const w = gated({ onFail: 'continue', passTarget: 'depth' }, [
      ['reconstruct'],
      ['compute-depth', 'depth'],
      ['goto'],
      ['dense'],
    ])
    w.blocks[4].settings.target = 'end'
    // Dense Model sits behind `goto end`: preflight warns that it never runs.
    w.defaults.warningPolicy = 'continue'
    expect(await runner.start(w)).toBe(true)
    expect(calls).toEqual(['reconstruct', 'compute-depth'])
  })

  it('pauses on failure until the user continues', async () => {
    const { runner, calls, recordRun } = harness(1.7)
    const run = runner.start(gated({ onFail: 'pause' }))
    await vi.waitFor(() => expect(runner.pause.value?.kind).toBe('gate'))
    expect(runner.pause.value.message).toMatch(/fails < 1 px/)
    runner.respond('continue')
    expect(await run).toBe(true)
    expect(calls).toEqual(['reconstruct', 'compute-depth'])
    expect(recordRun.mock.calls[0][0].gates[0]).toMatchObject({
      outcome: 'fail',
      action: 'pause',
      decision: 'continue',
    })
  })

  it('fails a gate whose metric the project cannot report', async () => {
    const { runner, recordRun } = harness(null)
    expect(await runner.start(gated({ onFail: 'stop' }))).toBe(false)
    expect(recordRun.mock.calls[0][0].gates[0]).toMatchObject({ outcome: 'missing', value: null })
  })

  it('refuses to start a workflow whose jumps preflight rejects', async () => {
    const { runner, calls } = harness(0.5)
    const w = gated({ onFail: 'branch', failTarget: 'nowhere' })
    expect(await runner.start(w)).toBe(false)
    expect(runner.pause.value).toMatchObject({
      kind: 'blocked',
      message: expect.stringMatching(/no block is named “nowhere”/),
    })
    expect(calls).toEqual([])
  })

  it('hands one context object along the run', async () => {
    const seen = []
    const state = ref({ dense: true, mesh: true })
    const runner = useWorkflowRunner({
      state,
      recordRun: vi.fn(),
      openInteractive: vi.fn(),
      runAutomated: async (type, settings, context) => {
        seen.push(context)
        context.cloudId = type
        return { ok: true }
      },
    })
    await runner.start(createWorkflow('Chain', ['filter-cloud', 'estimate-normals', 'clean-mesh']))
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(1)
  })

  it('checks image files before a run that reads pixels, and pauses on unreadable ones', async () => {
    const checkSources = vi.fn(async () => '2 images can no longer be read (a.jpg, b.jpg)')
    const run = vi.fn()
    const runner = useWorkflowRunner({
      state: ref({ images: true }),
      runAutomated: run,
      checkSources,
      openInteractive: vi.fn(),
      recordRun: vi.fn(),
    })
    const started = runner.start(createWorkflow('Detect', ['detect-features']))
    await vi.waitFor(() => expect(runner.pause.value?.kind).toBe('warning'))
    expect(runner.pause.value.message).toContain('a.jpg')
    runner.respond('stop')
    expect(await started).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('skips the image check when no block reads pixels, or every file is readable', async () => {
    const checkSources = vi.fn(async () => null)
    const run = vi.fn(async () => ({ ok: true }))
    const runner = useWorkflowRunner({
      state: ref({ images: true, dense: true }),
      runAutomated: run,
      checkSources,
      openInteractive: vi.fn(),
      recordRun: vi.fn(),
    })
    await runner.start(createWorkflow('Filter', ['filter-cloud']))
    expect(checkSources).not.toHaveBeenCalled()
    await runner.start(createWorkflow('Detect', ['detect-features']))
    expect(checkSources).toHaveBeenCalledOnce()
    expect(runner.pause.value).toBeNull()
  })
})

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
      openInteractive: vi.fn(), recordRun: vi.fn(),
    })
    await runner.start(workflow)
    expect(calls).toEqual(['detect-features', 'match-features', 'reconstruct'])
  })

  it('reuses valid output by default', async () => {
    const run = vi.fn()
    const workflow = createWorkflow('Sparse', ['reconstruct'])
    const runner = useWorkflowRunner({
      state: ref({ matches: true, sparse: true }), runAutomated: run,
      openInteractive: vi.fn(), recordRun: vi.fn(),
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
      openInteractive: vi.fn(), recordRun,
    })

    expect(await runner.start(workflow)).toBe(false)
    expect(Object.values(runner.statuses.value)[0]).toMatchObject({
      status: 'failed', detail: 'memory preflight refused the run',
    })
    expect(recordRun.mock.calls[0][0]).toMatchObject({ outcome: 'failed' })
  })

  it('locks while awaiting a preflight warning so a second start cannot replace its decision', async () => {
    const workflow = createWorkflow('Reference', ['georeference'])
    const runner = useWorkflowRunner({
      state: ref({ sparse: true, sceneType: 'object' }), runAutomated: vi.fn(),
      openInteractive: vi.fn(), recordRun: vi.fn(),
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
      runAutomated: () => new Promise((resolve) => { finish = resolve }),
      cancelAutomated, openInteractive: vi.fn(), recordRun: vi.fn(),
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

import { describe, it, expect, vi } from 'vitest'
import { createDocumentSaver } from './documentSaver.js'
import { flushPersistence } from './persistence.js'

// A write whose completion the test controls.
function gate() {
  const calls = []
  const write = vi.fn(
    (projectId, doc) => new Promise((resolve, reject) => calls.push({ projectId, doc, resolve, reject })),
  )
  return { calls, write }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createDocumentSaver', () => {
  it('collapses saves during a write into one re-run that reads the latest state', async () => {
    let state = 1,
      project = 'a'
    const { calls, write } = gate()
    const save = createDocumentSaver({ label: 't1', currentProjectId: () => project, build: () => ({ state }), write })
    const first = save()
    await tick()
    state = 2
    save()
    state = 3
    const last = save()
    expect(calls).toHaveLength(1)
    calls[0].resolve()
    await tick()
    expect(calls).toHaveLength(2)
    expect(calls[1].doc).toEqual({ state: 3 })
    calls[1].resolve()
    await Promise.all([first, last])
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('drops a queued re-run once its project is no longer open, and runs the next project after it', async () => {
    let project = 'a',
      state = 'A'
    const { calls, write } = gate()
    const save = createDocumentSaver({ label: 't2', currentProjectId: () => project, build: () => state, write })
    save()
    await tick()
    save() // queued re-run for project a
    project = 'b'
    state = 'B' // the switch
    const forB = save() // b's own save waits for a's drain
    calls[0].resolve()
    await tick()
    await tick()
    expect(calls.map((c) => [c.projectId, c.doc])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ])
    calls[1].resolve()
    await forB
  })

  it('is one tracked operation, so a flush waits for the re-run too', async () => {
    let state = 1
    const { calls, write } = gate()
    const save = createDocumentSaver({ label: 't3', currentProjectId: () => 'a', build: () => state, write })
    save()
    await tick()
    state = 2
    save()
    let flushed = false
    const flush = flushPersistence().then(() => {
      flushed = true
    })
    calls[0].resolve()
    await tick()
    await tick()
    expect(flushed).toBe(false) // the re-run is still pending
    calls[1].resolve()
    await flush
    expect(flushed).toBe(true)
  })

  it('reports a failed write through onError and saves nothing without a project', async () => {
    const onError = vi.fn()
    const write = vi.fn().mockRejectedValue(new Error('disk full'))
    const save = createDocumentSaver({ label: 't4', currentProjectId: () => 'a', build: () => 1, write, onError })
    await save()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
    const none = createDocumentSaver({ label: 't5', currentProjectId: () => null, build: () => 1, write })
    await none()
    expect(write).toHaveBeenCalledTimes(1)
    // The failure is still recorded for the "Unsaved changes" banner; clear it.
    const { discardPersistenceFailure } = await import('./persistence.js')
    discardPersistenceFailure('t4:a')
  })
})

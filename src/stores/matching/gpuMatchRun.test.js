import { describe, it, expect, vi } from 'vitest'
import { createGpuMatchRun } from './gpuMatchRun.js'

const INIT = {
  ok: true, adapter: 'test gpu', budgetBytes: 2 ** 30, macPerDispatch: 2 ** 33,
  geometry: { tileA: 64, tileB: 64, workgroup: '16×16', microTile: '4×4', kChunk: 16 },
}
const PASS = { pass: true, nA: 10, nB: 10, nCpu: 5, nGpu: 5, common: 5, share: 1, countSlack: 5, gpuMs: 1, cpuMs: 9 }
const FAIL = { ...PASS, pass: false, common: 1, share: 0.2 }

function fakeClient({ init = INIT, gpu } = {}) {
  const calls = []
  const client = {
    begin: vi.fn(async () => init),
    end: vi.fn(async () => ({ uploads: 2, uploadBytes: 8 * 2 ** 20, hits: 3, misses: 0, evictions: 0,
      peakBytes: 8 * 2 ** 20, gpuMs: 50, selectMs: 5 })),
    cpuMatch: vi.fn(async () => ({ matches: [{ ia: 0, ib: 0, dist: 1 }], count: 1, cpu: true })),
    gpuMatch: vi.fn(async (args) => {
      calls.push(args)
      if (gpu) return gpu(args, calls.length)
      return { matches: [], count: 0, ...(args.validate ? { validation: PASS } : {}) }
    }),
  }
  return { client, calls }
}

const D = new Float32Array(16)
const opts = (o = {}) => ({ dim: 16, ratioThreshold: 0.75, crossCheck: true, idA: 'a', idB: 'b', ...o })

describe('createGpuMatchRun', () => {
  it('returns null (and says why) when the GPU is unavailable', async () => {
    const log = vi.fn()
    const { client } = fakeClient({ init: { ok: false, reason: 'no WebGPU adapter' } })
    expect(await createGpuMatchRun({ client, log, cacheBudgetBytes: 2 ** 30 })).toBeNull()
    expect(log.mock.calls[0][0]).toMatch(/unavailable \(no WebGPU adapter\)/)
    expect(log.mock.calls[0][1]).toBe('warn')
  })

  it('validates the first full match, then sends each image\'s descriptors only once', async () => {
    const log = vi.fn()
    const { client, calls } = fakeClient()
    const run = await createGpuMatchRun({ client, log, cacheBudgetBytes: 2 ** 30, runId: 'r1' })
    await Promise.all([
      run.match(D, D, opts({ idA: 'a', idB: 'b' })),
      run.match(D, D, opts({ idA: 'a', idB: 'c' })),
      run.match(D, D, opts({ idA: 'b', idB: 'c' })),
    ])
    // The validator ran first and alone, with buffers; the waiters followed.
    expect(calls[0]).toMatchObject({ validate: true, idA: 'a', idB: 'b', runId: 'r1' })
    expect(calls[0].descA).toBe(D)
    expect(calls[1]).toMatchObject({ validate: false, idA: 'a', idB: 'c', descA: null })
    expect(calls[1].descB).toBe(D) // c not yet uploaded
    expect(log.mock.calls.some(([m]) => /GPU validate \(full match.*PASS/.test(m))).toBe(true)
    const rec = await run.finish()
    expect(rec).toMatchObject({ backend: 'gpu', fallbacks: 0, gpuMatches: { full: 3, gate: 0 } })
    expect(client.end).toHaveBeenCalledWith({ runId: 'r1' })
  })

  it('resends with buffers when the worker reports a cache miss', async () => {
    const { client, calls } = fakeClient({
      gpu: (args, n) => (n === 3 ? { needs: ['a'] }
        : { matches: [], count: 0, ...(args.validate ? { validation: PASS } : {}) }),
    })
    const run = await createGpuMatchRun({ client, log: vi.fn(), cacheBudgetBytes: 2 ** 30 })
    await run.match(D, D, opts())
    await run.match(D, D, opts())
    expect(calls[1]).toMatchObject({ descA: null, descB: null })
    await run.match(D, D, opts()) // miss → resend
    expect(calls[3].descA).toBe(D)
    expect(calls[3].descB).toBe(D)
    expect(client.cpuMatch).not.toHaveBeenCalled()
  })

  it('moves the rest of the run to WASM when validation fails', async () => {
    const log = vi.fn()
    const { client, calls } = fakeClient({
      gpu: (args) => (args.validate ? { matches: [], count: 0, validation: FAIL, backend: 'wasm' }
        : { matches: [], count: 0 }),
    })
    const run = await createGpuMatchRun({ client, log, cacheBudgetBytes: 2 ** 30 })
    await Promise.all([run.match(D, D, opts()), run.match(D, D, opts({ idB: 'c' }))])
    expect(calls).toHaveLength(1) // the waiter never touched the GPU
    expect(client.cpuMatch).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.some(([m, l]) => /FAIL/.test(m) && l === 'error')).toBe(true)
    const rec = await run.finish()
    expect(rec.backend).toBe('gpu→wasm')
    expect(rec.disabledReason).toMatch(/disagreement/)
    expect(rec.gpuMatches.full).toBe(0) // the validator's answer came from WASM
  })

  it('falls back per pair on a GPU error and logs only the first', async () => {
    const log = vi.fn()
    const { client } = fakeClient({
      gpu: (args, n) => {
        if (n > 1) throw new Error('device lost')
        return { matches: [], count: 0, validation: PASS }
      },
    })
    const run = await createGpuMatchRun({ client, log, cacheBudgetBytes: 2 ** 30 })
    await run.match(D, D, opts())
    const r2 = await run.match(D, D, opts())
    const r3 = await run.match(D, D, opts())
    expect(r2.cpu && r3.cpu).toBe(true)
    expect(log.mock.calls.filter(([m]) => /GPU error \(device lost\)/.test(m))).toHaveLength(1)
    const rec = await run.finish()
    expect(rec).toMatchObject({ backend: 'gpu→wasm', fallbacks: 2, disabledReason: null, firstError: 'device lost' })
  })

  it('a GPU error on the validating pair disables the GPU for that run', async () => {
    const { client, calls } = fakeClient({ gpu: () => { throw new Error('shader') } })
    const run = await createGpuMatchRun({ client, log: vi.fn(), cacheBudgetBytes: 2 ** 30 })
    await Promise.all([run.match(D, D, opts()), run.match(D, D, opts())])
    expect(calls).toHaveLength(1)
    expect(client.cpuMatch).toHaveBeenCalledTimes(2)
  })

  it('validates subset-gate matches separately and never caches their samples', async () => {
    const { client, calls } = fakeClient()
    const run = await createGpuMatchRun({ client, log: vi.fn(), cacheBudgetBytes: 2 ** 30 })
    await run.match(D, D, opts({ kind: 'gate', idA: null, idB: null }))
    await run.match(D, D, opts({ kind: 'gate', idA: null, idB: null }))
    await run.match(D, D, opts())
    expect(calls.map((c) => c.validate)).toEqual([true, false, true])
    expect(calls[1].descA).toBe(D)
    expect(calls[1].descB).toBe(D)
    expect((await run.finish()).gpuMatches).toEqual({ full: 1, gate: 2 })
  })

  it('does not contact the (terminated) worker when the run was cancelled', async () => {
    const { client } = fakeClient()
    const run = await createGpuMatchRun({ client, log: vi.fn(), cacheBudgetBytes: 2 ** 30 })
    const rec = await run.finish({ cancelled: true })
    expect(client.end).not.toHaveBeenCalled()
    expect(rec.cache).toBeNull()
  })
})

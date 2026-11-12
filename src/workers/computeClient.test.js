import { describe, it, expect, vi, beforeAll } from 'vitest'

// A stand-in Worker: records what the pool does with it, never answers.
const made = []
class FakeWorker {
  constructor() {
    this.dead = false
    this.sent = []
    made.push(this)
  }
  postMessage(msg) {
    this.sent.push(msg)
  }
  terminate() {
    this.dead = true
  }
}

let client
beforeAll(async () => {
  vi.stubGlobal('Worker', FakeWorker)
  client = await import('./computeClient.js')
})

describe('releaseIdleWorkers', () => {
  it('keeps the slots it is told to and gives every other slot a fresh worker', async () => {
    // A job pinned to the GPU match slot creates the pool and stays pending (the fake
    // never answers).
    const job = client.matchGpuBegin({})
    job.catch(() => {})
    const pool = made.slice()
    expect(pool.length).toBe(client.POOL_SIZE)
    if (client.POOL_SIZE === 1) return
    const busy = client.GPU_MATCH_WORKER
    // Replacing the busy slot would cancel its job: refused, nothing terminated.
    expect(client.releaseIdleWorkers({ keep: [busy === 0 ? 1 : 0] })).toBe(false)
    expect(pool.some((w) => w.dead)).toBe(false)
    // Keeping it: every other slot is terminated and replaced, the kept one untouched.
    expect(client.releaseIdleWorkers({ keep: [busy] })).toBe(true)
    pool.forEach((w, i) => expect(w.dead).toBe(i !== busy))
    expect(made.length).toBe(2 * client.POOL_SIZE - 1)
    // Without `keep`, a pending job still blocks the whole release.
    expect(client.releaseIdleWorkers()).toBe(false)
  })

  it('recycles one slot only when nothing is pending on it', () => {
    if (client.POOL_SIZE === 1) return
    const busy = client.GPU_MATCH_WORKER
    const idle = busy === 0 ? 1 : 0
    const dead = () => made.filter((w) => w.dead).length
    const [n0, d0] = [made.length, dead()]
    // The pending GPU job from above still sits on `busy`: refused, nothing changes.
    expect(client.recycleWorker(busy)).toBe(false)
    expect([made.length, dead()]).toEqual([n0, d0])
    // An idle slot: its worker goes, one fresh worker takes its place.
    expect(client.recycleWorker(idle)).toBe(true)
    expect([made.length, dead()]).toEqual([n0 + 1, d0 + 1])
  })
})

describe('a worker whose WebAssembly trapped', () => {
  it('is replaced, its other jobs fail, and the next call goes to a fresh worker', async () => {
    client.terminateAll('reset for this test')
    // Two jobs pinned to the GPU match slot; the first traps.
    const a = client.matchGpuBegin({}).catch((e) => e)
    const b = client.matchGpuBegin({}).catch((e) => e)
    const w = made.at(-client.POOL_SIZE + client.GPU_MATCH_WORKER)
    expect(w.sent).toHaveLength(2)
    w.onmessage({ data: { id: w.sent[0].id, ok: false, error: 'RuntimeError: unreachable', fatal: true } })
    expect((await a).message).toContain('unreachable')
    expect((await b).message).toMatch(/restarted/)
    expect(w.dead).toBe(true)
    // The next call on the slot is posted to a fresh worker.
    client.matchGpuBegin({}).catch(() => {})
    const fresh = made.at(-1)
    expect(fresh).not.toBe(w)
    expect(fresh.sent).toHaveLength(1)
  })
})

describe('cancelRun', () => {
  it('resets only the workers running the run, and rejects its jobs as a cancel', async () => {
    client.terminateAll('reset for this test')
    if (client.POOL_SIZE === 1) return
    // A run job pinned to slot 0, and background work (a DEM window for the map) beside it.
    const run = client.matchGpuBegin({}).catch((e) => e)
    const pool = made.slice(-client.POOL_SIZE)
    let bgDone = false
    client.readDemWindow({}).then(
      () => (bgDone = true),
      () => (bgDone = 'rejected'),
    )
    const bgWorker = pool.find((w) => w.sent.some((m) => m.op === 'readDemWindow'))
    expect(bgWorker).not.toBe(pool[client.GPU_MATCH_WORKER])
    expect(client.cancelRun('matching cancelled')).toBe(1)
    const err = await run
    expect(err.name).toBe('AbortError')
    expect(client.isAbort(err)).toBe(true)
    expect(pool[client.GPU_MATCH_WORKER].dead).toBe(true)
    // The background job's worker runs on, its job still pending.
    expect(bgWorker.dead).toBe(false)
    await Promise.resolve()
    expect(bgDone).toBe(false)
  })
})

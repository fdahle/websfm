import { describe, it, expect, vi, beforeAll } from 'vitest'

// A stand-in Worker: records what the pool does with it, never answers.
const made = []
class FakeWorker {
  constructor() {
    this.dead = false
    made.push(this)
  }
  postMessage() {}
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
})

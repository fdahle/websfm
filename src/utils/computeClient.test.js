import { afterEach, describe, expect, it, vi } from 'vitest'

const instances = []

class FakeWorker {
  constructor() {
    this.messages = []
    this.terminated = false
    instances.push(this)
  }

  postMessage(message) {
    // Match the browser boundary closely enough to reject Vue-style Proxies.
    structuredClone(message)
    this.messages.push(message)
  }

  terminate() {
    this.terminated = true
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  instances.length = 0
})

describe('compute worker crash recovery', () => {
  it('rejects only the failed worker jobs and replaces its pool slot', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 3 })
    vi.stubGlobal('Worker', FakeWorker)
    const client = await import('../workers/computeClient.js')

    const failedJob = client.matchDescriptors(new Float32Array([1]), new Float32Array([2]))
    const healthyJob = client.matchDescriptors(new Float32Array([3]), new Float32Array([4]))
    expect(instances).toHaveLength(2)

    instances[0].onerror({ message: 'worker crashed' })
    await expect(failedJob).rejects.toThrow('worker crashed')
    expect(instances[0].terminated).toBe(true)
    expect(instances).toHaveLength(3)

    const healthyRequest = instances[1].messages[0]
    instances[1].onmessage({
      data: { id: healthyRequest.id, ok: true, result: ['still running'] },
    })
    await expect(healthyJob).resolves.toEqual(['still running'])

    client.terminateAll()
  })

  it('materializes reactive fiducial options before postMessage', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 })
    vi.stubGlobal('Worker', FakeWorker)
    const client = await import('../workers/computeClient.js')
    const reactiveOptions = new Proxy({ family: 'generic', positions: 'corners', tolerance: 0.5 }, {})

    const job = client.detectFiducialSpots('blob:test', reactiveOptions)
    const request = instances[0].messages[0]
    expect(request.args[1]).toEqual({ family: 'generic', positions: 'corners', tolerance: 0.5 })
    expect(request.args[1]).not.toBe(reactiveOptions)
    instances[0].onmessage({ data: { id: request.id, ok: true, result: { accepted: [] } } })
    await expect(job).resolves.toEqual({ accepted: [] })
    client.terminateAll()
  })
})

describe('compute worker dispatch', () => {
  it('sends a call to an idle worker, not the next one in turn while it is busy', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 }) // a pool of 3
    vi.stubGlobal('Worker', FakeWorker)
    const client = await import('../workers/computeClient.js')
    const reply = (w) => {
      const { id } = w.messages.at(-1)
      w.onmessage({ data: { id, ok: true, result: [] } })
    }
    const jobs = [0, 1, 2].map((i) => client.matchDescriptors(new Float32Array([i]), new Float32Array([i])))
    expect(instances.map((w) => w.messages.length)).toEqual([1, 1, 1])
    // Worker 1 finishes; workers 0 and 2 are still busy: the next call goes to worker 1,
    // where round-robin sent it to worker 0, behind that worker's running call.
    reply(instances[1])
    await jobs[1]
    jobs.push(client.matchDescriptors(new Float32Array([3]), new Float32Array([3])))
    expect(instances.map((w) => w.messages.length)).toEqual([1, 2, 1])
    // All equally busy: the first from the round-robin position (now slot 1) takes it.
    jobs.push(client.matchDescriptors(new Float32Array([4]), new Float32Array([4])))
    expect(instances.map((w) => w.messages.length)).toEqual([1, 3, 1])
    client.terminateAll()
    await Promise.allSettled(jobs)
  })
})

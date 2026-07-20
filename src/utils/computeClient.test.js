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

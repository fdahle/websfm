import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../utils/opfs.js', () => ({
  beginDepthPlanes: vi.fn(async () => {}),
  saveDepthPlane: vi.fn(),
  commitDepthIndex: vi.fn(async () => {}),
  loadDepthIndex: vi.fn(async () => null),
}))
const opfs = await import('../../utils/opfs.js')
const { createDepthMapCache } = await import('./depthMapCache.js')
const { setStorageFullHandler } = await import('../../utils/storageFull.js')

const map = (uuid) => ({
  uuid,
  width: 2,
  height: 1,
  K: { fx: 1, fy: 1, cx: 0, cy: 0 },
  R: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  t: [0, 0, 0],
  depth: new Float32Array([1, 2]),
  cost: new Float32Array([0.1, 0.2]),
  rgb: new Uint8Array(6),
})
const cache = () =>
  createDepthMapCache({
    isPersisting: () => true,
    currentProjectId: () => 'p',
    mainSparseCloud: () => null,
    log: () => {},
  })

describe('streamed depth maps', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports the first map it cannot save once, at once, and fails the commit with it', async () => {
    const full = Object.assign(
      new Error('Storage is full: the browser or the disk refused to save project data. (b.depth.bin)'),
      { storageFull: true },
    )
    opfs.saveDepthPlane.mockImplementation(async (_p, uuid) => {
      if (uuid !== 'a') throw full
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const failures = []
    const run = await cache().beginStreamedDepthMaps({ onWriteFailure: (e) => failures.push(e) })
    run.add(map('a'))
    run.add(map('b'))
    run.add(map('c'))
    await new Promise((r) => setTimeout(r, 0))
    // Called as the write fails, not when the stage finally awaits its writes.
    expect(failures).toEqual([full])
    await expect(run.settled()).rejects.toBe(full)
    await expect(run.commit({})).rejects.toBe(full)
    expect(opfs.commitDepthIndex).not.toHaveBeenCalled()
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('waits while the project moves to a folder, then saves there and commits', async () => {
    const full = Object.assign(new Error('Storage is full'), { storageFull: true })
    let moved = false
    opfs.saveDepthPlane.mockImplementation(async (_p, uuid) => {
      if (uuid !== 'a' && !moved) throw full
    })
    const handler = vi.fn(async () => (moved = true))
    setStorageFullHandler(handler)
    try {
      const onWriteFailure = vi.fn()
      const run = await cache().beginStreamedDepthMaps({ onWriteFailure })
      run.add(map('a'))
      run.add(map('b'))
      run.add(map('c'))
      await run.commit({})
      expect(handler).toHaveBeenCalledTimes(1) // one question for the run
      expect(onWriteFailure).not.toHaveBeenCalled()
      expect(opfs.saveDepthPlane).toHaveBeenCalledTimes(5) // b and c twice
      expect(opfs.commitDepthIndex).toHaveBeenCalledTimes(1)
    } finally {
      setStorageFullHandler(null)
    }
  })

  it('commits the index when every map was saved', async () => {
    opfs.saveDepthPlane.mockResolvedValue(undefined)
    const onWriteFailure = vi.fn()
    const c = cache()
    const run = await c.beginStreamedDepthMaps({ onWriteFailure })
    run.add(map('a'))
    run.add(map('b'))
    await run.commit({})
    expect(onWriteFailure).not.toHaveBeenCalled()
    expect(opfs.commitDepthIndex).toHaveBeenCalledTimes(1)
    expect(opfs.commitDepthIndex.mock.calls[0][1].maps.map((m) => m.uuid)).toEqual(['a', 'b'])
    expect(c.depthMapsMeta.value.length).toBe(2)
  })
})

describe('forgetDepthMap (an image removed)', () => {
  beforeEach(() => vi.clearAllMocks())

  it("drops only that image's map, in memory and in the saved index", async () => {
    const c = cache()
    c.depthMapsMeta.value = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }]
    c.depthMaps.value = new Map([
      ['a', map('a')],
      ['b', map('b')],
    ])
    opfs.loadDepthIndex.mockResolvedValue({ version: 3, maps: [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }] })
    await c.forgetDepthMap('b')
    expect(c.depthMapsMeta.value.map((m) => m.uuid)).toEqual(['a', 'c'])
    expect([...c.depthMaps.value.keys()]).toEqual(['a'])
    expect(opfs.commitDepthIndex).toHaveBeenCalledWith('p', { version: 3, maps: [{ uuid: 'a' }, { uuid: 'c' }] })
  })

  it('leaves the index alone for an image without a map', async () => {
    const c = cache()
    c.depthMapsMeta.value = [{ uuid: 'a' }]
    await c.forgetDepthMap('x')
    expect(c.depthMapsMeta.value).toEqual([{ uuid: 'a' }])
    expect(opfs.commitDepthIndex).not.toHaveBeenCalled()
  })
})

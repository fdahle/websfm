import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('../../utils/opfs.js', () => ({
  loadLodFile: vi.fn(async () => {
    const e = new Error('not found')
    e.name = 'NotFoundError'
    throw e
  }),
}))
vi.mock('../../workers/computeClient.js', () => ({}))

const { createCloudLod } = await import('./cloudLod.js')

const lod = { dataFile: 'c-a.lod', hierarchyFile: 'c-a.hier', points: 2 }
function setup(cloud) {
  const clouds = ref([cloud])
  const log = vi.fn()
  const store = createCloudLod({
    clouds,
    log,
    save: vi.fn(),
    projectId: () => 'p1',
    makeCloudId: () => 'x',
    selectedCloudId: ref(null),
  })
  return { clouds, log, store }
}

describe('openCloudLod with unreadable octree files', () => {
  it('drops the octree of a resident cloud so it is drawn whole and rebuilt', async () => {
    const { clouds, log, store } = setup({
      id: 'c',
      name: 'Big',
      kind: 'dense',
      count: 2,
      pos: new Float32Array(6),
      lod,
    })
    expect(await store.openCloudLod(clouds.value[0])).toBe(null)
    expect('lod' in clouds.value[0]).toBe(false)
    expect(clouds.value[0].id).toBe('c')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be read'), 'warn', 'Products')
  })

  it('keeps the octree of a streamed cloud, which has nothing else', async () => {
    const { clouds, store } = setup({ id: 'c', name: 'Big', kind: 'dense', count: 2, pos: null, streamed: true, lod })
    expect(await store.openCloudLod(clouds.value[0])).toBe(null)
    expect(clouds.value[0].lod).toEqual(lod)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

const editCalls = []
vi.mock('../../workers/computeClient.js', () => ({
  editCloud: async (input) => {
    editCalls.push(input)
    const src = input.clouds[0]
    return { cloud: { count: src.count, pos: src.pos }, extra: { rms: 0 } }
  },
  optimizeSparse: async () => ({}),
}))
const { createCloudEdits } = await import('./cloudEdits.js')

describe('replaceDerivedCloud', () => {
  it('keeps the identity but not the octree of the old points', () => {
    const old = {
      id: 'd1',
      name: 'Mine',
      kind: 'dense',
      derived: true,
      createdAt: 1,
      count: 2,
      style: { field: 'elevation' },
      pos: new Float32Array(6),
      attributes: { classification: new Uint8Array(2) },
      lod: { dataFile: 'd1-a.lod', hierarchyFile: 'd1-a.hier', points: 2, cloudCreatedAt: 1 },
    }
    const clouds = ref([old])
    const { replaceDerivedCloud } = createCloudEdits({ clouds, selectedCloudId: ref(null) })
    const flat = { count: 2, pos: new Float32Array(6), attributes: { classification: Uint8Array.from([2, 6]) } }
    const next = replaceDerivedCloud(old, flat)
    expect(next.id).toBe('d1')
    expect(next.style).toEqual({ field: 'elevation' })
    expect('lod' in next).toBe(false)
    expect(next.createdAt).not.toBe(1)
    expect(next.col).toBe(null) // a colourless result (markRaw(null) would throw)
    expect(clouds.value[0]).toStrictEqual(next)
  })
})

describe('an alignment against a streamed reference', () => {
  it('reads the reference around the source, and aligns to that', async () => {
    const source = { id: 's', name: 'Dense', kind: 'dense', count: 2, pos: Float32Array.from([0, 0, 0, 10, 20, 5]) }
    const survey = { id: 'r', name: 'LiDAR', kind: 'dense', count: 9e7, pos: null, lod: { points: 9e7 } }
    const clouds = ref([source, survey])
    const asked = []
    const extractCloudPoints = async (cloud, opts) => {
      asked.push({ cloud, opts })
      return {
        cloud: { count: 3, pos: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), col: null, attributes: {} },
        plan: { complete: true, spacing: 0.1 },
      }
    }
    const logs = []
    const { editClouds } = createCloudEdits({
      clouds,
      selectedCloudId: ref(null),
      reconStatus: ref('idle'),
      log: (m, l) => logs.push([m, l]),
      makeCloudId: () => 'new',
      save: async () => {},
      extractCloudPoints,
    })
    editCalls.length = 0
    await editClouds({ mode: 'icp', sourceIds: ['s', 'r'], settings: { maxDistance: 2 } })
    // The box: the source's extent grown by the search radius.
    expect(asked[0].cloud.id).toBe(survey.id)
    expect(asked[0].opts.box).toEqual({ min: [-2, -2, -2], max: [12, 22, 7] })
    expect(editCalls[0].clouds[1].count).toBe(3)
    expect(logs.some(([m]) => /read 3 points of the streamed reference "LiDAR"/.test(m))).toBe(true)
  })
})

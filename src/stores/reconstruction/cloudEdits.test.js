import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { createCloudEdits } from './cloudEdits.js'

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

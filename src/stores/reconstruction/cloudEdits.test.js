import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

const editCalls = []
vi.mock('../../workers/computeClient.js', () => ({
  editCloud: async (input) => {
    editCalls.push(input)
    const src = input.clouds[0]
    return {
      cloud: { count: src.count, pos: src.pos },
      extra: {
        rms: 0,
        transform: {
          scale: 1,
          R: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          t: [1, 2, 3],
        },
      },
    }
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

describe('an alignment of a streamed source', () => {
  it('aligns a sample of it, then moves every point by the streamed Transform', async () => {
    const survey = {
      id: 's',
      name: 'LiDAR',
      kind: 'dense',
      count: 9e7,
      pos: null,
      lod: { points: 9e7, bounds: { min: [0, 0, 0], max: [900, 1000, 50] } },
    }
    const target = { id: 'r', name: 'Dense', kind: 'dense', count: 2, pos: Float32Array.from([0, 0, 0, 10, 20, 5]) }
    const clouds = ref([survey, target])
    const asked = []
    const extractCloudPoints = async (cloud, opts) => {
      asked.push({ cloud, opts })
      return {
        cloud: { count: 3, pos: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), col: null, attributes: {} },
        plan: { complete: false, spacing: 0.5 },
      }
    }
    const streamedEdits = []
    const editStreamedCloud = async (source, edit) => {
      streamedEdits.push({ source, edit })
      return { id: 'moved', name: edit.name, kind: 'dense', count: source.count, pos: null, lod: {} }
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
      editStreamedCloud,
    })
    editCalls.length = 0
    const out = await editClouds({ mode: 'icp', sourceIds: ['s', 'r'], settings: { maxDistance: 0 }, name: 'aligned' })
    expect(asked[0].cloud.id).toBe('s')
    expect(asked[0].opts.maxPoints).toBe(2_000_000)
    // The sample is aligned, with the whole cloud's automatic radius (10× its spacing).
    expect(editCalls[0].clouds[0].count).toBe(3)
    expect(editCalls[0].settings.maxDistance).toBeCloseTo(10 * Math.cbrt((900 * 1000 * 50) / 9e7))
    expect(streamedEdits[0].source.id).toBe('s')
    expect(streamedEdits[0].edit).toEqual({
      mode: 'transform',
      settings: {
        transform: {
          scale: 1,
          R: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          t: [1, 2, 3],
        },
      },
      name: 'aligned',
    })
    expect(out.id).toBe('moved')
    expect(clouds.value[0].visible).toBe(false)
  })
})

describe('undo and redo of point edits', () => {
  const setup = (cloud) => {
    const clouds = ref([cloud])
    const logs = []
    let saves = 0
    const edits = createCloudEdits({
      clouds,
      selectedCloudId: ref(null),
      reconStatus: ref('idle'),
      log: (m, l, s, o) => logs.push([m, l, o?.command ?? null]),
      makeCloudId: () => 'copy',
      save: async () => void saves++,
    })
    return { clouds, logs, edits, saves: () => saves }
  }
  const mask = (n) => ({ mask: new Uint8Array(n).fill(1), keepSelected: false })

  it('puts a working copy’s points back, and the edit again', async () => {
    const pos = Float32Array.from([0, 0, 0, 1, 1, 1])
    const { clouds, logs, edits } = setup({ id: 'd', name: 'Mine', kind: 'dense', derived: true, count: 2, pos })
    await edits.editClouds({ mode: 'mask', sourceIds: ['d'], settings: mask(2) })
    const edited = clouds.value[0].pos
    expect(edited).not.toBe(pos)
    expect(edits.cloudHistory.value).toEqual({ undo: 'delete the selected points', redo: null })

    await edits.undoCloudEdit()
    expect(clouds.value).toHaveLength(1)
    expect(clouds.value[0].pos).toBe(pos)
    expect(edits.cloudHistory.value).toEqual({ undo: null, redo: 'delete the selected points' })
    expect(logs.at(-1)).toEqual([expect.stringMatching(/^Undid: delete the selected points/), 'info', 'cloud undo'])

    await edits.redoCloudEdit()
    expect(clouds.value[0].pos).toBe(edited)
    expect(edits.cloudHistory.value).toEqual({ undo: 'delete the selected points', redo: null })
  })

  it('removes the copy a first edit made and shows the source, and brings the copy back', async () => {
    const source = { id: 'c', name: 'Dense', kind: 'dense', count: 2, pos: new Float32Array(6), visible: true }
    const { clouds, edits } = setup(source)
    await edits.editClouds({ mode: 'mask', sourceIds: ['c'], settings: mask(2) })
    expect(clouds.value.map((c) => [c.id, c.visible !== false])).toEqual([
      ['c', false],
      ['copy', true],
    ])
    await edits.undoCloudEdit()
    expect(clouds.value.map((c) => [c.id, c.visible !== false])).toEqual([['c', true]])
    await edits.redoCloudEdit()
    expect(clouds.value.map((c) => [c.id, c.visible !== false])).toEqual([
      ['c', false],
      ['copy', true],
    ])
  })

  it('has nothing to undo once the cloud is removed', async () => {
    const { clouds, edits } = setup({
      id: 'd',
      name: 'Mine',
      kind: 'dense',
      derived: true,
      count: 2,
      pos: new Float32Array(6),
    })
    await edits.editClouds({ mode: 'mask', sourceIds: ['d'], settings: mask(2) })
    clouds.value = []
    await Promise.resolve()
    await new Promise((r) => setTimeout(r))
    expect(edits.cloudHistory.value).toEqual({ undo: null, redo: null })
    expect(await edits.undoCloudEdit()).toBeNull()
  })
})

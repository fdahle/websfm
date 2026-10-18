import { describe, expect, it, vi } from 'vitest'
import { createProductRuns } from './productRuns.js'

vi.mock('../../workers/computeClient.js', () => ({ generateDem: vi.fn(), generateOrtho: vi.fn() }))

// orthoSurfacePayload for the plane and mesh surfaces: the fit sample from whatever
// cloud demSource offers, including a streamed one (pos: null, read from its octree).
function setup({ source = null, mesh = null, extract = null } = {}) {
  const log = vi.fn()
  const runs = createProductRuns({
    activeRegion: () => null, dem: { value: null }, demSource: { value: source },
    depthMapInput: vi.fn(), effectiveFrameSpec: vi.fn(), frameModelFor: { value: () => ({}) },
    frameStampOf: () => 's', groundSource: { value: null }, images: { value: [] }, imagesStore: {},
    isPersisting: () => false, log, mainSparseCloud: { value: null }, meshCloud: { value: mesh },
    ortho: { value: null },
    orthoSurfaces: { value: [{ id: 'plane', available: true }, { id: 'mesh', available: !!mesh }] },
    projects: { currentProjectId: 'p' }, reconStatus: { value: 'idle' }, saveProductRecord: vi.fn(),
    sparseCameras: { value: new Map() }, withPreviewUrl: (r) => r, extractCloudPoints: extract,
  })
  return { runs, log }
}
const local = { source: 'local', frameSpec: { kind: 'local' } }
const flatCloud = (n) => ({ count: n, pos: Float64Array.from({ length: 3 * n }, (_, i) => i) })

describe('orthoSurfacePayload fit sample', () => {
  it('reads a streamed cloud\'s sample from its octree', async () => {
    const cloud = { kind: 'dense', pos: null, lod: { dataFile: 'a', hierarchyFile: 'b' }, count: 5_000_000 }
    const extract = vi.fn(async () => ({ cloud: flatCloud(1000) }))
    const { runs } = setup({ source: { cloud, kind: 'dense', count: cloud.count }, extract })
    const p = await runs.orthoSurfacePayload({ surface: 'plane' }, local)
    expect(extract).toHaveBeenCalledWith(cloud, expect.objectContaining({ fields: 'xyz', maxPoints: 200_000 }))
    expect(p).toMatchObject({ kind: 'plane', count: 1000, framePointCount: 1000 })
    expect([...p.pos.subarray(0, 3)]).toEqual([0, 1, 2])
  })

  it('samples a resident cloud by stride', async () => {
    const cloud = { kind: 'dense', ...flatCloud(10) }
    const { runs } = setup({ source: { cloud, kind: 'dense', count: 10 } })
    const p = await runs.orthoSurfacePayload({ surface: 'plane' }, local)
    expect(p.count).toBe(10)
  })

  it('refuses a plane with no cloud, and places a mesh frame on its own vertices', async () => {
    const mesh = { name: 'm', count: 1, nVerts: 3, pos: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), idx: Uint32Array.of(0, 1, 2) }
    const { runs, log } = setup({ mesh })
    expect(await runs.orthoSurfacePayload({ surface: 'plane' }, local)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/needs a point cloud/), 'warn', 'Products')
    const p = await runs.orthoSurfacePayload({ surface: 'mesh' }, local)
    expect(p).toMatchObject({ kind: 'mesh', framePointCount: 3 })
  })

  it('reports a failed octree read instead of throwing', async () => {
    const cloud = { kind: 'dense', pos: null, lod: {}, count: 9 }
    const { runs, log } = setup({ source: { cloud, kind: 'dense', count: 9 }, extract: vi.fn(async () => { throw new Error('gone') }) })
    expect(await runs.orthoSurfacePayload({ surface: 'plane' }, local)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/streamed cloud failed — gone/), 'error', 'Products')
  })
})

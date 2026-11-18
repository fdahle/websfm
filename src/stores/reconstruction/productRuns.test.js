import { describe, expect, it, vi } from 'vitest'
import { createProductRuns } from './productRuns.js'
import { generateDem as workerGenerateDem } from '../../workers/computeClient.js'

vi.mock('../../workers/computeClient.js', () => ({
  generateDem: vi.fn(),
  generateOrtho: vi.fn(),
  releaseIdleWorkers: vi.fn(() => true),
  isAbort: (err) => err?.name === 'AbortError',
}))

// orthoSurfacePayload for the plane and mesh surfaces: the fit sample from whatever
// cloud demSource offers, including a streamed one (pos: null, read from its octree).
function setup({ source = null, mesh = null, extract = null, overrides = {} } = {}) {
  const log = vi.fn()
  const runs = createProductRuns({
    activeRegion: () => null,
    dem: { value: null },
    demSource: { value: source },
    depthMapInput: vi.fn(),
    effectiveFrameSpec: vi.fn(),
    frameModelFor: { value: () => ({}) },
    frameStampOf: () => 's',
    groundSource: { value: null },
    images: { value: [] },
    imagesStore: {},
    isPersisting: () => false,
    log,
    mainSparseCloud: { value: null },
    meshCloud: { value: mesh },
    ortho: { value: null },
    orthoSurfaces: {
      value: [
        { id: 'plane', available: true },
        { id: 'mesh', available: !!mesh },
      ],
    },
    projects: { currentProjectId: 'p' },
    reconStatus: { value: 'idle' },
    saveProductRecord: vi.fn(),
    sparseCameras: { value: new Map() },
    withPreviewUrl: (r) => r,
    extractCloudPoints: extract,
    ...overrides,
  })
  return { runs, log }
}
const local = { source: 'local', frameSpec: { kind: 'local' } }
const flatCloud = (n) => ({ count: n, pos: Float64Array.from({ length: 3 * n }, (_, i) => i) })

describe('orthoSurfacePayload fit sample', () => {
  it("reads a streamed cloud's sample from its octree", async () => {
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
    const mesh = {
      name: 'm',
      count: 1,
      nVerts: 3,
      pos: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      idx: Uint32Array.of(0, 1, 2),
    }
    const { runs, log } = setup({ mesh })
    expect(await runs.orthoSurfacePayload({ surface: 'plane' }, local)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/needs a point cloud/), 'warn', 'Products')
    const p = await runs.orthoSurfacePayload({ surface: 'mesh' }, local)
    expect(p).toMatchObject({ kind: 'mesh', framePointCount: 3 })
  })

  it('reports a failed octree read instead of throwing', async () => {
    const cloud = { kind: 'dense', pos: null, lod: {}, count: 9 }
    const { runs, log } = setup({
      source: { cloud, kind: 'dense', count: 9 },
      extract: vi.fn(async () => {
        throw new Error('gone')
      }),
    })
    expect(await runs.orthoSurfacePayload({ surface: 'plane' }, local)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/streamed cloud failed: gone/), 'error', 'Products')
  })
})

describe('the raster size before the run', () => {
  // 400 k points over a 1,000 × 500 site plus a thin far fringe the Dense core leaves out.
  function siteCloud() {
    const n = 400_000,
      pos = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      const far = i % 200 === 0
      pos[i * 3] = far ? 3000 + (i % 977) : ((i * 7919) % 100_000) / 100
      pos[i * 3 + 1] = far ? -2000 : ((i * 104_729) % 50_000) / 100
      pos[i * 3 + 2] = (i % 13) * 0.1
    }
    return { kind: 'dense', count: n, pos }
  }
  const similarity = {
    source: 'georef',
    unit: 'm',
    frameSpec: {
      kind: 'similarity',
      scale: 1,
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [0, 0, 0],
      crs: 'EPSG:32632',
      unit: 'm',
    },
  }

  it('estimates the DEM the worker grids from every point', async () => {
    const cloud = siteCloud()
    const runsFrame = createProductRuns({ ...runsDeps(cloud), effectiveFrameSpec: async () => similarity })
    const est = await runsFrame.estimateRasterSize('dem', { crs: 'local', extent: 'core' })
    // The worker: every point, its core extent, demGeometry over the points inside.
    const { coreExtent, demGeometry } = await import('../../core/products/dem.js')
    const { pointView } = await import('../../core/products/pointView.ts')
    const bounds = coreExtent(cloud.pos, cloud.count)
    const run = demGeometry(pointView(cloud), { bounds })
    expect(est.approx).toBe(true)
    expect(Math.abs(est.width - run.width) / run.width).toBeLessThan(0.02)
    expect(Math.abs(est.height - run.height) / run.height).toBeLessThan(0.02)
    expect(est.gsd).toBeCloseTo(run.gsd, 1)
  })

  it('is exact for an ortho over the DEM, and waits for a georeference it would have to fit', async () => {
    const dem = { width: 3000, height: 2000, gsd: 0.5, originX: 0, originY: 0, unit: 'm' }
    const runs = createProductRuns({
      ...runsDeps(null),
      dem: { value: dem },
      effectiveFrameSpec: async () => similarity,
      validGeoref: { value: null },
      projects: { currentProjectId: 'p', currentCrs: 'EPSG:32632' },
    })
    expect(await runs.estimateRasterSize('ortho', { surface: 'dem', longSide: 6000 })).toMatchObject({
      width: 6000,
      height: 4001,
      approx: false,
    }) // cells = ceil(span / gsd) + 1
    expect(await runs.estimateRasterSize('dem', { crs: 'project' })).toEqual({
      unavailable: 'shown once the georeference is fitted',
    })
  })
})

function runsDeps(cloud) {
  return {
    activeRegion: () => null,
    dem: { value: null },
    demSource: { value: cloud && { cloud, kind: 'dense', count: cloud.count } },
    depthMapInput: vi.fn(),
    effectiveFrameSpec: vi.fn(),
    frameModelFor: { value: () => ({}) },
    frameStampOf: () => 's',
    groundSource: { value: null },
    images: { value: [] },
    imagesStore: {},
    isPersisting: () => false,
    log: vi.fn(),
    mainSparseCloud: { value: null },
    meshCloud: { value: null },
    ortho: { value: null },
    orthoSurfaces: { value: [] },
    projects: { currentProjectId: 'p' },
    reconStatus: { value: 'idle' },
    saveProductRecord: vi.fn(),
    sparseCameras: { value: new Map() },
    withPreviewUrl: (r) => r,
    extractCloudPoints: null,
  }
}

// The closing line names the raster as built: a tiled DEM's record holds a preview
// overview in width/height/gsd and its full size in fullWidth/fullHeight/fullGsd.
describe('the DEM closing line', () => {
  it('gives the full raster size, not the overview', async () => {
    workerGenerateDem.mockResolvedValueOnce({
      width: 1055,
      height: 2499,
      gsd: 0.0093,
      fullWidth: 2111,
      fullHeight: 4998,
      fullGsd: 0.00465,
      unit: 'model',
    })
    const { runs, log } = setup({
      source: { cloud: { ...flatCloud(30), kind: 'dense' }, kind: 'dense', count: 30, name: 'Dense cloud' },
      overrides: {
        effectiveFrameSpec: vi.fn(async () => local),
        putRasterProduct: (r) => ({ ...r, name: 'DEM' }),
      },
    })
    await runs.generateDem({})
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^DEM "DEM": 2,111 × 4,998 cells at 0\.00465 model units in [\d.]+ s$/),
      'success',
      'Products',
    )
  })
})

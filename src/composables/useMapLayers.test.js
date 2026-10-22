import { describe, it, expect, vi, beforeEach } from 'vitest'
import ImageLayer from 'ol/layer/Image'
import { get as getOlProjection } from 'ol/proj'

// The reconcile logic of the map's raster layers: diffing against the list,
// stacking order, and — the part a rebuild leans on — that a sync resuming after
// an await never commits once a newer sync or a teardown has happened.

const ensureProjection = vi.fn(() => Promise.resolve())
vi.mock('../core/crs.js', async (orig) => ({ ...(await orig()), ensureProjection: (...a) => ensureProjection(...a) }))
vi.mock('../stores/useExternalStore.js', () => ({ useExternalStore: () => ({ displayFile: vi.fn(async () => null) }) }))
const disposed = []
const gpuBuilt = []
// Set to a promise to park the next GPU layer build until it resolves.
const gpuGate = { wait: null, entered: null }
vi.mock('../components/viewers/raster/gpuRaster.js', () => ({
  gpuRasterStyle: (r) => ({ styleOf: r.id }),
  disposeRasterLayer: (layer) => {
    if (layer) disposed.push(layer)
  },
  createGpuRasterLayer: async (r) => {
    gpuGate.entered?.()
    if (gpuGate.wait) await gpuGate.wait
    // A real layer (a LayerGroup only takes real ones), dressed as the GPU kind.
    const layer = new ImageLayer({ opacity: r.opacity ?? 1 })
    layer.set('gpuRaster', true)
    layer.setStyle = vi.fn()
    gpuBuilt.push(layer)
    return layer
  },
}))

const { useMapLayers } = await import('./useMapLayers.js')

const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// A preview-drawn raster (photometric 3 = not the tiled display path).
const preview = (id, extra = {}) => ({
  id,
  crs: 'EPSG:4326',
  width: 10,
  height: 10,
  photometric: 3,
  previewDataUrl: `data:${id}`,
  geoTransform: { originX: 0, originY: 10, scaleX: 1, scaleY: -1 },
  ...extra,
})

function setup(list) {
  const state = { rasters: list }
  const ctx = { map: { getView: () => ({ getProjection: () => getOlProjection('EPSG:4326') }) } }
  const r = useMapLayers(ctx, { layers: () => state.rasters, modelCode: () => undefined })
  const group = r.createGroup()
  const ids = () =>
    group
      .getLayers()
      .getArray()
      .map((l) => l.get('previewUrl') ?? 'gpu')
  return { ...r, ctx, state, group, ids }
}

beforeEach(() => {
  disposed.length = 0
  gpuBuilt.length = 0
  gpuGate.wait = null
  gpuGate.entered = null
  ensureProjection.mockReset()
  ensureProjection.mockImplementation(() => Promise.resolve())
})

describe('useMapLayers', () => {
  it('draws the list in order and restacks when it is reordered', async () => {
    const s = setup([preview('a'), preview('b')])
    await s.sync()
    expect(s.ids()).toEqual(['data:a', 'data:b'])
    const [la, lb] = s.group.getLayers().getArray()
    s.state.rasters = [s.state.rasters[1], s.state.rasters[0]]
    await s.sync()
    expect(s.ids()).toEqual(['data:b', 'data:a'])
    // Same layer objects: a restack is not a rebuild.
    expect(s.group.getLayers().getArray()).toEqual([lb, la])
    expect(disposed).toEqual([])
  })

  it('follows opacity in place, rebuilds on a new preview, disposes what left the list', async () => {
    const a = preview('a'),
      b = preview('b')
    const s = setup([a, b])
    await s.sync()
    const [la, lb] = s.group.getLayers().getArray()
    a.opacity = 0.4
    await s.sync()
    expect(s.group.getLayers().item(0)).toBe(la)
    expect(la.getOpacity()).toBe(0.4)

    a.previewDataUrl = 'data:a-restyled'
    await s.sync()
    expect(disposed).toEqual([la])
    expect(s.ids()).toEqual(['data:a-restyled', 'data:b'])

    s.state.rasters = [a]
    await s.sync()
    expect(disposed).toContain(lb)
    expect(s.ids()).toEqual(['data:a-restyled'])
  })

  it('restyles a GPU layer in place while it draws the same file; a new fileKey rebuilds it', async () => {
    const ortho = { ...preview('o'), product: true, cog: {}, fileKey: 'k1' }
    const s = setup([ortho])
    await s.sync()
    expect(gpuBuilt).toHaveLength(1)
    const layer = gpuBuilt[0]
    expect(layer.get('fileKey')).toBe('k1')
    await s.sync()
    expect(layer.setStyle).toHaveBeenCalledWith({ styleOf: 'o' })
    expect(gpuBuilt).toHaveLength(1)
    ortho.fileKey = 'k2'
    await s.sync()
    expect(disposed).toEqual([layer])
    expect(gpuBuilt).toHaveLength(2)
  })

  it('only the newest of two overlapping syncs commits', async () => {
    const wait = deferred()
    ensureProjection.mockImplementationOnce(() => wait.promise)
    const s = setup([preview('a')])
    const first = s.sync() // parked on the projection lookup
    s.state.rasters = [preview('b')]
    await s.sync()
    wait.resolve()
    await first
    expect(s.ids()).toEqual(['data:b'])
  })

  it('a sync parked across dispose() (map teardown) commits nothing', async () => {
    const wait = deferred()
    ensureProjection.mockImplementationOnce(() => wait.promise)
    const s = setup([preview('a')])
    const pending = s.sync()
    s.dispose()
    wait.resolve()
    await pending
    expect(s.group.getLayers().getLength()).toBe(0)
  })

  it('a sync abandons once the map is gone, and disposes a layer it had just made', async () => {
    const ortho = { ...preview('o'), product: true, cog: {}, fileKey: 'k1' }
    const s = setup([ortho])
    const gate = deferred(),
      entered = deferred()
    gpuGate.wait = gate.promise
    gpuGate.entered = entered.resolve
    const pending = s.sync()
    // Past the projection check, while the layer build is in flight.
    await entered.promise
    s.ctx.map = null
    gate.resolve()
    await pending
    expect(gpuBuilt).toHaveLength(1)
    expect(disposed).toEqual(gpuBuilt)
    expect(s.group.getLayers().getLength()).toBe(0)
  })

  it('does nothing without a map or before createGroup()', async () => {
    const ctx = { map: null }
    const r = useMapLayers(ctx, { layers: () => [preview('a')], modelCode: () => undefined })
    const group = r.createGroup()
    await r.sync()
    expect(group.getLayers().getLength()).toBe(0)
    ctx.map = {}
    r.dispose() // drops the group
    await r.sync()
    expect(ensureProjection).not.toHaveBeenCalled()
  })

  it('never looks the model frame code up remotely', async () => {
    const s = setup([])
    const r = useMapLayers(s.ctx, {
      layers: () => [preview('a', { crs: 'MODEL:1' })],
      modelCode: () => 'MODEL:1',
    })
    r.createGroup()
    await r.sync()
    expect(ensureProjection).not.toHaveBeenCalled()
  })

  it('reports raster extents in the view projection, skipping unknown CRSs', () => {
    const s = setup([preview('a'), preview('x', { crs: 'EPSG:999999' })])
    expect(s.extents()).toEqual([[0, 0, 10, 10]])
    s.ctx.map = null
    expect(s.extents()).toEqual([])
  })
  it('stacks a vector layer with the rasters, and swaps its features only on a new rev', async () => {
    const ring = [
      [2, 2],
      [4, 2],
      [4, 4],
    ]
    const vec = { id: 'vector:v', vector: true, opacity: 1, rev: '1:0', features: () => [{ id: 'p', rings: [ring] }] }
    const s = setup([preview('a'), vec])
    await s.sync()
    const [, lv] = s.group.getLayers().getArray()
    expect(lv.get('vector')).toBe(true)
    expect(lv.getSource().getFeatures()).toHaveLength(1)
    const first = lv.getSource().getFeatures()[0]

    vec.opacity = 0.3
    await s.sync()
    expect(s.group.getLayers().item(1)).toBe(lv)
    expect(lv.getOpacity()).toBe(0.3)
    expect(lv.getSource().getFeatures()[0]).toBe(first)

    vec.rev = '2:0'
    await s.sync()
    expect(lv.getSource().getFeatures()[0]).not.toBe(first)
    expect(s.extents()).toEqual([
      [0, 0, 10, 10],
      [2, 2, 4, 4],
    ])
  })
})

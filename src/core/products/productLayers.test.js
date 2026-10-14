import { it, expect } from 'vitest'
import { normalizeProductLayers, productMapBlocker, placeProductLayer } from './productLayers.js'
import { MODEL_MAP_CRS } from './modelMap.js'

const basis = { east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1] }
const dem = { width: 4, height: 3, gsd: 2, originX: 100, originY: 50, crs: 'EPSG:32632', previewUrl: 'data:x', name: 'Site DEM' }
const localDem = { ...dem, crs: 'local', frame: { kind: 'local', origin: [10, 20, 5], ...basis } }
const on = { visible: true, opacity: 0.5 }

it('normalises persisted layer state and drops anything malformed', () => {
  expect(normalizeProductLayers(null)).toEqual({})
  expect(normalizeProductLayers({ dem: { visible: true, opacity: 3 }, ortho: { visible: 'yes' }, mesh: { visible: true } }))
    .toEqual({ dem: { visible: true, opacity: 1 }, ortho: { visible: false, opacity: 1 } })
  expect(normalizeProductLayers({ dem: { visible: true, opacity: 0.4 } }).dem.opacity).toBe(0.4)
})

it('never blocks the toggle for the frame, only for a missing preview or geometry', () => {
  expect(productMapBlocker(localDem)).toBeNull()
  expect(productMapBlocker(dem)).toBeNull()
  expect(productMapBlocker({ ...dem, previewUrl: null })).toMatch(/preview/)
  expect(productMapBlocker({ width: 2, height: 2, previewUrl: 'x' })).toMatch(/geometry/)
  expect(productMapBlocker(null)).toMatch(/Build/)
})

it('places a CRS product on the CRS map in its own CRS, and explains a local one', () => {
  expect(placeProductLayer('dem', dem, { visible: false }, { mode: 'crs' })).toBeNull()
  expect(placeProductLayer('dem', localDem, on, { mode: 'crs' }).reason).toMatch(/Model Frame/)
  expect(placeProductLayer('dem', dem, on, { mode: 'crs' }).layer).toEqual({
    id: 'product:dem', product: true, kind: 'dem', name: 'Site DEM', crs: 'EPSG:32632', width: 4, height: 3,
    geoTransform: { originX: 100, originY: 50, scaleX: 2, scaleY: -2 }, previewDataUrl: 'data:x', opacity: 0.5, offset: null,
  })
})

it('translates a local product into the model map by its origin offset', () => {
  const view = { mode: 'model', frame: { origin: [7, 18, 0], ...basis }, stale: new Set() }
  const { layer } = placeProductLayer('dem', localDem, on, view)
  expect(layer.crs).toBe(MODEL_MAP_CRS)
  expect(layer.offset).toEqual([3, 2])
  expect(layer.geoTransform).toMatchObject({ originX: 103, originY: 52 })
  expect(placeProductLayer('dem', dem, on, view).reason).toMatch(/project CRS/)
  expect(placeProductLayer('dem', localDem, on, { ...view, stale: new Set(['dem']) }).reason).toMatch(/older sparse model/)
})

it('draws a computed ortho from its COG, except where a frame offset would misplace the file\'s own tiles', () => {
  const cog = new Blob([])
  const ortho = { ...dem, name: 'Ortho', createdAt: 5, cog }
  const crsLayer = placeProductLayer('ortho', ortho, on, { mode: 'crs' }).layer
  expect(crsLayer).toMatchObject({ cog, fileKey: 'product:ortho:5', bands: 4, alphaBand: 3, photometric: 2 })
  expect(placeProductLayer('dem', { ...dem, cog }, on, { mode: 'crs' }).layer.cog).toBeUndefined()
  const localOrtho = { ...localDem, createdAt: 5, cog }
  const shifted = { mode: 'model', frame: { origin: [7, 18, 0], ...basis }, stale: new Set() }
  expect(placeProductLayer('ortho', localOrtho, on, shifted).layer.cog).toBeUndefined()
  const same = { mode: 'model', frame: { origin: [10, 20, 5], ...basis }, stale: new Set() }
  expect(placeProductLayer('ortho', localOrtho, on, same).layer.cog).toBe(cog)
})

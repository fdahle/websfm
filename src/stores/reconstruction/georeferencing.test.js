import { it, expect, vi } from 'vitest'
import { ref, effectScope } from 'vue'
import { createGeoreferencing } from './georeferencing.js'
const R = [[1,0,0],[0,1,0],[0,0,1]]

it.each(['pose', 'control', 'model', 'camera'])('invalidates a fitted georeference after %s evidence changes', async field => {
  const scope = effectScope()
  const controls = ref([]), model = ref('first')
  const poses = ref([{ imageId: 'a', x: 0, y: 0, z: 0 }, { imageId: 'b', x: 2, y: 0, z: 0 }, { imageId: 'c', x: 0, y: 2, z: 0 }])
  const cameras = ref(new Map([['a', { R, t: [0,0,0] }], ['b', { R, t: [-1,0,0] }], ['c', { R, t: [0,-1,0] }]]))
  const georef = ref(null)
  const api = scope.run(() => createGeoreferencing({ sparseCameras: cameras,
    images: ref(['a','b','c'].map(id => ({ id, uuid: id }))), georef, healthDirty: ref(0),
    poses: () => poses.value, gcps: () => controls.value, currentCrs: () => 'EPSG:3031',
    modelStamp: () => model.value, persist: vi.fn(), log: vi.fn() }))
  // Grid scale 2 at the pole of EPSG:3031, where the point scale factor is
  // k ≈ 0.97277: fitted in the local metric frame the similarity's scale is the
  // GROUND scale 2/k, and the frame travels with it.
  const fitted = await api.georeference()
  expect(fitted.sim.local.k).toBeCloseTo(0.97277, 4)
  expect(fitted.sim.scale).toBeCloseTo(2 / fitted.sim.local.k, 6)
  expect(api.validGeoref.value).not.toBeNull()
  if (field === 'pose') poses.value[1].x = 10
  if (field === 'control') controls.value.push({ id: 'control', x: 1, y: 2, z: 3 })
  if (field === 'model') model.value = 'replacement'
  if (field === 'camera') cameras.value.get('b').t[0] = -2
  expect(georef.value).toBeNull()
  expect(api.poseResidualReport()).toEqual([])
  scope.stop()
})

it('names why a geographic project cannot be georeferenced and suggests a projected CRS', async () => {
  const scope = effectScope()
  const crs = ref('EPSG:4326')
  // EXIF positions in a geographic project CRS: x = lon, y = lat (St Nazaire, zone 31N).
  const poses = ref([
    { imageId: 'a', x: 5.2755, y: 44.5688, z: 518 },
    { imageId: 'b', x: 5.2760, y: 44.5690, z: 519 },
    { imageId: 'c', x: 5.2765, y: 44.5692, z: 520 },
  ])
  const cameras = ref(new Map([['a', { R, t: [0,0,0] }], ['b', { R, t: [-1,0,0] }], ['c', { R, t: [0,-1,0] }]]))
  const log = vi.fn()
  const api = scope.run(() => createGeoreferencing({ sparseCameras: cameras,
    images: ref(['a','b','c'].map(id => ({ id, uuid: id }))), georef: ref(null), healthDirty: ref(0),
    poses: () => poses.value, gcps: () => [], currentCrs: () => crs.value,
    persist: vi.fn(), log }))
  expect(api.canGeoreference.value).toBe(false)
  expect(api.georeferenceBlocker.value).toBe('geographic')
  expect(api.crsSuggestion.value).toMatchObject({ code: 'EPSG:32631', count: 3 })
  expect(await api.georeference()).toBeNull()
  expect(log.mock.calls.at(-1)[0]).toContain('EPSG:32631')

  // A projected CRS with the same three cameras can be fitted; nothing is suggested.
  crs.value = 'EPSG:3031'
  expect(api.georeferenceBlocker.value).toBeNull()
  expect(api.crsSuggestion.value).toBeNull()
  // …and with too few positions the blocker is the evidence, not the CRS.
  poses.value = poses.value.slice(0, 2)
  expect(api.georeferenceBlocker.value).toBe('evidence')
  scope.stop()
})

it('falls back to the images\' EXIF GPS when no positions are materialised yet', () => {
  const scope = effectScope()
  const api = scope.run(() => createGeoreferencing({ sparseCameras: ref(new Map()),
    images: ref([{ id: 'a', uuid: 'a', meta: { gpsLat: -33.9, gpsLon: 18.4 } }]), georef: ref(null),
    healthDirty: ref(0), poses: () => [], gcps: () => [], currentCrs: () => 'EPSG:4326',
    persist: vi.fn(), log: vi.fn() }))
  expect(api.crsSuggestion.value.code).toBe('EPSG:32734')
  scope.stop()
})

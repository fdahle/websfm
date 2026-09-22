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
  expect((await api.georeference()).sim.scale).toBeCloseTo(2)
  expect(api.validGeoref.value).not.toBeNull()
  if (field === 'pose') poses.value[1].x = 10
  if (field === 'control') controls.value.push({ id: 'control', x: 1, y: 2, z: 3 })
  if (field === 'model') model.value = 'replacement'
  if (field === 'camera') cameras.value.get('b').t[0] = -2
  expect(georef.value).toBeNull()
  expect(api.poseResidualReport()).toEqual([])
  scope.stop()
})

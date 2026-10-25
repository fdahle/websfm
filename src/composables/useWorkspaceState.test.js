import { beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useWorkspaceState } from './useWorkspaceState.js'

beforeEach(() => setActivePinia(createPinia()))

// A sensor is incomplete when an assigned image (or, with none, the sensor alone) falls
// back to the default-FOV guess. The verdict is kept per metadata object, so it must
// still follow a sensor edit and a replaced metadata object.
it('flags a sensor whose images have no usable focal, and follows edits', () => {
  const imagesStore = useImagesStore()
  const sensorsStore = useSensorsStore()
  const exif = { width: 4000, height: 3000, focalLength35: 28 }
  const bare = { width: 4000, height: 3000 }
  sensorsStore.sensors = [
    { id: 's1', name: 'A' },
    { id: 's2', name: 'B' },
    { id: 's3', name: 'C (no images)' },
  ]
  imagesStore.images = [
    { id: 'a', sensorId: 's1', meta: exif },
    { id: 'b', sensorId: 's2', meta: bare },
  ]
  const { incompleteSensorIds } = useWorkspaceState()
  expect([...incompleteSensorIds.value].sort()).toEqual(['s2', 's3'])
  // A focal on the sensor completes it.
  Object.assign(sensorsStore.sensors[1], { focal: 3200, focalUnit: 'px' })
  expect([...incompleteSensorIds.value].sort()).toEqual(['s3'])
  // New metadata without a usable focal on s1's image.
  imagesStore.images[0].meta = { ...bare }
  expect([...incompleteSensorIds.value].sort()).toEqual(['s1', 's3'])
})

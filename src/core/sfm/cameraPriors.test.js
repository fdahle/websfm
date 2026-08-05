import { describe, expect, it } from 'vitest'
import { buildCameraPriors } from './cameraPriors.js'

const images = [{ id: 'image-1', uuid: 'uuid-1' }, { id: 'image-2', uuid: 'uuid-2' }]

describe('buildCameraPriors', () => {
  it('passes enabled metric 3D EXIF poses and their per-axis accuracies', () => {
    expect(buildCameraPriors([{
      imageId: 'image-1', x: 10, y: 20, z: 30,
      accuracyX: 1, accuracyY: 2, accuracyZ: 4, source: 'exif', enabled: true,
    }], images, 'EPSG:3857')).toEqual([{
      uuid: 'uuid-1', x: 10, y: 20, z: 30,
      accuracyX: 1, accuracyY: 2, accuracyZ: 4, source: 'exif',
    }])
  })

  it('keeps XY-only, disabled, unmatched, and geographic positions out of BA', () => {
    const poses = [
      { imageId: 'image-1', x: 1, y: 2, z: null, enabled: true },
      { imageId: 'image-2', x: 1, y: 2, z: 3, enabled: false },
      { imageId: 'missing', x: 1, y: 2, z: 3, enabled: true },
    ]
    expect(buildCameraPriors(poses, images, 'EPSG:3857')).toEqual([])
    expect(buildCameraPriors([{ imageId: 'image-1', x: 1, y: 2, z: 3 }], images, 'EPSG:4326'))
      .toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  imageIdsToPairId, pairIdToImageIds, decodeColmapCamera, cameraToWebsfmSensor,
  decodeColmapKeypoints, decodeColmapDescriptors, decodeColmapMatches, decodeColmapMatrix,
  COLMAP_CAMERA_MODELS, COLMAP_MAX_IMAGE_ID,
} from './colmapDatabase.js'

const blob = (Typed, values) => new Uint8Array(new Typed(values).buffer)

describe('COLMAP database adapters', () => {
  it('round-trips pair ids', () => {
    for (const pair of [[1, 2], [2, 99], [1234, 987654], [COLMAP_MAX_IMAGE_ID - 2, COLMAP_MAX_IMAGE_ID - 1]]) {
      expect(pairIdToImageIds(imageIdsToPairId(...pair))).toEqual(pair)
      expect(imageIdsToPairId(pair[1], pair[0])).toBe(imageIdsToPairId(...pair))
    }
  })

  it('decodes every documented camera model with its declared parameter order', () => {
    for (const [id, spec] of Object.entries(COLMAP_CAMERA_MODELS)) {
      const values = spec.names.map((_, i) => i + .5)
      const camera = decodeColmapCamera({ camera_id: 1, model: Number(id), width: 10, height: 8, params: blob(Float64Array, values) })
      expect(camera.model).toBe(spec.model)
      expect(camera.params).toEqual(values)
    }
  })

  it('decodes camera blobs and maps Brown calibration', () => {
    const cam = decodeColmapCamera({ camera_id: 7, model: 4, width: 1000, height: 800, params: blob(Float64Array, [900, 910, 500, 400, .1, -.02, .001, -.001]) })
    expect(cam.model).toBe('OPENCV')
    expect(cameraToWebsfmSensor(cam)).toMatchObject({ focal: 900, fx: 900, fy: 910, cx: 500, k1: .1, distortionModel: 'brown' })
  })

  it('decodes keypoints, descriptors, matches, and matrices', () => {
    expect(decodeColmapKeypoints({ image_id: 1, rows: 2, cols: 4, data: blob(Float32Array, [1, 2, 3, 4, 5, 6, 7, 8]) })).toEqual([
      expect.objectContaining({ x: 1, y: 2, scale: 3, orientation: 4 }),
      expect.objectContaining({ x: 5, y: 6, scale: 7, orientation: 8 }),
    ])
    const d = decodeColmapDescriptors({ image_id: 1, rows: 1, cols: 128, data: new Uint8Array(128).fill(128) })
    expect(d.compatible).toBe(true)
    expect(d.descriptors[0]).toBeCloseTo(.25)
    expect(decodeColmapKeypoints({ image_id: 2, rows: 1, cols: 2, data: blob(Float32Array, [7, 8]) })[0]).toMatchObject({ x: 7, y: 8 })
    expect(decodeColmapKeypoints({ image_id: 3, rows: 1, cols: 6, data: blob(Float32Array, [1, 2, 3, 4, 5, 6]) })[0].affine).toEqual([3, 4, 5, 6])
    const aliked = decodeColmapDescriptors({ image_id: 2, rows: 1, cols: 512, data: blob(Float32Array, new Array(128).fill(.125)) })
    expect(aliked.descriptorType).toBe('aliked-f32')
    expect(decodeColmapMatches({ pair_id: 1, rows: 2, cols: 2, data: blob(Uint32Array, [1, 2, 3, 4]) })).toEqual([[1, 2], [3, 4]])
    expect(decodeColmapMatrix(blob(Float64Array, [1,2,3,4,5,6,7,8,9]))).toEqual([[1,2,3],[4,5,6],[7,8,9]])
  })

  it('rejects malformed blobs', () => {
    expect(() => decodeColmapKeypoints({ image_id: 1, rows: 2, cols: 2, data: new Uint8Array(4) })).toThrow(/expected 16 bytes/)
    expect(() => pairIdToImageIds(0)).toThrow()
  })
})

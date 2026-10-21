import { describe, expect, it } from 'vitest'
import {
  imageIdsToPairId,
  pairIdToImageIds,
  decodeColmapCamera,
  cameraToWebsfmSensor,
  decodeColmapKeypoints,
  decodeColmapDescriptors,
  decodeColmapMatches,
  decodeColmapMatrix,
  COLMAP_CAMERA_MODELS,
  COLMAP_MAX_IMAGE_ID,
} from './colmapDatabase.js'

const blob = (Typed, values) => new Uint8Array(new Typed(values).buffer)

describe('COLMAP database adapters', () => {
  it('round-trips pair ids', () => {
    for (const pair of [
      [1, 2],
      [2, 99],
      [1234, 987654],
      [COLMAP_MAX_IMAGE_ID - 2, COLMAP_MAX_IMAGE_ID - 1],
    ]) {
      expect(pairIdToImageIds(imageIdsToPairId(...pair))).toEqual(pair)
      expect(imageIdsToPairId(pair[1], pair[0])).toBe(imageIdsToPairId(...pair))
    }
  })

  it('decodes every documented camera model with its declared parameter order', () => {
    for (const [id, spec] of Object.entries(COLMAP_CAMERA_MODELS)) {
      const values = spec.names.map((_, i) => i + 0.5)
      const camera = decodeColmapCamera({
        camera_id: 1,
        model: Number(id),
        width: 10,
        height: 8,
        params: blob(Float64Array, values),
      })
      expect(camera.model).toBe(spec.model)
      expect(camera.params).toEqual(values)
    }
  })

  it('decodes camera blobs and maps Brown calibration', () => {
    const cam = decodeColmapCamera({
      camera_id: 7,
      model: 4,
      width: 1000,
      height: 800,
      params: blob(Float64Array, [900, 910, 500, 400, 0.1, -0.02, 0.001, -0.001]),
    })
    expect(cam.model).toBe('OPENCV')
    expect(cameraToWebsfmSensor(cam)).toMatchObject({
      focal: 900,
      fx: 900,
      fy: 910,
      cx: 500,
      k1: 0.1,
      distortionModel: 'brown',
    })
  })

  it('maps rational and fisheye calibrations without dropping terms', () => {
    const full = decodeColmapCamera({
      camera_id: 2,
      model: 6,
      width: 1000,
      height: 800,
      params: blob(Float64Array, [900, 900, 500, 400, 0.1, -0.02, 0.001, -0.001, 0.003, 0.2, -0.01, 0.002]),
    })
    expect(full.supported).toBe(true)
    expect(full.losses).toEqual([])
    expect(cameraToWebsfmSensor(full)).toMatchObject({
      distortionModel: 'rational',
      k1: 0.1,
      k2: -0.02,
      p1: 0.001,
      p2: -0.001,
      k3: 0.003,
      k4: 0.2,
      k5: -0.01,
      k6: 0.002,
    })

    const fish = decodeColmapCamera({
      camera_id: 3,
      model: 5,
      width: 4000,
      height: 3000,
      params: blob(Float64Array, [1700, 1700, 2000, 1500, 0.05, -0.01, 0.002, -0.0003]),
    })
    expect(fish.supported).toBe(true)
    expect(cameraToWebsfmSensor(fish)).toMatchObject({
      distortionModel: 'fisheye',
      focal: 1700,
      k1: 0.05,
      k2: -0.01,
      k3: 0.002,
      k4: -0.0003,
      p1: null,
      p2: null,
    })

    const simple = decodeColmapCamera({
      camera_id: 4,
      model: 8,
      width: 4000,
      height: 3000,
      params: blob(Float64Array, [1700, 2000, 1500, 0.04]),
    })
    expect(cameraToWebsfmSensor(simple)).toMatchObject({ distortionModel: 'fisheye1', k1: 0.04, k2: null })
    const radial = decodeColmapCamera({
      camera_id: 5,
      model: 3,
      width: 10,
      height: 8,
      params: blob(Float64Array, [9, 5, 4, 0.1, 0.02]),
    })
    expect(cameraToWebsfmSensor(radial)).toMatchObject({ distortionModel: 'radial2', k1: 0.1, k2: 0.02 })
  })

  it('reports the lens models it cannot map', () => {
    for (const model of [7, 10, 11]) {
      const n = COLMAP_CAMERA_MODELS[model].names.length
      const cam = decodeColmapCamera({
        camera_id: 1,
        model,
        width: 10,
        height: 8,
        params: blob(Float64Array, new Array(n).fill(0.5)),
      })
      expect(cam.supported).toBe(false)
      expect(cam.losses[0]).toContain(cam.model)
      expect(cameraToWebsfmSensor(cam)).toBeNull()
    }
  })

  it('decodes keypoints, descriptors, matches, and matrices', () => {
    expect(
      decodeColmapKeypoints({ image_id: 1, rows: 2, cols: 4, data: blob(Float32Array, [1, 2, 3, 4, 5, 6, 7, 8]) }),
    ).toEqual([
      expect.objectContaining({ x: 1, y: 2, scale: 3, orientation: 4 }),
      expect.objectContaining({ x: 5, y: 6, scale: 7, orientation: 8 }),
    ])
    const d = decodeColmapDescriptors({ image_id: 1, rows: 1, cols: 128, data: new Uint8Array(128).fill(128) })
    expect(d.compatible).toBe(true)
    expect(d.descriptors[0]).toBeCloseTo(0.25)
    expect(decodeColmapKeypoints({ image_id: 2, rows: 1, cols: 2, data: blob(Float32Array, [7, 8]) })[0]).toMatchObject(
      { x: 7, y: 8 },
    )
    expect(
      decodeColmapKeypoints({ image_id: 3, rows: 1, cols: 6, data: blob(Float32Array, [1, 2, 3, 4, 5, 6]) })[0].affine,
    ).toEqual([3, 4, 5, 6])
    const aliked = decodeColmapDescriptors({
      image_id: 2,
      rows: 1,
      cols: 512,
      data: blob(Float32Array, new Array(128).fill(0.125)),
    })
    expect(aliked.descriptorType).toBe('aliked-f32')
    expect(decodeColmapMatches({ pair_id: 1, rows: 2, cols: 2, data: blob(Uint32Array, [1, 2, 3, 4]) })).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(decodeColmapMatrix(blob(Float64Array, [1, 2, 3, 4, 5, 6, 7, 8, 9]))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ])
  })

  it('rejects malformed blobs', () => {
    expect(() => decodeColmapKeypoints({ image_id: 1, rows: 2, cols: 2, data: new Uint8Array(4) })).toThrow(
      /expected 16 bytes/,
    )
    expect(() => pairIdToImageIds(0)).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { cameraToWorldGl } from './transforms.js'
import { parseNvm, parseTransformsJson, buildNvmParts, buildOpenMvg } from './sfmInterop.js'
import { joinParts, jsonParts } from './parts.js'

describe('SfM interop readers', () => {
  it('round-trips transforms camera convention', () => {
    const R = [[0,-1,0],[1,0,0],[0,0,1]], t = [2,3,4]
    const parsed = parseTransformsJson({ fl_x: 900, fl_y: 901, cx: 400, cy: 300, w: 800, h: 600, frames: [{ file_path: 'a.jpg', transform_matrix: cameraToWorldGl(R, t) }] })
    expect(parsed.images[0].R.flat()).toEqual(R.flat())
    expect(parsed.images[0].t).toEqual(t)
  })

  it('reads an NVM camera and measurement', () => {
    const parsed = parseNvm('NVM_V3\n1\na.jpg 1000 1 0 0 0 1 2 3 0\n1\n0 0 0 255 0 0 1 0 7 10 20\n0')
    expect(parsed.images[0].t).toEqual([-1, -2, -3])
    expect(parsed.points[0].views[0].name).toBe('a.jpg')
  })
})

describe('NVM / OpenMVG writers — streamed', () => {
  const model = {
    images: [
      { imageId: 1, cameraId: 1, name: 'a.jpg', q: [1, 0, 0, 0], t: [1, 2, 3], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], K: { fx: 100, cx: 50, cy: 40 }, width: 100, height: 80, points2D: [[60, 50, 1]] },
      { imageId: 2, cameraId: 2, name: 'b.jpg', q: [1, 0, 0, 0], t: [0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], K: { fx: 90, cx: 45, cy: 35 }, width: 90, height: 70, points2D: [[1, 2, -1], [47, 36, 1]] },
    ],
    points3D: [{ point3dId: 1, xyz: [0.5, 1, 2], rgb: [10, 20, 30], error: 0, track: [[1, 0], [2, 1]] }],
  }
  it('NVM text is unchanged and splits into parts', () => {
    expect(joinParts(buildNvmParts(model))).toBe(
      'NVM_V3\n\n2\na.jpg 100 1 0 0 0 -1 -2 -3 0 0\nb.jpg 90 1 0 0 0 0 0 0 0 0\n\n1\n0.5 1 2 10 20 30 2 0 0 10 10 1 1 2 1\n\n0\n')
    expect([...buildNvmParts(model, { partChars: 8 })].length).toBeGreaterThan(3)
  })
  it('OpenMVG JSON streams to the same text as the materialized document', () => {
    const doc = buildOpenMvg(model)
    const materialized = { ...doc, structure: Array.from({ length: doc.structure.length }, (_, i) => doc.structure.at(i)) }
    expect(joinParts(jsonParts(doc, { space: 2 }))).toBe(JSON.stringify(materialized, null, 2))
  })
})

import { describe, expect, it } from 'vitest'
import { cameraToWorldGl } from './transforms.js'
import { parseNvm, parseTransformsJson } from './sfmInterop.js'

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

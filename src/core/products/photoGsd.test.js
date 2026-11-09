import { describe, it, expect } from 'vitest'
import { photoGsd } from './photoGsd.js'
import { SparsePoints } from '../sfm/sparsePoints.js'

// Nadir cameras at height H over flat ground (z = 0), looking down: x_cam = R·(X − C),
// R = diag(1, −1, −1), so t = −R·C. Each sees the ground point straight below it at
// distance H, so a photo pixel covers H / fx there.
function nadirBlock({ H, fx, n = 9 }) {
  const R = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const cameras = new Map()
  const pos = []
  const vcam = []
  const vcount = []
  for (let i = 0; i < n; i++) {
    const C = [i * 10, (i % 3) * 10, H]
    const t = [-C[0], C[1], C[2]] // −R·C
    cameras.set(`c${i}`, { R, t, K: { fx, fy: fx, cx: 0, cy: 0 } })
    pos.push(C[0], C[1], 0)
    vcam.push(i)
    vcount.push(1)
  }
  const points = new SparsePoints({
    pos: Float64Array.from(pos),
    viewUuids: [...cameras.keys()],
    vcount: Uint32Array.from(vcount),
    vcam: Uint32Array.from(vcam),
    vkp: new Uint32Array(vcam.length),
  })
  return { cameras, points }
}

describe('photoGsd', () => {
  it('is the height over the focal length for a nadir block', () => {
    const { cameras, points } = nadirBlock({ H: 120, fx: 4000 })
    expect(photoGsd(cameras, points, (p) => p)).toBeCloseTo(120 / 4000, 12)
  })
  it("is measured in the frame's own units", () => {
    const { cameras, points } = nadirBlock({ H: 120, fx: 4000 })
    // A frame that scales the model by 2.5 and moves it: the GSD scales, the move does not count.
    const toFrame = ([x, y, z]) => [2.5 * x + 1000, 2.5 * y - 50, 2.5 * z + 7]
    expect(photoGsd(cameras, points, toFrame)).toBeCloseTo((2.5 * 120) / 4000, 12)
  })
  it('is null with nothing to measure', () => {
    const { cameras } = nadirBlock({ H: 120, fx: 4000 })
    expect(photoGsd(cameras, null, (p) => p)).toBe(null)
    expect(photoGsd(new Map(), nadirBlock({ H: 1, fx: 1 }).points, (p) => p)).toBe(null)
  })
})

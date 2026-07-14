import { describe, it, expect } from 'vitest'
import { cameraToWorldGl, buildTransformsJson } from './transforms.js'

// Multiply a 4×4 (nested rows) by a 4-vector.
const mul4 = (M, v) => M.map((row) => row[0]*v[0] + row[1]*v[1] + row[2]*v[2] + row[3]*v[3])

describe('cameraToWorldGl', () => {
  it('maps the camera centre to the world origin offset (identity R)', () => {
    // Camera at C = (2,3,4): world-to-cam t = −R·C = −C for R = I.
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const t = [-2, -3, -4]
    const c2w = cameraToWorldGl(R, t)
    // The translation column is the camera centre.
    expect([c2w[0][3], c2w[1][3], c2w[2][3]]).toEqual([2, 3, 4])
    // Columns 1 and 2 of the rotation are negated (OpenCV → OpenGL axis flip).
    expect([c2w[0][0], c2w[1][1], c2w[2][2]]).toEqual([1, -1, -1])
    expect(c2w[3]).toEqual([0, 0, 0, 1])
  })

  it('c2w_gl · diag(1,−1,−1,1) inverts back to [Rᵀ | C]', () => {
    // A non-trivial rotation (90° about Z), world-to-cam.
    const R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
    const t = [1, 2, 3]
    const C = [
      -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2]),
      -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2]),
      -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2]),
    ]
    const c2w = cameraToWorldGl(R, t)
    // Undo the OpenGL flip: negate columns 1,2 again → OpenCV c2w = [Rᵀ | C].
    const flip = c2w.map((row) => [row[0], -row[1], -row[2], row[3]])
    // Rotation part is Rᵀ (column j = row j of R).
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(flip[i][j]).toBeCloseTo(R[j][i], 9)
    // Translation is the camera centre.
    expect([flip[0][3], flip[1][3], flip[2][3]].map((v) => +v.toFixed(9))).toEqual(C.map((v) => +v.toFixed(9)))
  })

  it('a world point on the camera ray maps consistently through c2w', () => {
    // A point at camera-space (0,0,5) (5 units down +z, in front) with identity R,
    // camera at origin → world point (0,0,5). In OpenGL c2w that camera-space
    // point becomes (0,0,−5) after the axis flip; feeding it through c2w must land
    // back at the OpenCV world point (0,0,5).
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const t = [0, 0, 0]
    const c2w = cameraToWorldGl(R, t)
    const world = mul4(c2w, [0, 0, -5, 1]) // OpenGL cam-space z is negated
    expect([world[0], world[1], world[2]].map((v) => +v.toFixed(9))).toEqual([0, 0, 5])
  })
})

describe('buildTransformsJson', () => {
  const K = { fx: 1000, fy: 1000, cx: 320, cy: 240 }
  const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

  it('writes shared intrinsics at the top level when all cameras match', () => {
    const out = buildTransformsJson({
      images: [
        { name: 'a.jpg', R, t: [0, 0, 0], K, width: 640, height: 480 },
        { name: 'b.jpg', R, t: [1, 0, 0], K, width: 640, height: 480 },
      ],
    })
    expect(out.camera_model).toBe('OPENCV')
    expect(out.fl_x).toBe(1000)
    expect(out.w).toBe(640)
    expect(out.k1).toBe(0)
    expect(out.frames).toHaveLength(2)
    expect(out.frames[0].file_path).toBe('a.jpg')
    expect(out.frames[0].transform_matrix).toHaveLength(4)
    expect(out.frames[0].fl_x).toBeUndefined() // shared → not per-frame
  })

  it('writes per-frame intrinsics when cameras differ', () => {
    const out = buildTransformsJson({
      images: [
        { name: 'a.jpg', R, t: [0, 0, 0], K, width: 640, height: 480 },
        { name: 'b.jpg', R, t: [1, 0, 0], K: { ...K, fx: 1200 }, width: 640, height: 480 },
      ],
    })
    expect(out.fl_x).toBeUndefined() // not at top level
    expect(out.frames[0].fl_x).toBe(1000)
    expect(out.frames[1].fl_x).toBe(1200)
  })

  it('handles an empty model', () => {
    expect(buildTransformsJson({ images: [] })).toEqual({ camera_model: 'OPENCV', frames: [] })
  })
})

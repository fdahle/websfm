import { describe, it, expect } from 'vitest'
import {
  rotationToQuat,
  quatToRotation,
  intrinsicsFromCamera,
  serializeColmapModel,
  parseColmapModel,
  serializeColmapModelBin,
  parseColmapModelBin,
  buildColmapModel,
  readColmapModel,
  makeNameResolver,
  colmapToSparse,
} from './colmapModel.js'

// A non-trivial proper rotation (30° about a tilted axis), row-major.
const R30 = (() => {
  const a = Math.PI / 6
  const [ux, uy, uz] = (() => {
    const n = Math.hypot(1, 2, 3)
    return [1 / n, 2 / n, 3 / n]
  })()
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c
  return [
    [c + ux * ux * t, ux * uy * t - uz * s, ux * uz * t + uy * s],
    [uy * ux * t + uz * s, c + uy * uy * t, uy * uz * t - ux * s],
    [uz * ux * t - uy * s, uz * uy * t + ux * s, c + uz * uz * t],
  ]
})()

function expectMatClose(A, B, tol = 1e-12) {
  for (let r = 0; r < 3; r++)
    for (let cc = 0; cc < 3; cc++) expect(A[r][cc]).toBeCloseTo(B[r][cc], 10)
}

describe('rotation ↔ quaternion', () => {
  it('round-trips identity', () => {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    expect(rotationToQuat(I)).toEqual([1, 0, 0, 0])
    expectMatClose(quatToRotation(rotationToQuat(I)), I)
  })

  it('round-trips a tilted 30° rotation', () => {
    expectMatClose(quatToRotation(rotationToQuat(R30)), R30)
  })

  it('round-trips 180° rotations (trace ≤ 0 branches)', () => {
    for (const R of [
      [[1, 0, 0], [0, -1, 0], [0, 0, -1]], // 180° about x
      [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], // 180° about y
      [[-1, 0, 0], [0, -1, 0], [0, 0, 1]], // 180° about z
    ]) {
      expectMatClose(quatToRotation(rotationToQuat(R)), R)
    }
  })

  it('normalizes to qw ≥ 0', () => {
    const q = rotationToQuat(R30)
    expect(q[0]).toBeGreaterThanOrEqual(0)
    expect(Math.hypot(...q)).toBeCloseTo(1, 12)
  })
})

describe('intrinsicsFromCamera', () => {
  it('reads PINHOLE with no dropped params', () => {
    const k = intrinsicsFromCamera({ model: 'PINHOLE', params: [1000, 1010, 320, 240] })
    expect(k).toMatchObject({ fx: 1000, fy: 1010, cx: 320, cy: 240, dropped: [] })
  })

  it('reads SIMPLE_PINHOLE (shared f)', () => {
    const k = intrinsicsFromCamera({ model: 'SIMPLE_PINHOLE', params: [800, 320, 240] })
    expect(k).toMatchObject({ fx: 800, fy: 800, cx: 320, cy: 240 })
  })

  it('drops distortion of OPENCV but keeps fx/fy/cx/cy', () => {
    const k = intrinsicsFromCamera({ model: 'OPENCV', params: [1000, 1000, 320, 240, 0.1, -0.02, 0.001, 0] })
    expect(k).toMatchObject({ fx: 1000, fy: 1000, cx: 320, cy: 240 })
    expect(k.dropped).toEqual(['k1', 'k2', 'p1', 'p2'])
  })

  it('throws on unknown model', () => {
    expect(() => intrinsicsFromCamera({ model: 'WEIRD', params: [] })).toThrow(/Unsupported/)
  })
})

describe('serialize → parse round-trip', () => {
  const model = {
    cameras: [
      { cameraId: 1, model: 'PINHOLE', width: 640, height: 480, params: [1000, 1000, 320, 240] },
      { cameraId: 2, model: 'PINHOLE', width: 800, height: 600, params: [1200, 1200, 400, 300] },
    ],
    images: [
      {
        imageId: 1,
        q: [1, 0, 0, 0],
        t: [0.5, -1.5, 8],
        cameraId: 1,
        name: 'img with space.jpg',
        points2D: [[100.5, 200.25, 1], [50, 60, -1], [10, 20, 2]],
      },
      {
        imageId: 2,
        q: rotationToQuat(R30),
        t: [3, 4, 5],
        cameraId: 2,
        name: 'b.jpg',
        points2D: [], // image with zero observations → empty POINTS2D line
      },
    ],
    points3D: [
      { point3dId: 1, xyz: [1.1, 2.2, 3.3], rgb: [10, 20, 30], error: 0.4, track: [[1, 0]] },
      { point3dId: 2, xyz: [-4, -5, -6], rgb: [255, 0, 128], error: -1, track: [[1, 2]] },
    ],
  }

  it('survives serialize → parse unchanged', () => {
    const parsed = parseColmapModel(serializeColmapModel(model))
    expect(parsed).toEqual(model)
  })

  it('throws on a non-finite value instead of silently writing 0', () => {
    const bad = {
      cameras: [{ cameraId: 1, model: 'PINHOLE', width: 640, height: 480, params: [1000, 1000, 320, 240] }],
      images: [{ imageId: 1, q: [1, 0, 0, 0], t: [NaN, 0, 5], cameraId: 1, name: 'a.jpg', points2D: [] }],
      points3D: [],
    }
    expect(() => serializeColmapModel(bad)).toThrow(/non-finite/)
  })

  it('emits the three files with COLMAP headers', () => {
    const files = serializeColmapModel(model)
    expect(Object.keys(files).sort()).toEqual(['cameras.txt', 'images.txt', 'points3D.txt'])
    expect(files['cameras.txt']).toMatch(/# Number of cameras: 2/)
    expect(files['images.txt']).toMatch(/# Number of images: 2/)
    expect(files['points3D.txt']).toMatch(/# Number of points: 2/)
  })

  it('binary serialize → parse survives unchanged', () => {
    const parsed = parseColmapModelBin(serializeColmapModelBin(model))
    expect(parsed).toEqual(model)
  })

  it('txt and bin encode the SAME model identically', () => {
    // The two encodings must decode to the same ColmapModel — the property that
    // lets a downstream tool read either interchangeably.
    const fromTxt = parseColmapModel(serializeColmapModel(model))
    const fromBin = parseColmapModelBin(serializeColmapModelBin(model))
    expect(fromBin).toEqual(fromTxt)
  })

  it('binary emits the three .bin files as bytes', () => {
    const files = serializeColmapModelBin(model)
    expect(Object.keys(files).sort()).toEqual(['cameras.bin', 'images.bin', 'points3D.bin'])
    for (const b of Object.values(files)) expect(b).toBeInstanceOf(Uint8Array)
  })

  it('binary serialize throws on a non-finite value', () => {
    const bad = {
      cameras: [{ cameraId: 1, model: 'PINHOLE', width: 640, height: 480, params: [1000, 1000, 320, 240] }],
      images: [{ imageId: 1, q: [1, 0, 0, 0], t: [Infinity, 0, 5], cameraId: 1, name: 'a.jpg', points2D: [] }],
      points3D: [],
    }
    expect(() => serializeColmapModelBin(bad)).toThrow(/non-finite/)
  })
})

describe('COLMAP binary — non-PINHOLE cameras (warn+ignore distortion)', () => {
  it('reads fx/fy/cx/cy from a RADIAL camera and reports it dropped via readColmapModel', () => {
    // Hand-build a binary model with a RADIAL camera (params f, cx, cy, k1, k2) —
    // readColmapModel must take f→fx/fy and flag the distortion as dropped.
    const model = {
      cameras: [{ cameraId: 7, model: 'RADIAL', width: 1000, height: 800, params: [900, 500, 400, 0.01, -0.002] }],
      images: [{ imageId: 1, q: [1, 0, 0, 0], t: [0, 0, 0], cameraId: 7, name: 'r.jpg', points2D: [[1, 2, -1]] }],
      points3D: [],
    }
    const parsed = parseColmapModelBin(serializeColmapModelBin(model))
    expect(parsed.cameras[0].model).toBe('RADIAL')
    expect(parsed.cameras[0].params).toEqual([900, 500, 400, 0.01, -0.002])
    const { images, droppedDistortion } = readColmapModel(parsed)
    expect(images[0].K).toEqual({ fx: 900, fy: 900, cx: 500, cy: 400 })
    expect(droppedDistortion).toContain('RADIAL')
  })
})

describe('parse tolerance', () => {
  it('parses a hand-written fixture, ignoring comments and blank lines', () => {
    const files = {
      'cameras.txt':
        '# comment\n1 SIMPLE_RADIAL 640 480 900 320 240 0.01\n',
      'images.txt':
        '# header comment\n' +
        '1 1 0 0 0 0 0 5 1 photo.jpg\n' +
        '100 200 1 300 400 -1\n',
      'points3D.txt':
        '# comment\n1 1 2 3 200 100 50 0.5 1 0\n',
    }
    const m = parseColmapModel(files)
    expect(m.cameras[0]).toMatchObject({ model: 'SIMPLE_RADIAL', width: 640, params: [900, 320, 240, 0.01] })
    expect(m.images[0].points2D).toEqual([[100, 200, 1], [300, 400, -1]])
    expect(m.points3D[0].track).toEqual([[1, 0]])
  })
})

describe('buildColmapModel / readColmapModel', () => {
  const images = [
    { uuid: 'ua', name: 'a.jpg', width: 640, height: 480, K: { fx: 1000, fy: 1000, cx: 320, cy: 240 }, R: R30, t: [1, 2, 3] },
    { uuid: 'ub', name: 'b.jpg', width: 640, height: 480, K: { fx: 900, fy: 900, cx: 320, cy: 240 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [4, 5, 6] },
  ]
  const points = [
    { xyz: [0.1, 0.2, 0.3], color: [10, 20, 30], views: [{ uuid: 'ua', x: 100, y: 200 }, { uuid: 'ub', x: 110, y: 210 }] },
    { xyz: [1, 1, 1], color: [200, 100, 50], views: [{ uuid: 'ua', x: 5, y: 6 }] },
  ]

  it('builds a valid model with 1 camera per image and correct tracks', () => {
    const m = buildColmapModel({ images, points })
    expect(m.cameras).toHaveLength(2)
    expect(m.cameras[0]).toMatchObject({ cameraId: 1, model: 'PINHOLE', params: [1000, 1000, 320, 240] })
    // point 1 observed in both images; point 2 only in image ua
    expect(m.points3D[0].track).toEqual([[1, 0], [2, 0]])
    expect(m.points3D[1].track).toEqual([[1, 1]])
    // image ua's POINTS2D holds both of its observations in track order
    expect(m.images[0].points2D).toEqual([[100, 200, 1], [5, 6, 2]])
    expect(m.images[1].points2D).toEqual([[110, 210, 1]])
  })

  it('read(build(x)) recovers geometry, intrinsics and pixel observations', () => {
    const back = readColmapModel(buildColmapModel({ images, points }))
    expect(back.images[0].name).toBe('a.jpg')
    expectMatClose(back.images[0].R, R30)
    expect(back.images[0].K).toMatchObject({ fx: 1000, fy: 1000, cx: 320, cy: 240 })
    expect(back.images[0].t).toEqual([1, 2, 3])
    expect(back.droppedDistortion).toEqual([]) // PINHOLE export → nothing dropped
    // point 1's two views come back with names + pixels
    expect(back.points[0].views).toEqual([
      { imageId: 1, name: 'a.jpg', x: 100, y: 200 },
      { imageId: 2, name: 'b.jpg', x: 110, y: 210 },
    ])
    expect(back.points[0].color).toEqual([10, 20, 30])
  })

  it('drops views into images not being exported', () => {
    const m = buildColmapModel({
      images: [images[0]],
      points: [{ xyz: [0, 0, 0], color: [1, 2, 3], views: [{ uuid: 'ua', x: 1, y: 2 }, { uuid: 'ghost', x: 9, y: 9 }] }],
    })
    expect(m.points3D[0].track).toEqual([[1, 0]]) // ghost view omitted
  })

  it('flags dropped distortion when importing a RADIAL model', () => {
    const model = {
      cameras: [{ cameraId: 1, model: 'RADIAL', width: 640, height: 480, params: [900, 320, 240, 0.01, -0.002] }],
      images: [{ imageId: 1, q: [1, 0, 0, 0], t: [0, 0, 0], cameraId: 1, name: 'a.jpg', points2D: [[1, 2, 1]] }],
      points3D: [{ point3dId: 1, xyz: [0, 0, 1], rgb: [0, 0, 0], error: 0, track: [[1, 0]] }],
    }
    const back = readColmapModel(model)
    expect(back.droppedDistortion).toEqual(['RADIAL'])
    expect(back.images[0].K).toMatchObject({ fx: 900, fy: 900, cx: 320, cy: 240 })
  })
})

describe('makeNameResolver', () => {
  const loaded = [
    { uuid: 'u1', name: 'IMG_0001.JPG' },
    { uuid: 'u2', name: 'sub/dir/photo_2.tif' },
  ]
  const resolve = makeNameResolver(loaded)

  it('matches exact, basename, case-insensitive, and extension-stripped', () => {
    expect(resolve('IMG_0001.JPG')).toBe('u1')          // exact
    expect(resolve('images/IMG_0001.JPG')).toBe('u1')   // basename of a path
    expect(resolve('img_0001.jpg')).toBe('u1')          // case-insensitive basename
    expect(resolve('photo_2.tif')).toBe('u2')           // basename of a stored path
    expect(resolve('photo_2.png')).toBe('u2')           // stem match, different extension
  })

  it('returns null for an unmatched or nullish name', () => {
    expect(resolve('nope.jpg')).toBeNull()
    expect(resolve(null)).toBeNull()
  })
})

describe('colmapToSparse', () => {
  // Round-trip a real reconstruction: build → read → colmapToSparse recovers the
  // store shapes, matching COLMAP image names to uuids.
  const images = [
    { uuid: 'ua', name: 'a.jpg', width: 640, height: 480, K: { fx: 1000, fy: 1000, cx: 320, cy: 240 }, R: R30, t: [1, 2, 3] },
    { uuid: 'ub', name: 'b.jpg', width: 640, height: 480, K: { fx: 900, fy: 900, cx: 320, cy: 240 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [4, 5, 6] },
  ]
  const points = [
    { xyz: [0.1, 0.2, 0.3], color: [10, 20, 30], views: [{ uuid: 'ua', x: 100, y: 200 }, { uuid: 'ub', x: 110, y: 210 }] },
    { xyz: [1, 1, 1], color: [200, 100, 50], views: [{ uuid: 'ua', x: 5, y: 6 }] },
  ]
  const read = readColmapModel(buildColmapModel({ images, points }))
  const resolve = makeNameResolver(images.map(({ uuid, name }) => ({ uuid, name })))

  it('recovers cameras (R/t/K) into a uuid-keyed Map', () => {
    const { cameras } = colmapToSparse(read, resolve)
    expect([...cameras.keys()].sort()).toEqual(['ua', 'ub'])
    expect(cameras.get('ua').K).toMatchObject({ fx: 1000, fy: 1000, cx: 320, cy: 240 })
    expectMatClose(cameras.get('ua').R, R30)
    expect(cameras.get('ua').t).toEqual([1, 2, 3])
  })

  it('recovers points with view uuids + BA-frame pixels in viewsPx', () => {
    const { points: pts } = colmapToSparse(read, resolve)
    expect(pts).toHaveLength(2)
    expect([...pts[0].views.keys()].sort()).toEqual(['ua', 'ub'])
    expect(pts[0].viewsPx.get('ua')).toEqual([100, 200])
    expect(pts[0].viewsPx.get('ub')).toEqual([110, 210])
    expect(pts[0].color).toEqual([10, 20, 30])
    expect(pts[1].views.size).toBe(1)
  })

  it('drops unmatched images, their observations, and now-empty points', () => {
    // Only 'a.jpg' is loaded; the point seen solely by 'b.jpg' must vanish.
    const partial = makeNameResolver([{ uuid: 'ua', name: 'a.jpg' }])
    const onlyB = readColmapModel(buildColmapModel({
      images,
      points: [{ xyz: [7, 8, 9], color: [0, 0, 0], views: [{ uuid: 'ub', x: 1, y: 2 }] }],
    }))
    const { cameras, points: pts, matched, unmatched } = colmapToSparse(onlyB, partial)
    expect(matched.map((m) => m.name)).toEqual(['a.jpg'])
    expect(unmatched).toEqual(['b.jpg'])
    expect(cameras.has('ub')).toBe(false)
    expect(pts).toHaveLength(0) // point observed only by the dropped image
  })
})

import { describe, expect, it } from 'vitest'
import {
  imageOverlayItems,
  normalizeImageLayer,
  pointsExtent,
  squareToQuad,
  triangleTransform,
  warpMesh,
} from './imageOverlay.js'

// A trapezoid, as a tilted camera's footprint: wider away from the camera.
const quad = [
  [0, 10],
  [10, 10],
  [14, 0],
  [-4, 0],
]
const close = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))

describe('squareToQuad', () => {
  it('takes the unit square corners onto the quad corners', () => {
    const H = squareToQuad(quad)
    close(H(0, 0), quad[0])
    close(H(1, 0), quad[1])
    close(H(1, 1), quad[2])
    close(H(0, 1), quad[3])
  })

  it('is projective: the image centre lands where the diagonals cross, not at the corners’ mean', () => {
    const [x, y] = squareToQuad(quad)(0.5, 0.5)
    // Diagonals (0,10)–(14,0) and (10,10)–(−4,0) cross at x = 5, y = 10 − 5·10/14.
    expect(x).toBeCloseTo(5, 9)
    expect(y).toBeCloseTo(10 - 50 / 14, 9)
  })

  it('is affine for a parallelogram', () => {
    const H = squareToQuad([
      [0, 0],
      [4, 0],
      [5, 2],
      [1, 2],
    ])
    close(H(0.5, 0.5), [2.5, 1])
  })
})

describe('warpMesh and triangleTransform', () => {
  it('covers the image with 2·n² triangles whose corners follow the homography', () => {
    const mesh = warpMesh(quad, 4)
    expect(mesh).toHaveLength(32)
    const H = squareToQuad(quad)
    for (const t of mesh) t.src.forEach((uv, k) => close(t.dst[k], H(...uv)))
  })

  it('maps a triangle onto another as a canvas transform', () => {
    const src = [
      [0, 0],
      [200, 0],
      [0, 100],
    ]
    const dst = [
      [10, 20],
      [30, 25],
      [5, 60],
    ]
    const [a, b, c, d, e, f] = triangleTransform(src, dst)
    for (let k = 0; k < 3; k++) {
      const [u, v] = src[k]
      close([a * u + c * v + e, b * u + d * v + f], dst[k])
    }
    expect(triangleTransform([src[0], src[0], src[1]], dst)).toBeNull()
  })

  it('bounds points', () => {
    expect(pointsExtent(quad)).toEqual([-4, 0, 14, 10])
  })
})

describe('imageOverlayItems', () => {
  const ring = [...quad, quad[0]]
  const footprints = [
    { imageId: 'a', rings: [ring] },
    { imageId: 'b', rings: [ring] },
    { imageId: 'gone', rings: [ring] },
    { rings: [ring] },
  ]
  const images = [
    { id: 'a', url: 'blob:a', thumb: { url: 'blob:a-thumb' } },
    { id: 'b', url: null, thumb: null },
  ]

  it('draws the selected image from its display image, the others from thumbnails', () => {
    const all = imageOverlayItems(footprints, images, { mode: 'all', selectedId: 'a' })
    expect(all.map((i) => [i.imageId, i.url, i.full])).toEqual([
      ['a', 'blob:a', true],
      ['b', null, false],
    ])
    expect(all[0].quad).toEqual(quad)
  })

  it('draws only the selected image by default, and nothing with none selected', () => {
    expect(imageOverlayItems(footprints, images, { selectedId: 'b' }).map((i) => i.imageId)).toEqual(['b'])
    expect(imageOverlayItems(footprints, images)).toEqual([])
  })
})

describe('normalizeImageLayer', () => {
  it('keeps a valid state and repairs a malformed one', () => {
    expect(normalizeImageLayer(null)).toBeNull()
    expect(normalizeImageLayer({ visible: true, opacity: 0.5, mode: 'all' })).toEqual({
      visible: true,
      opacity: 0.5,
      mode: 'all',
    })
    expect(normalizeImageLayer({ visible: 'yes', opacity: 7, mode: 'some' })).toEqual({
      visible: false,
      opacity: 1,
      mode: 'selected',
    })
  })
})

import { it, expect } from 'vitest'
import { frameOffset, modelMapCameras, modelMapExtent } from './modelMap.js'
import { frameFromSpec, describeFrame } from './frameSpec.js'
import { makeFrame } from './projection.js'

// Two auto local frames of one model: same cameras (so the same up/east/north),
// built from different point sets (so different origins) — the DEM-from-dense vs
// map-from-sparse situation.
const cams = [
  {
    R: [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ],
    t: [0, 0, 10],
  },
  {
    R: [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ],
    t: [-4, 0, 10],
  },
]
const pts = (dx) => [
  { x: 1 + dx, y: 2, z: 0 },
  { x: 3 + dx, y: 4, z: 1 },
]

it('a translated product lands where the map frame puts the same world point', () => {
  const map = frameFromSpec({ kind: 'local' }, cams, pts(0))
  const product = frameFromSpec({ kind: 'local' }, cams, pts(5))
  const off = frameOffset(describeFrame(product, { kind: 'local' }), map)
  expect(off.reason).toBeUndefined()
  for (const p of [
    [0, 0, 0],
    [12.5, -3, 2],
    [-7, 9, -1],
  ]) {
    const inProduct = product.fromSfm(p),
      inMap = map.fromSfm(p)
    expect(inProduct[0] + off.dx).toBeCloseTo(inMap[0], 9)
    expect(inProduct[1] + off.dy).toBeCloseTo(inMap[1], 9)
  }
})

it('applies the frame scale to the offset, and refuses a scale or basis mismatch', () => {
  const base = frameFromSpec({ kind: 'local' }, cams, pts(0))
  const map = frameFromSpec({ kind: 'scaled-local', scale: 2 }, cams, pts(0))
  const prodFrame = frameFromSpec({ kind: 'scaled-local', scale: 2 }, cams, pts(3))
  const desc = describeFrame(prodFrame, { kind: 'scaled-local', scale: 2 })
  const off = frameOffset(desc, map)
  const p = [5, 5, 0]
  expect(prodFrame.fromSfm(p)[0] + off.dx).toBeCloseTo(map.fromSfm(p)[0], 9)
  expect(frameOffset(desc, base).reason).toMatch(/scale/)
  const turned = makeFrame({ origin: [0, 0, 0], east: [0, 1, 0], north: [-1, 0, 0], up: [0, 0, 1] })
  expect(frameOffset(desc, { ...turned, scale: 2 }).reason).toMatch(/oriented/)
  expect(frameOffset({ kind: 'similarity' }, map).reason).toMatch(/project CRS/)
})

it('puts camera centres in the frame and pads a degenerate extent', () => {
  const frame = makeFrame({ origin: [0, 0, 0], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1] })
  const out = modelMapCameras([{ imageId: 'a', imageName: 'A', ...cams[1] }], frame)
  expect(out).toEqual([{ imageId: 'a', imageName: 'A', x: 4, y: 0 }])
  const e = modelMapExtent(out)
  expect(e[0]).toBeLessThan(4)
  expect(e[2]).toBeGreaterThan(4)
  expect(modelMapExtent([])).toEqual([-100, -100, 100, 100])
})

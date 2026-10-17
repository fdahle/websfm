import { describe, expect, it } from 'vitest'
import { packSparseForDense, viewIndex, positionsInRegion } from './sparseInput.js'
import { selectSourceViews } from './mvs.js'
import { makePackedPoints } from '../sfm/resultCodec.js'
import { SparsePoints } from '../sfm/sparsePoints.js'

const points = SparsePoints.fromRecords([
  { x: 0, y: 0, z: 5, views: new Map([['a', 1], ['b', 2]]) },
  { x: 1, y: 0, z: 5, views: new Map([['b', 3], ['c', 4]]) },
  { x: 0, y: 1, z: 5, views: new Map([['a', 5], ['c', 6], ['b', 7]]) },
])

describe('packSparseForDense', () => {
  it('packs positions and per-point viewers', () => {
    const s = packSparseForDense(points)
    expect([...s.pos]).toEqual([0, 0, 5, 1, 0, 5, 0, 1, 5])
    expect([...s.vstart]).toEqual([0, 2, 4, 7])
    expect([...s.vcam].map((c) => s.viewUuids[c])).toEqual(['a', 'b', 'b', 'c', 'a', 'c', 'b'])
    const index = viewIndex(s)
    expect([...index.get('a')]).toEqual([0, 2])
    expect([...index.get('b')]).toEqual([0, 1, 2])
  })

  it('reads a cloud’s packed CSR tracks directly, with the same result', () => {
    const viewUuids = ['a', 'b', 'c']
    const packed = makePackedPoints({
      pos: Float64Array.from([0, 0, 5, 1, 0, 5, 0, 1, 5]), viewUuids,
      vcount: Uint32Array.from([2, 2, 3]), vcam: Uint32Array.from([0, 1, 1, 2, 0, 2, 1]), vkp: new Uint32Array(7),
    })
    const s = packSparseForDense(packed)
    expect([...s.vstart]).toEqual([0, 2, 4, 7])
    expect([...s.vcam].map((c) => s.viewUuids[c])).toEqual(['a', 'b', 'b', 'c', 'a', 'c', 'b'])
    // A copy: transferring it must not detach the cloud's own tracks.
    expect(s.vcam.buffer).not.toBe(packed.vcam.buffer)
  })

  it('keeps only the positions inside a region', () => {
    const r = { min: [-1, -1, 0], max: [0.5, 2, 10] }
    expect([...positionsInRegion(packSparseForDense(points).pos, r)]).toEqual([0, 0, 5, 0, 1, 5])
  })
})

it('selectSourceViews ranks the views that share the reference’s points', () => {
  const cam = (cx) => ({ R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [-cx, 0, 0], K: { fx: 100, fy: 100, cx: 50, cy: 50 } })
  const cameras = new Map([['a', cam(0)], ['b', cam(1)], ['c', cam(2)]])
  const s = packSparseForDense(points)
  // a shares points 0 and 2 with b, point 2 with c.
  expect(selectSourceViews(cameras, s, 'a', { minAngleDeg: 0, maxAngleDeg: 90 })).toEqual(['b', 'c'])
})

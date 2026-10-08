import { describe, it, expect } from 'vitest'
import { gcpObservationMover, undistortAtIngest, refitMovedPairs, resolveIntrinsics } from './ingest.js'
import { distortPixel } from './distortion.js'
import { Uint32PairList, packMatchPairs } from './matchCodec.js'

const quiet = () => {}

describe('ingest', () => {
  it('moves only the named image\'s GCP marks', () => {
    const gcps = [{ observations: [{ uuid: 'a', px: 10, py: 20 }, { uuid: 'b', px: 1, py: 2 }, { uuid: 'a', px: NaN, py: 0 }] }]
    const move = gcpObservationMover(gcps)
    move('a', (x, y) => ({ x: x + 1, y: y * 2 }))
    expect(gcps[0].observations.map((o) => [o.px, o.py])).toEqual([[11, 40], [1, 2], [NaN, 0]])
  })

  it('undistorts calibrated images at ingest and keeps keypoint indices', () => {
    const sensor = { focal: 1000, focalUnit: 'px', cx: 500, cy: 400, width: 1000, height: 800, k1: -0.1, distortionModel: 'radial' }
    const imgs = [
      { uuid: 'a', name: 'a', meta: { width: 1000, height: 800 }, sensor, keypoints: [] },
      { uuid: 'b', name: 'b', meta: { width: 1000, height: 800, focalLength35: 35 }, sensor: null, keypoints: [{ x: 900, y: 700 }] },
    ]
    const ideal = [{ x: 900, y: 700 }, { x: 100, y: 50 }]
    const { Kmap } = resolveIntrinsics({ imgs, intrinsicsRecord: new Map(), log: quiet })
    imgs[0].keypoints = ideal.map((p) => ({ ...distortPixel(p.x, p.y, Kmap.get('a'), { k1: -0.1 }), color: [1, 2, 3] }))
    const { anyCalibratedDistortion, undistortedUuids } = undistortAtIngest({ imgs, Kmap, moveGcpObs: () => {}, log: quiet })
    expect(anyCalibratedDistortion).toBe(true)
    expect([...undistortedUuids]).toEqual(['a'])
    imgs[0].keypoints.forEach((kp, i) => {
      expect(kp.x).toBeCloseTo(ideal[i].x, 6)
      expect(kp.y).toBeCloseTo(ideal[i].y, 6)
      expect(kp.color).toEqual([1, 2, 3])
    })
    expect(imgs[1].keypoints).toEqual([{ x: 900, y: 700 }]) // no calibrated distortion: untouched
  })

  it('refits F only on pairs that touch a moved image', () => {
    // Pure x-translation between two views: F ∝ [[0,0,0],[0,0,-1],[0,1,0]].
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: (i * 37) % 300, y: (i * 53) % 200 }))
    const imgs = new Map([
      ['a', { keypoints: pts }], ['b', { keypoints: pts.map((p) => ({ x: p.x + 30, y: p.y })) }],
      ['c', { keypoints: pts }],
    ])
    const matches = new Uint32PairList(packMatchPairs(pts.map((_, i) => [i, i])))
    const stale = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const ab = { idA: 'a', idB: 'b', F: stale, matches }, bc = { idA: 'b', idB: 'c', F: stale, matches }
    refitMovedPairs({ donePairs: [ab, bc], movedUuids: new Set(['a']), imageByUuid: (u) => imgs.get(u), log: quiet })
    expect(ab.F).not.toBe(stale)
    expect(bc.F).toBe(stale)
  })
})

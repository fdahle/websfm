import { describe, expect, it } from 'vitest'
import { sparseSnapshot, createSnapshotPacer } from './liveSnapshot.js'
import { tracksFrom } from './trackStore.testutil.js'

const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const K = { fx: 100, fy: 100, cx: 50, cy: 50 }

describe('sparseSnapshot', () => {
  it('copies the cameras and the points seen twice or more', () => {
    const { tracks } = tracksFrom(
      [
        {
          x: 1,
          y: 2,
          z: 3,
          views: new Map([
            ['a', 0],
            ['b', 0],
          ]),
        },
        { x: 9, y: 9, z: 9, views: new Map([['a', 1]]) },
        {
          x: 4,
          y: 5,
          z: 6,
          views: new Map([
            ['a', 2],
            ['b', 2],
          ]),
        },
      ],
      ['a', 'b'],
    )
    const cameras = new Map([
      ['a', { R: I, t: [0, 0, 0], K }],
      ['b', { R: I, t: [1, 0, 0], K }],
    ])
    const snap = sparseSnapshot(cameras, tracks)
    expect([...snap.pos]).toEqual([1, 2, 3, 4, 5, 6])
    expect(snap.cameras.map((c) => c.uuid)).toEqual(['a', 'b'])
    // A copy: the solver keeps moving its own.
    expect(snap.cameras[1].t).not.toBe(cameras.get('b').t)
    expect(snap.cameras[1].R[0]).not.toBe(I[0])
  })

  it('colours a point from its first coloured view, or sends no colour at all', () => {
    const { tracks, ids } = tracksFrom(
      [
        {
          x: 0,
          y: 0,
          z: 0,
          views: new Map([
            ['a', 0],
            ['b', 1],
          ]),
        },
      ],
      ['a', 'b'],
    )
    const sets = [
      { hasColor: new Uint8Array([0, 0]), rgb: new Uint8Array(6) },
      { hasColor: new Uint8Array([0, 1]), rgb: new Uint8Array([0, 0, 0, 10, 20, 30]) },
    ]
    expect([...sparseSnapshot(new Map(), tracks, { keypointsAt: (img) => sets[img] }).col]).toEqual([10, 20, 30])
    expect(sparseSnapshot(new Map(), tracks, { keypointsAt: () => null }).col).toBeNull()
    expect(sparseSnapshot(new Map(), tracks).col).toBeNull()
    expect(ids.uuid(0)).toBe('a')
  })

  it('thins a big model evenly to the cap', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({
      x: i,
      y: 0,
      z: 0,
      views: new Map([
        ['a', i],
        ['b', i],
      ]),
    }))
    const { tracks } = tracksFrom(pts, ['a', 'b'], { kpCount: 1000 })
    const snap = sparseSnapshot(new Map(), tracks, { maxPoints: 100 })
    expect(snap.pos.length).toBe(300)
    expect(snap.pos[0]).toBe(0)
    expect(snap.pos[3 * 99]).toBe(990)
  })
})

describe('createSnapshotPacer', () => {
  it('sends on the first tick, then at most once per interval', () => {
    let t = 0
    const sent = []
    const pacer = createSnapshotPacer(
      (s) => sent.push(s.t),
      () => ({ t }),
      { intervalMs: 2000, now: () => t },
    )
    pacer.tick()
    t = 1000
    pacer.tick()
    t = 2500
    pacer.tick()
    t = 2600
    pacer.tick({ force: true })
    expect(sent).toEqual([0, 2500, 2600])
  })
  it('skips a snapshot with nothing to draw without spending the interval', () => {
    let t = 0,
      ready = false
    const sent = []
    const pacer = createSnapshotPacer(
      (s) => sent.push(s.t),
      () => (ready ? { t } : null),
      { intervalMs: 2000, now: () => t },
    )
    pacer.tick()
    ready = true
    t = 10
    pacer.tick()
    expect(sent).toEqual([10])
  })
  it('does nothing without a receiver', () => {
    let built = 0
    createSnapshotPacer(null, () => built++).tick()
    expect(built).toBe(0)
  })
})

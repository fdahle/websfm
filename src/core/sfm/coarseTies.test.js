import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { splitCoarseTies, retriangulatePoints } from './coarseTies.js'
import { keypointSetFrom } from './keypointSet.js'
import { tracksFrom } from './trackStore.testutil.js'
import { aerialBlock } from './syntheticScene.testutil.js'
import { reconstruct } from './sfm.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

// Images whose keypoint k has scale `scales[k]` (positions don't matter for the split).
const setsOf = (scalesPerImage) =>
  scalesPerImage.map((scales) =>
    keypointSetFrom(scales.map((s, k) => ({ x: k, y: k, ...(s == null ? {} : { scale: s }) }))),
  )

describe('splitCoarseTies', () => {
  // Image a: finest scale 1; image b: every scale doubled (finest 2), so the same
  // keypoint index has the same ratio to its photo's finest in both.
  const scales = [1, 1.2, 1.25, 1.5, 2, 4]
  const sets = setsOf([scales, scales.map((s) => 2 * s)])
  const pt = (ka, kb) => ({
    x: 0,
    y: 0,
    z: 0,
    views: new Map([
      ['a', ka],
      ['b', kb],
    ]),
  })

  it('leaves out the points whose median scale ratio exceeds the threshold, relative to each photo', () => {
    // Ratios per point: (1, 1) (1.2, 1.25) (1.25, 1.5) (1.5, 2) (4, 1).
    const { tracks } = tracksFrom([pt(0, 0), pt(1, 2), pt(2, 3), pt(3, 4), pt(5, 0)], ['a', 'b'], { kpCount: 6 })
    const ids = tracks.liveIds()
    const r = splitCoarseTies(tracks, ids, (img) => sets[img], { maxRatio: 1.3 })
    expect(r.active).toBe(true)
    // Two views: the upper median is the larger ratio. 1.25 ≤ 1.3 stays; 1.5, 2 and 4 go.
    expect([...r.keep]).toEqual([ids[0], ids[1]])
    expect([...r.out]).toEqual([ids[2], ids[3], ids[4]])
    expect(r.stats).toMatchObject({ points: 5, pointsKept: 2, obs: 10, obsKept: 4, s0Median: 2, relaxed: 0 })
    // An absolute threshold would split the two photos differently: the relative one does not.
    const { tracks: t2 } = tracksFrom([pt(1, 1)], ['a', 'b'], { kpCount: 6 })
    expect(splitCoarseTies(t2, t2.liveIds(), (img) => sets[img], { maxRatio: 1.3 }).out.length).toBe(0)
  })

  it('does nothing without keypoint scales (learned detectors)', () => {
    const none = setsOf([scales.map(() => null), scales.map(() => null)])
    const { tracks } = tracksFrom([pt(0, 0), pt(5, 5)], ['a', 'b'], { kpCount: 6 })
    const ids = tracks.liveIds()
    const r = splitCoarseTies(tracks, ids, (img) => none[img], { maxRatio: 1.3 })
    expect(r.active).toBe(false)
    expect(r.keep).toBe(ids)
    expect(r.out.length).toBe(0)
  })

  it('keeps the finest points of a photo that would fall under the minimum', () => {
    // Photo c sees only coarse points (ratios 2, 3, 4 against its finest keypoint, 1),
    // photo a sees them and four fine ones.
    const sc = setsOf([
      [1, 1, 1, 1, 2, 3, 4],
      [1, 2, 3, 4],
    ])
    const v = (ka, kc) =>
      new Map(
        kc == null
          ? [['a', ka]]
          : [
              ['a', ka],
              ['c', kc],
            ],
      )
    const fine = (k) => ({ x: 0, y: 0, z: 0, views: new Map([['a', k]]) })
    const pts = [
      fine(0),
      fine(1),
      fine(2),
      fine(3),
      ...[4, 5, 6].map((k, i) => ({ x: 0, y: 0, z: 0, views: v(k, i + 1) })),
    ]
    const { tracks } = tracksFrom(pts, ['a', 'c'], { kpCount: 7 })
    const ids = tracks.liveIds()
    const plain = splitCoarseTies(tracks, ids, (img) => sc[img], { maxRatio: 1.3 })
    expect(plain.stats.pointsKept).toBe(4)
    const guarded = splitCoarseTies(tracks, ids, (img) => sc[img], { maxRatio: 1.3, minObsPerPhoto: 2 })
    // Photo c keeps its two finest (ratio 2 and 3), photo a needs no relaxing.
    expect(guarded.stats.relaxed).toBe(1)
    expect(guarded.stats.relaxedMaxRatio).toBe(3)
    expect([...guarded.out]).toEqual([ids[6]])
    expect(guarded.stats.obsPerPhotoMin).toBe(2)
  })
})

describe('retriangulatePoints', () => {
  it('moves a point back to where its views meet', () => {
    const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
    // Nadir cameras at height 100 along x; world point on the ground.
    const R = [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ]
    const cams = [-20, 0, 25].map((cx) => ({ R, t: [-cx, 0, 100], K }))
    const X = [3, -4, 1.5]
    const proj = (c) => {
      const xc = c.R[0][0] * X[0] + c.t[0],
        yc = c.R[1][1] * X[1] + c.t[1],
        zc = c.R[2][2] * X[2] + c.t[2]
      return { x: K.fx * (xc / zc) + K.cx, y: K.fy * (yc / zc) + K.cy }
    }
    const sets = cams.map((c) => keypointSetFrom([proj(c)]))
    const uuids = ['a', 'b', 'c']
    const { tracks, ids } = tracksFrom(
      [{ x: X[0] + 0.7, y: X[1] - 0.4, z: X[2] + 2, views: new Map(uuids.map((u) => [u, 0])) }],
      uuids,
      { kpCount: 1 },
    )
    const cameras = new Map(uuids.map((u, i) => [u, cams[i]]))
    const moved = retriangulatePoints(tracks, tracks.liveIds(), { cameras, ids, keypointsAt: (img) => sets[img] })
    expect(moved).toBe(1)
    const p = tracks.liveIds()[0]
    expect(Math.hypot(tracks.x(p) - X[0], tracks.y(p) - X[1], tracks.z(p) - X[2])).toBeLessThan(1e-6)
  })
})

// Known truth end to end: half the terrain points are found at a coarse scale whose
// keypoints sit 0.4 % of the radius further out (a focal-like shift no residual tells
// from the fine points'), with camera positions in the solve. Held to the positions, the
// coarse points pull the self-calibrated focal (and with it the heights); left out of the
// held solves, the focal comes out as the fine points have it. The cloud
// keeps every point either way.
describe('coarse tie points out of the held solves', () => {
  const sc = aerialBlock({
    seed: 17,
    rows: 4,
    cols: 6,
    nPoints: 2500,
    priors: true,
    dist: { k1: 0, k2: 0 },
    coarse: { frac: 0.5, scale: 3, shift: 0.004 },
  })
  const run = (heldTieMaxScaleRatio, cameraPriors = sc.cameraPriors) =>
    reconstruct(
      {
        images: sc.images,
        pairs: sc.pairs,
        cameraPriors,
        settings: { secondaryModels: false, heldTieMaxScaleRatio, heldTieMinObsPerPhoto: 0 },
      },
      { onLog: () => {} },
    )
  const fxErr = (out) => Math.abs(out.cameras[0].K.fx / sc.truth.Ktrue.fx - 1)

  it('recovers the focal that the fine keypoints give', async () => {
    const off = await run(0)
    const on = await run(1.3)
    expect(off.status).toBe('done')
    expect(on.status).toBe('done')
    // Measured: 0.126 % off, 0.025 % on.
    expect(fxErr(on)).toBeLessThan(fxErr(off) / 3)
    // The cloud keeps the coarse points.
    expect(on.summary.nPoints).toBeGreaterThan(0.95 * off.summary.nPoints)
  }, 180_000)

  it('leaves a block held only by loose positions (consumer GNSS) as it was', async () => {
    const loose = sc.cameraPriors.map((p) => ({ ...p, accuracyX: 5, accuracyY: 5, accuracyZ: 8 }))
    const off = await run(0, loose)
    const on = await run(1.3, loose)
    expect(on.cameras[0].K.fx).toBe(off.cameras[0].K.fx)
    expect(on.summary.nPoints).toBe(off.summary.nPoints)
  }, 180_000)
})

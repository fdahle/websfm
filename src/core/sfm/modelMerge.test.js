import { describe, it, expect } from 'vitest'
import {
  alignModels,
  fitModelAlignment,
  mergeModels,
  transformCamera,
  sharedPhotoPairs,
  gcpPairs,
  crossGeorefPairs,
} from './modelMerge.js'
import { cameraCenter } from './geometry.js'
import { SparsePoints } from './sparsePoints.js'

// Ground truth: one scene in A's frame. B is the same scene in B's own frame, which A's
// frame reaches through TRUE (B → A): s = 2.5, a rotation about a tilted axis, a shift.
const mul = (A, B) =>
  Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]),
  )
const tr = (R) => R[0].map((_, j) => R.map((r) => r[j]))
const mv = (R, p) => R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2])
const rotX = (a) => [
  [1, 0, 0],
  [0, Math.cos(a), -Math.sin(a)],
  [0, Math.sin(a), Math.cos(a)],
]
const rotZ = (a) => [
  [Math.cos(a), -Math.sin(a), 0],
  [Math.sin(a), Math.cos(a), 0],
  [0, 0, 1],
]
const TRUE = { scale: 2.5, R: mul(rotZ(0.7), rotX(0.3)), t: [100, -40, 12] }
const toA = (p) => mv(TRUE.R, p).map((v, i) => TRUE.scale * v + TRUE.t[i])
const toB = (p) => {
  const d = p.map((v, i) => (v - TRUE.t[i]) / TRUE.scale)
  return mv(tr(TRUE.R), d)
}
// A camera at centre C (A frame) looking down, turned by `yaw`.
const DOWN = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
]
const camA = (C, yaw = 0) => {
  const R = mul(DOWN, rotZ(yaw))
  return { R, t: mv(R, C).map((v) => -v), K: { fx: 1000, fy: 1000, cx: 500, cy: 400 } }
}
// The same camera expressed in B's frame: x_cam = R_A·X_A + t_A with X_A = s·Q·X_B + t.
const inB = (cam) => {
  const R = mul(cam.R, TRUE.R)
  const t = mv(cam.R, TRUE.t).map((v, i) => (v + cam.t[i]) / TRUE.scale)
  return { ...cam, R, t }
}
const near = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < tol)

// Block A: cameras a0..a5 along y = 0; block B: b0..b5 along y = 80, no overlap. Photos
// s0..s3 are in both (a strip between them), each project with its own uuid.
const centresA = Array.from({ length: 6 }, (_, i) => [i * 20, 0, 60])
const centresB = Array.from({ length: 6 }, (_, i) => [i * 20, 80, 61])
const centresS = [
  [0, 40, 60],
  [30, 42, 62],
  [60, 39, 59],
  [90, 41, 63],
]
function scene() {
  const camsA = new Map(centresA.map((C, i) => [`a${i}`, camA(C, 0.1 * i)]))
  const camsB = new Map(centresB.map((C, i) => [`b${i}`, inB(camA(C, -0.1 * i))]))
  centresS.forEach((C, i) => {
    camsA.set(`sA${i}`, camA(C, 0.2 * i))
    camsB.set(`sB${i}`, inB(camA(C, 0.2 * i)))
  })
  const sharedBtoA = new Map(centresS.map((_, i) => [`sB${i}`, `sA${i}`]))
  return { camsA, camsB, sharedBtoA }
}

describe('fitModelAlignment', () => {
  it('recovers the similarity from points known in both frames', () => {
    const ptsA = [
      [0, 0, 0],
      [50, 0, 3],
      [0, 70, -2],
      [40, 40, 10],
      [10, 90, 1],
    ]
    const fit = fitModelAlignment(ptsA.map((p) => ({ src: toB(p), dst: p })))
    expect(fit.accepted).toBe(true)
    expect(fit.sim.scale).toBeCloseTo(TRUE.scale, 9)
    for (const p of ptsA) expect(near(toA(toB(p)), p)).toBe(true)
    expect(fit.rmsFrac).toBeLessThan(1e-9)
  })

  it('refuses fewer than three, a line, and points that disagree', () => {
    expect(fitModelAlignment([{ src: [0, 0, 0], dst: [1, 1, 1] }]).accepted).toBe(false)
    const line = [0, 1, 2, 3].map((k) => ({ src: [k, k, k], dst: toA([k, k, k]) }))
    expect(fitModelAlignment(line).accepted).toBe(false)
    const ptsA = [
      [0, 0, 0],
      [50, 0, 3],
      [0, 70, -2],
      [40, 40, 10],
    ]
    const pairs = ptsA.map((p) => ({ src: toB(p), dst: p }))
    pairs[3] = { ...pairs[3], dst: [40, 40, 30] } // one point 20 m off
    const fit = fitModelAlignment(pairs)
    expect(fit.accepted).toBe(false)
    expect(fit.reason).toMatch(/disagree|scale/)
  })
})

describe('alignModels', () => {
  it('places B by the photos both projects solved, cameras and all', () => {
    const { camsA, camsB, sharedBtoA } = scene()
    const r = alignModels({ camsA, camsB, sharedBtoA }, 'photos')
    expect(r.accepted).toBe(true)
    expect(r.method).toBe('photos')
    expect(r.rotation.worstDeg).toBeLessThan(1e-6)
    // Every B camera lands on its true centre and rotation in A's frame.
    centresB.forEach((C, i) => {
      const moved = transformCamera(camsB.get(`b${i}`), r.sim)
      expect(near(cameraCenter(moved), C)).toBe(true)
      const truth = camA(C, -0.1 * i)
      expect(near(moved.R.flat(), truth.R.flat())).toBe(true)
    })
  })

  it('a rolling-shutter camera’s velocity moves with the model', () => {
    // A camera flying from C to C + v·1 s in A's frame; the same in B's frame.
    const C = [10, 20, 60],
      vA = [8, -3, 0.5]
    const camB = {
      ...inB(camA(C)),
      rs: { v: toB(vA.map((x, i) => C[i] + x)).map((x, i) => x - toB(C)[i]), h: 3000, tau: 0.02 },
    }
    const moved = transformCamera(camB, TRUE)
    expect(near(moved.rs.v, vA)).toBe(true)
    expect(moved.rs.tau).toBe(0.02)
  })

  it('refuses shared photos whose directions disagree', () => {
    const { camsA, camsB, sharedBtoA } = scene()
    const c = camsA.get('sA1')
    const R = mul(c.R, rotZ(0.5)) // same centre, turned 29°
    camsA.set('sA1', { ...c, R, t: mv(R, centresS[1]).map((v) => -v) })
    const r = alignModels({ camsA, camsB, sharedBtoA }, 'photos')
    expect(r.accepted).toBe(false)
    expect(r.tried[0].reason).toMatch(/directions disagree/)
  })

  it('places B by GCPs or markers triangulated in both', () => {
    const gcp = { g1: [5, 30, 0], g2: [80, 35, 2], g3: [40, 100, -1], g4: [100, 90, 4] }
    const triA = new Map(Object.entries(gcp))
    const triB = new Map(Object.entries(gcp).map(([k, p]) => [k, toB(p)]))
    triB.set('onlyB', [1, 2, 3])
    expect(gcpPairs(triA, triB)).toHaveLength(4)
    const r = alignModels({ triA, triB }, 'gcps')
    expect(r.accepted).toBe(true)
    expect(r.n).toBe(4)
    for (const p of Object.values(gcp)) {
      const b = toB(p)
      const s = r.sim
      const back = mv(s.R, b).map((v, i) => s.scale * v + s.t[i])
      expect(near(back, p)).toBe(true)
    }
  })

  it('places B through both georeferences', () => {
    const { camsB } = scene()
    const pairs = crossGeorefPairs(camsB, toA)
    expect(pairs).toHaveLength(camsB.size)
    const r = alignModels({ camsB, toA }, 'georef')
    expect(r.accepted).toBe(true)
    expect(r.sim.scale).toBeCloseTo(TRUE.scale, 9)
  })

  it('auto takes the first way that works and says why the others did not', () => {
    const { camsB } = scene()
    const triA = new Map([['g1', [0, 0, 0]]])
    const triB = new Map([['g1', toB([0, 0, 0])]])
    const r = alignModels({ camsA: new Map(), camsB, sharedBtoA: new Map(), triA, triB, toA }, 'auto')
    expect(r.accepted).toBe(true)
    expect(r.method).toBe('georef')
    expect(r.tried.map((t) => t.method)).toEqual(['photos', 'gcps', 'georef'])
    expect(r.tried[0].reason).toMatch(/no photo/)
    expect(r.tried[1].reason).toMatch(/1 of the 3/)
  })

  it('shared photos come first when they work', () => {
    const { camsA, camsB, sharedBtoA } = scene()
    const r = alignModels({ camsA, camsB, sharedBtoA, toA }, 'auto')
    expect(r.method).toBe('photos')
    expect(sharedPhotoPairs(camsA, camsB, sharedBtoA)).toHaveLength(4)
  })
})

describe('mergeModels', () => {
  // B's points: one on two B-only photos, one seen by b0 and a shared photo only
  // (left with one view: goes), one by b0, b1 and a shared photo (keeps two views).
  function bModel() {
    const { camsB } = scene()
    const P = [
      [10, 80, 0],
      [20, 85, 1],
      [30, 70, -1],
    ].map(toB)
    const points = SparsePoints.fromRecords([
      {
        x: P[0][0],
        y: P[0][1],
        z: P[0][2],
        color: [10, 20, 30],
        views: [
          ['b0', 5, 100, 100],
          ['b1', 7, 120, 90],
        ],
      },
      {
        x: P[1][0],
        y: P[1][1],
        z: P[1][2],
        views: [
          ['b0', 6, 1, 1],
          ['sB0', 9, 2, 2],
        ],
      },
      {
        x: P[2][0],
        y: P[2][1],
        z: P[2][2],
        views: [
          ['b0', 8, 3, 3],
          ['sB1', 1, 4, 4],
          ['b1', 2, 5, 5],
        ],
      },
    ])
    const calibration = {
      source: 'run',
      groups: [
        { sensorId: 'cam', dist: { k1: -0.1, k2: 0.02, k3: 0, p1: 0, p2: 0 }, selfCal: null, focalSigmaPx: 0.4 },
      ],
      fiducialTransforms: [{ uuid: 'b1', A: [1, 0, 0, 1, 0, 0], frame: 'f' }],
    }
    return { cameras: camsB, points, calibration }
  }

  it('brings B into A: A keeps its cameras, B its lens, tracks without shared views', () => {
    const { camsA, sharedBtoA } = scene()
    const a = {
      cameras: camsA,
      points: SparsePoints.fromRecords([
        {
          x: 0,
          y: 0,
          z: 0,
          views: [
            ['a0', 1],
            ['a1', 2],
          ],
        },
      ]),
      calibration: { source: 'run', groups: [{ sensorId: 'cam', dist: { k1: 0.05 }, selfCal: null }] },
    }
    const b = bModel()
    const sensorOfB = new Map([...b.cameras.keys()].map((u) => [u, 'cam']))
    const r = alignModels({ camsA, camsB: b.cameras, sharedBtoA }, 'photos')
    const m = mergeModels(a, b, { sim: r.sim, sharedBtoA, sensorOfB })

    expect(m.cameras.size).toBe(camsA.size + 6) // b0..b5; the four shared photos stay A's
    expect(m.cameras.get('sA0')).toBe(camsA.get('sA0'))
    expect(near(cameraCenter(m.cameras.get('b3')), centresB[3])).toBe(true)
    expect(m.added).toEqual({ cameras: 6, points: 2 })
    expect(m.dropped).toEqual({ cameras: 4, views: 2, points: 1 })

    expect(m.points.length).toBe(3)
    expect(near(m.points.xyz(1), [10, 80, 0])).toBe(true)
    expect(near(m.points.xyz(2), [30, 70, -1])).toBe(true)
    const views = []
    m.points.forEachView(2, (u, kp, px) => views.push([u, kp, px]))
    expect(views).toEqual([
      ['b0', 8, 3],
      ['b1', 2, 5],
    ])
    expect(m.points.colorAt(1)).toEqual([10, 20, 30])

    // A's sensor group stays; each B camera has B's lens as its own group.
    const groups = m.calibration.groups
    expect(groups[0]).toEqual(a.calibration.groups[0])
    const b2 = groups.find((g) => g.imageUuid === 'b2')
    expect(b2).toEqual({
      imageUuid: 'b2',
      dist: { k1: -0.1, k2: 0.02, k3: 0, p1: 0, p2: 0 },
      selfCal: null,
      focalSigmaPx: 0.4,
    })
    expect(groups.some((g) => g.imageUuid === 'sB0' || g.imageUuid === 'sA0')).toBe(false)
    expect(m.calibration.fiducialTransforms).toEqual([{ uuid: 'b1', A: [1, 0, 0, 1, 0, 0], frame: 'f' }])
  })

  it('B alone (no model here yet) comes in as it is, shared photos under A’s uuid', () => {
    const b = bModel()
    const sharedBtoA = new Map([['sB0', 'sA0']])
    const m = mergeModels(null, b, { sharedBtoA })
    expect(m.cameras.has('sA0')).toBe(true)
    expect(m.cameras.has('sB0')).toBe(false)
    expect(m.cameras.get('b0')).toBe(b.cameras.get('b0'))
    expect(m.added.cameras).toBe(b.cameras.size)
  })
})

describe('SparsePoints.withoutViews', () => {
  it('drops the views and the points left with too few', () => {
    const p = SparsePoints.fromRecords([
      {
        x: 1,
        y: 2,
        z: 3,
        views: [
          ['u', 1],
          ['v', 2],
          ['w', 3],
        ],
      },
      {
        x: 4,
        y: 5,
        z: 6,
        views: [
          ['u', 4],
          ['w', 5],
        ],
      },
    ])
    const { points, kept } = p.withoutViews(new Set(['w']), 2)
    expect([...kept]).toEqual([0])
    expect(points.length).toBe(1)
    expect(points.xyz(0)).toEqual([1, 2, 3])
    const v = []
    points.forEachView(0, (u, kp) => v.push([u, kp]))
    expect(v).toEqual([
      ['u', 1],
      ['v', 2],
    ])
  })
})

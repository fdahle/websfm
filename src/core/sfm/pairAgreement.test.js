import { describe, it, expect } from 'vitest'
import {
  fundamentalFromPoses,
  scorePairAgreement,
  findSuspectPairs,
  PAIR_AGREES,
  PAIR_CONFLICTS,
  PAIR_UNSCORED,
} from './pairAgreement.js'
import { keypointSetFrom } from './keypointSet.js'
import { projectPoint } from './geometry.js'

// Rodrigues: rotation by `angle` about unit-normalised `axis`.
function rot(axis, angle) {
  const n = Math.hypot(...axis)
  const [x, y, z] = axis.map((v) => v / n)
  const c = Math.cos(angle),
    s = Math.sin(angle),
    C = 1 - c
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ]
}
// A camera at centre C with rotation R: t = −R·C.
const camAt = (C, R = rot([0, 0, 1], 0), K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }) => ({
  R,
  t: [0, 1, 2].map((i) => -(R[i][0] * C[0] + R[i][1] * C[1] + R[i][2] * C[2])),
  K,
})

// Deterministic pseudo-random numbers (mulberry32).
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TUNING = { epiTolPx: 4, agreeFrac: 0.5, minSplit: 5, minMatches: 15 }

// Points in front of three cameras along x, all looking down +z, slightly turned.
// Keypoint k of every photo observes point k (so a true match is (k, k)).
function scene({ nPoints = 120, extra = [] } = {}) {
  const r = rng(7)
  const pts = Array.from({ length: nPoints }, () => [r() * 8 - 4, r() * 6 - 3, 9 + r() * 4])
  for (const p of extra) pts.push(p)
  const cams = {
    a: camAt([0, 0, 0], rot([0, 1, 0], 0.05)),
    b: camAt([1.5, 0.2, 0], rot([0.2, 1, 0], -0.08)),
    c: camAt([3, -0.1, 0.3], rot([1, 0.3, 0], 0.04)),
  }
  const kps = {}
  for (const [id, cam] of Object.entries(cams)) {
    kps[id] = keypointSetFrom(
      pts.map(([x, y, z]) => {
        const p = projectPoint(cam, x, y, z)
        return { x: p.u, y: p.v }
      }),
    )
  }
  return { pts, cams, kps }
}
const ids = (n, f = (k) => [k, k]) => Array.from({ length: n }, (_, k) => f(k))

describe('fundamentalFromPoses', () => {
  it('puts every projected point on its epipolar line, for turned cameras', () => {
    const { pts, cams, kps } = scene()
    const F = fundamentalFromPoses(cams.a, cams.c)
    const scale = Math.hypot(...F.flat())
    for (let k = 0; k < pts.length; k++) {
      const xa = [kps.a.xy[2 * k], kps.a.xy[2 * k + 1], 1]
      const xb = [kps.c.xy[2 * k], kps.c.xy[2 * k + 1], 1]
      const Fx = [0, 1, 2].map((i) => F[i][0] * xa[0] + F[i][1] * xa[1] + F[i][2])
      expect(Math.abs(xb[0] * Fx[0] + xb[1] * Fx[1] + Fx[2]) / scale).toBeLessThan(1e-9)
    }
  })

  it('is null for two cameras at the same centre (no baseline)', () => {
    expect(fundamentalFromPoses(camAt([1, 2, 3]), camAt([1, 2, 3], rot([0, 1, 0], 0.3)))).toBeNull()
  })
})

describe('scorePairAgreement', () => {
  const run = (s, pairs, { inModel = () => true, cameras = s.cams } = {}) =>
    scorePairAgreement({
      pairs,
      cameraOf: (u) => cameras[u] ?? null,
      keypointsOf: (u) => s.kps[u],
      pointOf: (_u, k) => (inModel(k) ? k : -1),
      ...TUNING,
    })

  it('a true pair agrees: its matches on one point each, at zero epipolar error', () => {
    const s = scene()
    const [r] = run(s, [{ idA: 'a', idB: 'b', matches: ids(120) }], { inModel: (k) => k % 5 !== 0 })
    expect(r).toMatchObject({ n: 120, inModel: 96, split: 0, status: PAIR_AGREES, epiAgreeFrac: 1 })
    expect(r.epiMedianPx).toBeLessThan(1e-6)
  })

  it('a false pair conflicts: shuffled matches are off their epipolar lines and join different points', () => {
    const s = scene()
    // Each keypoint of a matched to the keypoint of a point 37 further on: a derangement.
    const [r] = run(s, [{ idA: 'a', idB: 'c', matches: ids(120, (k) => [k, (k + 37) % 120]) }])
    expect(r.status).toBe(PAIR_CONFLICTS)
    expect(r.split).toBe(120)
    expect(r.inModel).toBe(0)
    expect(r.epiAgreeFrac).toBeLessThan(0.5)
  })

  it('a false pair along the epipolar line is caught by the split count', () => {
    // Point 60 + k lies on photo a's ray through point k, 30 % deeper: matching a's
    // keypoint k to b's keypoint 60 + k satisfies the epipolar geometry exactly.
    // Photo a's centre is the origin, so 1.3 × a point lies on a's ray through it.
    const base = scene({ nPoints: 60 })
    const deeper = base.pts.map(([x, y, z]) => [x * 1.3, y * 1.3, z * 1.3])
    const s = scene({ nPoints: 60, extra: deeper })
    const [r] = run(s, [{ idA: 'a', idB: 'b', matches: ids(60, (k) => [k, 60 + k]) }])
    expect(r.epiAgreeFrac).toBe(1)
    expect(r.split).toBe(60)
    expect(r.status).toBe(PAIR_CONFLICTS)
  })

  it('a pair with a photo outside the model, or too few matches, is unscored', () => {
    const s = scene()
    const [out, few] = run(
      s,
      [
        { idA: 'a', idB: 'b', matches: ids(120) },
        { idA: 'a', idB: 'c', matches: ids(14) },
      ],
      { cameras: { a: s.cams.a, c: s.cams.c } },
    )
    expect(out.status).toBe(PAIR_UNSCORED)
    expect(few).toMatchObject({ n: 14, status: PAIR_UNSCORED })
  })

  it('leaves out matches on a keypoint dropped at ingest (NaN)', () => {
    const s = scene()
    const xy = s.kps.b.xy.slice()
    for (let k = 0; k < 20; k++) xy[2 * k] = NaN
    s.kps.b = { ...s.kps.b, xy }
    const [r] = run(s, [{ idA: 'a', idB: 'b', matches: ids(120) }])
    expect(r).toMatchObject({ n: 100, inModel: 100, status: PAIR_AGREES })
  })

  it('without a baseline, decides by the points alone', () => {
    const s = scene()
    const cameras = { a: s.cams.a, b: camAt([0, 0, 0], rot([0, 1, 0], 0.2)) }
    const [same, split] = run(
      s,
      [
        { idA: 'a', idB: 'b', matches: ids(40) },
        { idA: 'a', idB: 'b', matches: ids(40, (k) => [k, k + 40]) },
      ],
      { cameras },
    )
    expect(same).toMatchObject({ status: PAIR_AGREES, epiMedianPx: null })
    expect(split).toMatchObject({ status: PAIR_CONFLICTS, split: 40 })
  })
})

describe('findSuspectPairs', () => {
  const S = (idA, idB, status, n = 100) => ({ idA, idB, status, n })
  const opts = { contestedFrac: 0.5, minPairs: 2 }

  it('names the pair that holds a misplaced photo, not the true pairs it contradicts', () => {
    // X was placed by a false pair with Y; its three true pairs now conflict with the
    // model. Y and the Z photos sit well among themselves.
    const scores = [
      S('X', 'Y', PAIR_AGREES, 40),
      S('X', 'Z1', PAIR_CONFLICTS),
      S('X', 'Z2', PAIR_CONFLICTS),
      S('X', 'Z3', PAIR_CONFLICTS),
      S('Y', 'Z1', PAIR_AGREES, 300),
      S('Z1', 'Z2', PAIR_AGREES, 300),
      S('Z2', 'Z3', PAIR_AGREES, 300),
      S('Z3', 'Y', PAIR_AGREES, 300),
    ]
    const { photos, suspects } = findSuspectPairs(scores, opts)
    expect(photos.get('X').contested).toBe(true)
    expect(['Y', 'Z1', 'Z2', 'Z3'].some((u) => photos.get(u).contested)).toBe(false)
    expect(suspects).toEqual([
      { index: 0, idA: 'X', idB: 'Y', reason: 'holds', photo: 'X', conflictShare: 300 / 340, weight: 40 },
    ])
  })

  it('names a false pair the model overruled, between two photos that sit well', () => {
    const scores = [
      S('A', 'B', PAIR_CONFLICTS, 30),
      S('A', 'C', PAIR_AGREES, 300),
      S('B', 'C', PAIR_AGREES, 300),
      S('B', 'D', PAIR_AGREES, 300),
    ]
    const { suspects } = findSuspectPairs(scores, opts)
    expect(suspects).toEqual([
      { index: 0, idA: 'A', idB: 'B', reason: 'contradicts', photo: null, conflictShare: 0, weight: 30 },
    ])
  })

  it('a model where every scored pair agrees has no suspects; unscored pairs count for nothing', () => {
    const scores = [S('A', 'B', PAIR_AGREES), S('B', 'C', PAIR_AGREES), S('A', 'Q', PAIR_UNSCORED)]
    const { photos, suspects } = findSuspectPairs(scores, opts)
    expect(suspects).toEqual([])
    expect(photos.has('Q')).toBe(false)
  })

  it('a photo with fewer scored pairs than minPairs is never contested', () => {
    // E has one pair, and it conflicts: that is the pair's word against nothing.
    const scores = [S('E', 'F', PAIR_CONFLICTS), S('F', 'G', PAIR_AGREES, 300), S('F', 'H', PAIR_AGREES, 300)]
    const { photos, suspects } = findSuspectPairs(scores, opts)
    expect(photos.get('E').contested).toBe(false)
    expect(suspects.map((s) => s.reason)).toEqual(['contradicts'])
  })

  it('ranks the most contested photo first', () => {
    const scores = [
      // P: holder 50, conflicts 400 → 0.89; Q: holder 50, conflicts 100 → 0.67
      S('P', 'H1', PAIR_AGREES, 50),
      S('P', 'W1', PAIR_CONFLICTS, 200),
      S('P', 'W2', PAIR_CONFLICTS, 200),
      S('Q', 'H2', PAIR_AGREES, 50),
      S('Q', 'W3', PAIR_CONFLICTS, 100),
      ...['H1', 'H2', 'W1', 'W2', 'W3'].flatMap((u, i, all) => [S(u, all[(i + 1) % all.length], PAIR_AGREES, 1000)]),
    ]
    const holds = findSuspectPairs(scores, opts).suspects.filter((s) => s.reason === 'holds')
    expect(holds.map((s) => s.photo)).toEqual(['P', 'Q'])
  })
})

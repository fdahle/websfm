import { describe, it, expect } from 'vitest'
import {
  fundamentalFromPoses,
  scorePairAgreement,
  findSuspectPairs,
  median,
  mergePairScores,
  packPairCheck,
  describePairCheck,
  pairCheckToBuffer,
  pairCheckFromBuffer,
  pairCheckVerdicts,
  SUSPECT_HOLDS,
  SUSPECT_CONTRADICTS,
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
      pointsOf: () => (k) => (inModel(k) ? k : -1),
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
      {
        index: 0,
        idA: 'X',
        idB: 'Y',
        reason: 'holds',
        photo: 'X',
        conflicts: 3,
        pairs: 4,
        conflictShare: 0.75,
        weight: 40,
      },
    ])
  })

  it('a strong false pair that lost does not turn the photo against its true pairs', () => {
    // Y keeps its place on three thin true pairs; the false pair X–Y has more matches
    // than all three together but is one witness against three (Aukerman, planted).
    const scores = [
      S('Y', 'Z1', PAIR_AGREES, 20),
      S('Y', 'Z2', PAIR_AGREES, 20),
      S('Y', 'Z3', PAIR_AGREES, 20),
      S('X', 'Y', PAIR_CONFLICTS, 190),
      S('Z1', 'Z2', PAIR_AGREES, 300),
      S('Z2', 'Z3', PAIR_AGREES, 300),
      S('X', 'W1', PAIR_AGREES, 300),
      S('X', 'W2', PAIR_AGREES, 300),
    ]
    const { photos, suspects } = findSuspectPairs(scores, opts)
    expect(photos.get('Y').contested).toBe(false)
    expect(suspects.map((x) => [x.idA, x.idB, x.reason])).toEqual([['X', 'Y', 'contradicts']])
  })

  it('a photo with many agreeing pairs is not held by any of them, however many false pairs it has', () => {
    // A photo at the crossing of two laps past a repeated façade: 3 true pairs, 4 false.
    const scores = [
      ...['N1', 'N2', 'N3'].map((u) => S('P', u, PAIR_AGREES, 200)),
      ...['F1', 'F2', 'F3', 'F4'].map((u) => S('P', u, PAIR_CONFLICTS, 20)),
    ]
    expect(findSuspectPairs(scores, { ...opts, maxHolders: 2 }).photos.get('P').contested).toBe(false)
    expect(findSuspectPairs(scores, opts).photos.get('P').contested).toBe(true) // without the cap
  })

  it('one pair against one decides nothing', () => {
    const scores = [S('Y', 'Z', PAIR_AGREES, 50), S('X', 'Y', PAIR_CONFLICTS, 50), S('Z', 'W', PAIR_AGREES, 300)]
    expect(findSuspectPairs(scores, opts).photos.get('Y').contested).toBe(false)
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
      {
        index: 0,
        idA: 'A',
        idB: 'B',
        reason: 'contradicts',
        photo: null,
        conflicts: 0,
        pairs: 0,
        conflictShare: 0,
        weight: 30,
      },
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
      // P: 1 agreeing, 3 conflicting pairs → 0.75; Q: 1 agreeing, 2 conflicting → 0.67
      S('P', 'H1', PAIR_AGREES, 50),
      S('P', 'W1', PAIR_CONFLICTS, 200),
      S('P', 'W2', PAIR_CONFLICTS, 200),
      S('P', 'W3', PAIR_CONFLICTS, 200),
      S('Q', 'H2', PAIR_AGREES, 50),
      S('Q', 'W1', PAIR_CONFLICTS, 100),
      S('Q', 'W2', PAIR_CONFLICTS, 100),
      ...['H1', 'H2', 'W1', 'W2', 'W3'].flatMap((u, i, all) => [
        S(u, all[(i + 1) % all.length], PAIR_AGREES, 1000),
        S(u, all[(i + 2) % all.length], PAIR_AGREES, 1000),
        S(u, all[(i + 3) % all.length], PAIR_AGREES, 1000),
      ]),
    ]
    const holds = findSuspectPairs(scores, opts).suspects.filter((s) => s.reason === 'holds')
    expect(holds.map((s) => s.photo)).toEqual(['P', 'Q'])
  })
})

describe('mergePairScores', () => {
  it('adds the pairs only the merged model scored; a pair both scored keeps the primary score', () => {
    const p = [{ idA: 'a', idB: 'b', status: PAIR_AGREES, n: 50 }]
    const s = [
      { idA: 'b', idB: 'a', status: PAIR_CONFLICTS, n: 50 },
      { idA: 'b', idB: 'c', status: PAIR_AGREES, n: 60 },
    ]
    expect(mergePairScores(p, s).map((x) => [x.idA, x.idB, x.status])).toEqual([
      ['a', 'b', PAIR_AGREES],
      ['b', 'c', PAIR_AGREES],
    ])
  })
})

describe('packPairCheck', () => {
  it('keeps each pair in its columns with its suspect and the photo it holds', () => {
    const S = (idA, idB, status, n) => ({
      idA,
      idB,
      status,
      n,
      inModel: n,
      split: 0,
      epiMedianPx: null,
      epiAgreeFrac: 1,
    })
    const scores = [
      S('X', 'Y', PAIR_AGREES, 40),
      S('X', 'Z1', PAIR_CONFLICTS, 100),
      S('X', 'Z2', PAIR_CONFLICTS, 100),
      S('Y', 'Z1', PAIR_AGREES, 300),
      S('Z1', 'Z2', PAIR_AGREES, 300),
      S('Z2', 'Y', PAIR_AGREES, 300),
      S('Y', 'W', PAIR_CONFLICTS, 20),
      S('W', 'Z1', PAIR_AGREES, 300),
      S('W', 'Z2', PAIR_AGREES, 300),
    ]
    const { pairCheck: pc, counts } = packPairCheck(scores, { contestedFrac: 0.5, minPairs: 2, epiTolPx: 4 })
    expect(counts).toEqual({ scored: 9, agrees: 6, conflicts: 3, contested: 1, holds: 1, contradicts: 1 })
    const name = (i) => [pc.uuids[pc.a[i]], pc.uuids[pc.b[i]]]
    expect(name(0)).toEqual(['X', 'Y'])
    expect(pc.suspect[0]).toBe(SUSPECT_HOLDS)
    expect(pc.uuids[pc.held[0]]).toBe('X')
    expect(pc.suspect[6]).toBe(SUSPECT_CONTRADICTS)
    expect(pc.held[6]).toBe(-1)
    expect(Number.isNaN(pc.epiMedianPx[0])).toBe(true) // none given: NaN, not 0
    expect([...pc.matches]).toEqual(scores.map((s) => s.n))
  })
})

describe('describePairCheck', () => {
  const holds = (k) => ({
    idA: `a${k}`,
    idB: `b${k}`,
    reason: 'holds',
    photo: `a${k}`,
    conflicts: 4,
    pairs: 5,
    conflictShare: 0.8,
    weight: 40,
  })
  const counts = { scored: 1234, agrees: 1200, conflicts: 34, contested: 5, holds: 5, contradicts: 2 }
  const suspects = [
    ...[1, 2, 3, 4, 5].map(holds),
    { idA: 'c', idB: 'd', reason: 'contradicts', photo: null, conflictShare: 0, weight: 20 },
    { idA: 'e', idB: 'f', reason: 'contradicts', photo: null, conflictShare: 0, weight: 20 },
  ]
  const lines = describePairCheck(counts, suspects, (u) => `${u}.jpg`)
  const at = (level) => lines.filter(([, l]) => l === level).map(([m]) => m)

  it('warns about the strongest pairs that hold a photo, by name, with what to do, and counts the rest', () => {
    const warns = at('warn')
    expect(warns).toHaveLength(4)
    expect(warns[0]).toContain('a1.jpg ↔ b1.jpg (40 matches) may be a false match')
    expect(warns[0]).toContain("holds a1.jpg in place while 4 of that photo's 5 pairs disagree")
    expect(warns[0]).toContain('View ▸ Inspect ▸ Matches')
    expect(warns[3]).toContain('2 more pairs')
  })

  it('records the counts at info in English numbers, each suspect at debug', () => {
    expect(at('info')[0]).toBe(
      'Pair check: 1,234 pairs checked against the model, 1,200 agree, 34 disagree; 5 photos sit where most of their pairs disagree',
    )
    expect(at('info')[1]).toContain('2 pairs disagree with the model without moving it')
    expect(at('debug')).toHaveLength(7)
  })

  it('says nothing when no pair was scored', () => {
    expect(describePairCheck({ ...counts, scored: 0 }, [], String)).toEqual([])
  })
})

describe('pairCheckToBuffer / pairCheckFromBuffer', () => {
  const S = (idA, idB, status, n, epi) => ({
    idA,
    idB,
    status,
    n,
    inModel: n - 3,
    split: 3,
    epiMedianPx: epi,
    epiAgreeFrac: 0.9,
  })
  const scores = [
    S('X', 'Y', PAIR_AGREES, 40, 0.5),
    S('X', 'Z', PAIR_CONFLICTS, 100, null),
    S('Y', 'Z', PAIR_AGREES, 300, 1.25),
  ]
  const { pairCheck } = packPairCheck(scores, { contestedFrac: 0.5, minPairs: 2, epiTolPx: 6.5 })

  it('gives back every column and the header as saved', () => {
    const { meta, buffer } = pairCheckToBuffer(pairCheck)
    const back = pairCheckFromBuffer(JSON.parse(JSON.stringify(meta)), buffer.slice(0))
    expect(back.uuids).toEqual(pairCheck.uuids)
    expect(back.epiTolPx).toBe(6.5)
    for (const k of ['a', 'b', 'matches', 'inModel', 'split', 'held', 'status', 'suspect', 'epiAgreeFrac'])
      expect([...back[k]], k).toEqual([...pairCheck[k]])
    expect([...back.epiMedianPx]).toEqual([0.5, NaN, 1.25])
  })

  it('refuses a file that does not fit its header', () => {
    const { meta, buffer } = pairCheckToBuffer(pairCheck)
    expect(pairCheckFromBuffer({ ...meta, count: 4 }, buffer)).toBeNull()
    expect(pairCheckFromBuffer({ ...meta, version: 2 }, buffer)).toBeNull()
    expect(pairCheckFromBuffer(meta, null)).toBeNull()
  })
})

describe('median', () => {
  it('matches the sorted middle for odd and even counts, with repeated values', () => {
    const r = rng(11)
    for (const n of [1, 2, 3, 4, 7, 10, 101, 1000]) {
      for (const levels of [0, 5]) {
        const vals = Array.from({ length: n }, () => (levels ? Math.floor(r() * levels) : r()))
        const sorted = [...vals].sort((x, y) => x - y)
        const want = n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
        // Only the first n entries count; what follows must be ignored.
        const a = Float64Array.from([...vals, -99, 99])
        expect(median(a, n), `n=${n} levels=${levels}`).toBe(want)
      }
    }
  })
})

describe('pairCheckVerdicts', () => {
  it('gives each pair its verdict under the store key, with the share of the photo it holds', () => {
    const S = (idA, idB, status, n) => ({
      idA,
      idB,
      status,
      n,
      inModel: n,
      split: 0,
      epiMedianPx: 0.5,
      epiAgreeFrac: 1,
    })
    const scores = [
      S('X', 'Y', PAIR_AGREES, 40),
      S('Z1', 'X', PAIR_CONFLICTS, 100),
      S('X', 'Z2', PAIR_CONFLICTS, 100),
      S('Y', 'Z1', PAIR_AGREES, 300),
      S('Z1', 'Z2', PAIR_AGREES, 300),
      S('Z2', 'Y', PAIR_AGREES, 300),
      S('Y', 'W', PAIR_CONFLICTS, 20),
      S('W', 'Z1', PAIR_AGREES, 300),
      S('W', 'Z2', PAIR_AGREES, 300),
    ]
    const { pairCheck } = packPairCheck(scores, { contestedFrac: 0.5, minPairs: 2, epiTolPx: 4 })
    const v = pairCheckVerdicts(pairCheck)
    expect(v.size).toBe(9)
    expect(v.get('X--Y')).toMatchObject({ verdict: 'holds', held: 'X', heldConflicts: 2, heldPairs: 3, matches: 40 })
    expect(v.get('X--Z1').verdict).toBe('disagrees') // stored key: uuids sorted
    expect(v.get('W--Y').verdict).toBe('overruled')
    expect(v.get('Y--Z1')).toMatchObject({ verdict: 'agrees', held: null, heldPairs: null })
    expect(pairCheckVerdicts(null).size).toBe(0)
  })
})

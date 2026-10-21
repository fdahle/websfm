import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { selectInitPair } from './initPair.js'
import { keypointSetFrom } from './keypointSet.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

// ── tiny linear algebra (mirrors sfm.test.js) ─────────────────────────────────
const mul = (A, B) => {
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j]
  return C
}
const T = (M) => [
  [M[0][0], M[1][0], M[2][0]],
  [M[0][1], M[1][1], M[2][1]],
  [M[0][2], M[1][2], M[2][2]],
]
const mv = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
]
const skew = (t) => [
  [0, -t[2], t[1]],
  [t[2], 0, -t[0]],
  [-t[1], t[0], 0],
]

const KM = [
  [1000, 0, 640],
  [0, 1000, 480],
  [0, 0, 1],
]
const KINV = [
  [1 / 1000, 0, -640 / 1000],
  [0, 1 / 1000, -480 / 1000],
  [0, 0, 1],
]
const K = { fx: 1000, fy: 1000, cx: 640, cy: 480 }

const project = (R, t, X) => {
  const c = mv(R, X).map((v, i) => v + t[i])
  return { x: KM[0][0] * (c[0] / c[2]) + KM[0][2], y: KM[1][1] * (c[1] / c[2]) + KM[1][2] }
}
const fundamental = (Ri, ti, Rj, tj) => {
  const Rrel = mul(Rj, T(Ri))
  const trel = tj.map((v, k) => v - mv(Rrel, ti)[k])
  return mul(mul(T(KINV), mul(skew(trel), Rrel)), KINV)
}

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Injected reconstruct-local helpers (same semantics as sfm.js's).
const projDepth = (P, x, y, z) => P[8] * x + P[9] * y + P[10] * z + P[11]
const numStats = (arr) => {
  const n = arr.length
  if (n === 0) return { mean: 0, median: 0, p95: 0, max: 0, count: 0 }
  const sorted = [...arr].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]
  return { mean: sorted.reduce((s, v) => s + v, 0) / n, median: at(0.5), p95: at(0.95), max: sorted[n - 1], count: n }
}

// A sideways-stereo two-view pair: camera A at the origin, camera B shifted by `baseline`
// in x, points at z≈4–6. Parallax scales with the baseline: 0.7 ⇒ ~8°, 0.45 ⇒ ~5°,
// 0.23 ⇒ ~2.7°, 0.18 ⇒ ~2.1°. The default 0.7 sits well inside the flat region of
// parallaxHealth, so both pairs score 1 there and the score reduces to
// cheiralKept × connectivityHealth / reprojection penalty.
function makePair(idA, idB, nPoints, seed, baseline = 0.7) {
  const rng = mulberry32(seed)
  const RA = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    tA = [0, 0, 0]
  const RB = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    tB = [-baseline, 0, 0]
  const kpA = [],
    kpB = [],
    matches = []
  for (let i = 0; i < nPoints; i++) {
    const X = [(rng() - 0.5) * 3, (rng() - 0.5) * 3, 4 + rng() * 2]
    kpA.push(project(RA, tA, X))
    kpB.push(project(RB, tB, X))
    matches.push([i, i])
  }
  return {
    entry: { idA, idB, F: fundamental(RA, tA, RB, tB), matches, inlierCount: nPoints },
    images: { [idA]: { name: idA, kp: keypointSetFrom(kpA) }, [idB]: { name: idB, kp: keypointSetFrom(kpB) } },
  }
}

// Two viable seeds with identical geometry apart from point count: `rich` has 1.5× the
// points of `lean`, so on a uniform graph `rich` must win on cheiralKept alone.
function scene() {
  const lean = makePair('leanA', 'leanB', 40, 7)
  const rich = makePair('richA', 'richB', 60, 11)
  const images = { ...lean.images, ...rich.images }
  const Kmap = new Map(Object.keys(images).map((uuid) => [uuid, K]))
  return { lean, rich, images, Kmap }
}

// Filler graph edges: real accepted pairs that carry degree but are not init candidates
// (no F ⇒ excluded by selectInitPair's candidate filter).
const filler = (idA, idB) => ({ idA, idB, F: null, matches: [], inlierCount: 20 })
const growthEdge = (seedId, thirdId, count) => ({
  idA: seedId,
  idB: thirdId,
  F: null,
  matches: Array.from({ length: count }, (_, i) => [i, i]),
  inlierCount: count,
})

async function pick(donePairs, images, Kmap, settings = {}) {
  const res = await selectInitPair({
    donePairs,
    Kmap,
    settings,
    imageByUuid: (uuid) => images[uuid] ?? null,
    numStats,
    projDepth,
  })
  return res
}

// Two candidates that differ in BOTH parallax and point count, the South Building
// shape: a wider-baseline pair with fewer points against a modest-baseline pair with
// more. Both clear the 2° floor.
function b4Scene({ wideBaseline = 0.45, wideCount = 50, nearBaseline = 0.23, nearCount = 64 } = {}) {
  const wide = makePair('wideA', 'wideB', wideCount, 3, wideBaseline)
  const near = makePair('nearA', 'nearB', nearCount, 5, nearBaseline)
  const images = { ...wide.images, ...near.images }
  const Kmap = new Map(Object.keys(images).map((uuid) => [uuid, K]))
  return { wide, near, images, Kmap }
}

const angleOf = (res, name) => res.perPairInitReproj.find((r) => r.pair.startsWith(name))?.parallaxDeg

describe('selectInitPair — parallax is a gate, not a ranking', () => {
  // The B4 regression: the old ramp anchored at minInitAngleDeg turned 5.1° vs 2.6°
  // into a 4.7× score factor, swamping the richer seed's point-count edge. On South
  // Building that cost 122 → 19 registered cameras.
  it('prefers the richer seed over a wider-baseline one when both clear the floor', async () => {
    const { wide, near, images, Kmap } = b4Scene()
    const res = await pick([wide.entry, near.entry], images, Kmap)
    expect(res.status).toBe('ok')
    // Pin the scene: both above the 2° floor, wide genuinely wider.
    expect(angleOf(res, 'nearA')).toBeGreaterThan(2)
    expect(angleOf(res, 'wideA')).toBeGreaterThan(angleOf(res, 'nearA'))
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['nearA', 'nearB'])
  })

  // ...but the gate must not extend down to the floor itself: a barely-passing pair is
  // still discounted by the soft band, so it cannot buy the seed with point count alone.
  it('still discounts a barely-above-floor seed despite more points', async () => {
    const { wide, near, images, Kmap } = b4Scene({ nearBaseline: 0.18, nearCount: 70 })
    const res = await pick([wide.entry, near.entry], images, Kmap)
    expect(res.status).toBe('ok')
    expect(angleOf(res, 'nearA')).toBeLessThan(2.5) // inside the soft band
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['wideA', 'wideB'])
  })

  // The opposite end is unchanged: past 4× initAngleTargetDeg, decaying overlap costs
  // more than the extra parallax buys.
  it('discounts a grazing baseline past the wide knee', async () => {
    // ~76° parallax vs ~8°, with the grazing pair holding a 1.5× point-count edge that
    // the discount (0.4 floor at this angle) must overturn.
    const grazing = makePair('grazeA', 'grazeB', 60, 3, 20)
    const normal = makePair('normA', 'normB', 40, 5)
    const images = { ...grazing.images, ...normal.images }
    const Kmap = new Map(Object.keys(images).map((uuid) => [uuid, K]))
    const res = await pick([grazing.entry, normal.entry], images, Kmap)
    expect(res.status).toBe('ok')
    expect(angleOf(res, 'grazeA')).toBeGreaterThan(32) // past initAngleTargetDeg × 4
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['normA', 'normB'])
  })
})

describe('selectInitPair — match-graph connectivity bias', () => {
  it('is inert on a uniformly-connected graph (richer geometry still wins)', async () => {
    const { lean, rich, images, Kmap } = scene()
    // Every candidate image sits at the same degree (3), so connectivityHealth ≡ 1.
    const donePairs = [
      lean.entry,
      rich.entry,
      filler('leanA', 'x1'),
      filler('leanA', 'x2'),
      filler('leanB', 'x1'),
      filler('leanB', 'x2'),
      filler('richA', 'x1'),
      filler('richA', 'x2'),
      filler('richB', 'x1'),
      filler('richB', 'x2'),
    ]
    const res = await pick(donePairs, images, Kmap)
    expect(res.status).toBe('ok')
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['richA', 'richB'])
  })

  it('can exclude a previously stalled seed for an alternate-seed retry', async () => {
    const { lean, rich, images, Kmap } = scene()
    const res = await pick([lean.entry, rich.entry], images, Kmap, { excludedInitPairs: ['richA--richB'] })
    expect(res.status).toBe('ok')
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['leanA', 'leanB'])
  })

  // The 2026-07-22 South Building regression: with parallax gated flat, a 1177-point
  // pair at graph degree 7 outscored a 670-point hub at degree 22 and registered 3/128
  // cameras against the hub's 86. Capping connectivityHealth at 1 made the hub's real
  // advantage invisible — degree 22 and degree 8 scored identically — so raw point count
  // decided the run. A hub must be able to outrank a richer pair sitting at the median.
  it('prefers a well-connected hub over a richer pair at the graph median', async () => {
    const { lean, rich, images, Kmap } = scene()
    // `lean` (40 pts) sits at degree 6, `rich` (60 pts) at the median degree 3.
    const donePairs = [
      lean.entry,
      rich.entry,
      filler('leanA', 'x1'),
      filler('leanA', 'x2'),
      filler('leanA', 'x3'),
      filler('leanA', 'x4'),
      filler('leanA', 'x5'),
      filler('leanB', 'x1'),
      filler('leanB', 'x2'),
      filler('leanB', 'x3'),
      filler('leanB', 'x4'),
      filler('leanB', 'x5'),
      filler('richA', 'x1'),
      filler('richA', 'x2'),
      filler('richB', 'x1'),
      filler('richB', 'x2'),
    ]
    const res = await pick(donePairs, images, Kmap)
    expect(res.status).toBe('ok')
    const row = (name) => res.perPairInitReproj.find((r) => r.pair.startsWith(name))
    expect(row('richA').degree).toBe(3) // the median
    expect(row('leanA').degree).toBe(6)
    expect(row('richA').cheiralKept).toBeGreaterThan(row('leanA').cheiralKept)
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['leanA', 'leanB'])
  })

  it('discounts a geometrically-ideal seed stranded in a weakly-attached cluster', async () => {
    const { lean, rich, images, Kmap } = scene()
    // Same two candidates, but now `rich` is a satellite: its images touch nothing but
    // each other (degree 1) while `lean` sits at the graph median. `rich` keeps its
    // geometric edge (1.5× the points) and must still lose to the connected seed.
    const donePairs = [
      lean.entry,
      rich.entry,
      filler('leanA', 'x1'),
      filler('leanA', 'x2'),
      filler('leanA', 'x3'),
      filler('leanB', 'x1'),
      filler('leanB', 'x2'),
      filler('leanB', 'x3'),
      filler('x1', 'x2'),
      filler('x2', 'x3'),
      filler('x1', 'x3'),
    ]
    const res = await pick(donePairs, images, Kmap)
    expect(res.status).toBe('ok')
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['leanA', 'leanB'])
  })

  it('prefers seed features observed by PnP-ready third views over nominal degree', async () => {
    const { lean, rich, images, Kmap } = scene()
    const donePairs = [
      lean.entry,
      rich.entry,
      growthEdge('leanA', 'next1', 25),
      growthEdge('leanB', 'next1', 25),
      growthEdge('leanA', 'next2', 22),
      growthEdge('leanB', 'next2', 22),
      // Same degree, but these edges repeatedly observe too few seed points to
      // supply the default 20-correspondence registration gate.
      growthEdge('richA', 'dead1', 8),
      growthEdge('richB', 'dead1', 8),
      growthEdge('richA', 'dead2', 8),
      growthEdge('richB', 'dead2', 8),
    ]
    const res = await pick(donePairs, images, Kmap)
    expect(res.status).toBe('ok')
    const row = (name) => res.perPairInitReproj.find((r) => r.pair.startsWith(name))
    expect(row('leanA').degree).toBe(row('richA').degree)
    expect(row('leanA').growthViews).toBe(2)
    expect(row('richA').growthViews).toBe(0)
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['leanA', 'leanB'])
  })

  it('lets 23 ready views outrank a richer seed with only 20', async () => {
    const stalled = makePair('stalledA', 'stalledB', 76, 21)
    const growing = makePair('growingA', 'growingB', 64, 23)
    const images = { ...stalled.images, ...growing.images }
    const Kmap = new Map(Object.keys(images).map((uuid) => [uuid, K]))
    const donePairs = [stalled.entry, growing.entry]
    for (let i = 0; i < 20; i++) donePairs.push(growthEdge('stalledA', `s${i}`, 25))
    for (let i = 0; i < 23; i++) donePairs.push(growthEdge('growingA', `g${i}`, 25))
    const res = await pick(donePairs, images, Kmap)
    expect(res.status).toBe('ok')
    const row = (name) => res.perPairInitReproj.find((r) => r.pair.startsWith(name))
    expect(row('stalledA').cheiralKept).toBeGreaterThan(row('growingA').cheiralKept)
    expect(row('stalledA').growthViews).toBe(20)
    expect(row('growingA').growthViews).toBe(23)
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['growingA', 'growingB'])
  })
})

// A hovering burst: `ids.length` cameras a few mm apart, all seeing the same points, so
// every pair among them has the most inliers in the project and ~0.1° of parallax.
function makeBurst(ids, nPoints, seed, step = 0.01) {
  const rng = mulberry32(seed)
  const X = Array.from({ length: nPoints }, () => [(rng() - 0.5) * 3, (rng() - 0.5) * 3, 4 + rng() * 2])
  const R = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  const t = ids.map((_, k) => [-step * k, 0, 0])
  const images = Object.fromEntries(
    ids.map((id, k) => [id, { name: id, kp: keypointSetFrom(X.map((p) => project(R, t[k], p))) }]),
  )
  const entries = []
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      entries.push({
        idA: ids[a],
        idB: ids[b],
        F: fundamental(R, t[a], R, t[b]),
        matches: X.map((_, i) => [i, i]),
        inlierCount: nPoints,
      })
    }
  }
  return { entries, images }
}

describe('selectInitPair — widening past a near-coincident burst', () => {
  // St Nazaire, SuperPoint + LightGlue (2026-10-09): a 9-frame hover had the 36
  // highest-inlier pairs in the project, so the whole candidate batch sat at ~0.2°;
  // the fallback seed's points all fell under the track filter's parallax floor and
  // the model died at 7 cameras with 0 points.
  function hoverScene() {
    const burst = makeBurst(['h0', 'h1', 'h2', 'h3', 'h4'], 100, 31)
    const good = makePair('goodA', 'goodB', 40, 33)
    const images = { ...burst.images, ...good.images }
    const Kmap = new Map(Object.keys(images).map((uuid) => [uuid, K]))
    return { donePairs: [...burst.entries, good.entry], images, Kmap }
  }

  it('keeps probing beyond the first batch until a pair clears the floor', async () => {
    const { donePairs, images, Kmap } = hoverScene()
    const logs = []
    const res = await selectInitPair(
      {
        donePairs,
        Kmap,
        settings: { initCandidates: 3 },
        imageByUuid: (uuid) => images[uuid] ?? null,
        numStats,
        projDepth,
      },
      { onLog: (m) => logs.push(m) },
    )
    expect(res.status).toBe('ok')
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['goodA', 'goodB'])
    expect(res.best.angle).toBeGreaterThan(2)
    // The rest of the burst is predicted below the floor from the first batch and skipped,
    // so the widened search reaches the good pair without probing all 10 burst pairs.
    expect(logs.some((m) => /widening the search/.test(m) && /skipped as near-coincident/.test(m))).toBe(true)
    expect(res.perPairInitReproj.length).toBeLessThan(donePairs.length)
  })

  it('is unchanged when the first batch already holds a sound seed', async () => {
    const { donePairs, images, Kmap } = hoverScene()
    const logs = []
    await selectInitPair(
      {
        donePairs,
        Kmap,
        settings: { initCandidates: 24 },
        imageByUuid: (uuid) => images[uuid] ?? null,
        numStats,
        projDepth,
      },
      { onLog: (m) => logs.push(m) },
    )
    expect(logs.some((m) => /widening the search/.test(m))).toBe(false)
  })

  it('says plainly when the fallback seed is below the track filter floor', async () => {
    const { donePairs, images, Kmap } = hoverScene()
    const logs = []
    const res = await selectInitPair(
      {
        donePairs,
        Kmap,
        settings: { initCandidates: 3, initCandidateMax: 3, filterMinTriAngleDeg: 1.5 },
        imageByUuid: (uuid) => images[uuid] ?? null,
        numStats,
        projDepth,
      },
      { onLog: (m) => logs.push(m) },
    )
    expect(res.status).toBe('ok')
    expect(res.best.angle).toBeLessThan(1.5)
    expect(logs.some((m) => /below the 1.5° the track filter requires/.test(m))).toBe(true)
  })
})

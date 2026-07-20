import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { selectInitPair } from './initPair.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

// ── tiny linear algebra (mirrors sfm.test.js) ─────────────────────────────────
const mul = (A, B) => {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j]
  return C
}
const T = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]]
const mv = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
]
const skew = (t) => [[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]]

const KM = [[1000, 0, 640], [0, 1000, 480], [0, 0, 1]]
const KINV = [[1 / 1000, 0, -640 / 1000], [0, 1 / 1000, -480 / 1000], [0, 0, 1]]
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
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
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

// A sideways-stereo two-view pair: camera A at the origin, camera B shifted +0.7 in x,
// points at z≈4–6 ⇒ ~8° parallax (right at initAngleTargetDeg, so parallaxHealth = 1 for
// both pairs and the score reduces to cheiralKept × connectivityHealth).
function makePair(idA, idB, nPoints, seed) {
  const rng = mulberry32(seed)
  const RA = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], tA = [0, 0, 0]
  const RB = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], tB = [-0.7, 0, 0]
  const kpA = [], kpB = [], matches = []
  for (let i = 0; i < nPoints; i++) {
    const X = [(rng() - 0.5) * 3, (rng() - 0.5) * 3, 4 + rng() * 2]
    kpA.push(project(RA, tA, X))
    kpB.push(project(RB, tB, X))
    matches.push([i, i])
  }
  return {
    entry: { idA, idB, F: fundamental(RA, tA, RB, tB), matches, inlierCount: nPoints },
    images: { [idA]: { name: idA, keypoints: kpA }, [idB]: { name: idB, keypoints: kpB } },
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

async function pick(donePairs, images, Kmap) {
  const res = await selectInitPair({
    donePairs,
    Kmap,
    settings: {},
    imageByUuid: (uuid) => images[uuid] ?? null,
    numStats,
    projDepth,
  })
  return res
}

describe('selectInitPair — match-graph connectivity bias', () => {
  it('is inert on a uniformly-connected graph (richer geometry still wins)', async () => {
    const { lean, rich, images, Kmap } = scene()
    // Every candidate image sits at the same degree (3), so connectivityHealth ≡ 1.
    const donePairs = [
      lean.entry, rich.entry,
      filler('leanA', 'x1'), filler('leanA', 'x2'),
      filler('leanB', 'x1'), filler('leanB', 'x2'),
      filler('richA', 'x1'), filler('richA', 'x2'),
      filler('richB', 'x1'), filler('richB', 'x2'),
    ]
    const res = await pick(donePairs, images, Kmap)
    expect(res.status).toBe('ok')
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['richA', 'richB'])
  })

  it('discounts a geometrically-ideal seed stranded in a weakly-attached cluster', async () => {
    const { lean, rich, images, Kmap } = scene()
    // Same two candidates, but now `rich` is a satellite: its images touch nothing but
    // each other (degree 1) while `lean` sits at the graph median. `rich` keeps its
    // geometric edge (1.5× the points) and must still lose to the connected seed.
    const donePairs = [
      lean.entry, rich.entry,
      filler('leanA', 'x1'), filler('leanA', 'x2'), filler('leanA', 'x3'),
      filler('leanB', 'x1'), filler('leanB', 'x2'), filler('leanB', 'x3'),
      filler('x1', 'x2'), filler('x2', 'x3'), filler('x1', 'x3'),
    ]
    const res = await pick(donePairs, images, Kmap)
    expect(res.status).toBe('ok')
    expect([res.best.entry.idA, res.best.entry.idB]).toEqual(['leanA', 'leanB'])
  })
})

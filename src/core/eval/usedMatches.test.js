import { describe, expect, it } from 'vitest'
import { matchPairStats, usedKeysForPair, usedPairCounts } from './usedMatches.js'
import { makePackedPoints } from '../sfm/resultCodec.js'
import { SparsePoints } from '../sfm/sparsePoints.js'

// The reference the counts replace: one Set of "kpA:kpB" keys per pair.
function referenceSets(points) {
  const byPair = new Map()
  for (const pt of points) {
    if (!pt.views || pt.views.size < 2) continue
    const obs = [...pt.views.entries()]
    for (let i = 0; i < obs.length; i++) {
      for (let j = i + 1; j < obs.length; j++) {
        let [ua, ka] = obs[i]
        let [ub, kb] = obs[j]
        if (ua > ub) [ua, ka, ub, kb] = [ub, kb, ua, ka]
        const pid = `${ua}--${ub}`
        if (!byPair.has(pid)) byPair.set(pid, new Set())
        byPair.get(pid).add(`${ka}:${kb}`)
      }
    }
  }
  return byPair
}

// Random model where each keypoint belongs to at most one point, as in a real track store.
function randomModel(seed, nImages = 7, nPoints = 400) {
  let s = seed
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const uuids = Array.from({ length: nImages }, (_, i) => `img-${String.fromCharCode(103 - i)}-${i}`)
  const nextKp = new Array(nImages).fill(0)
  const points = []
  for (let p = 0; p < nPoints; p++) {
    const views = new Map()
    const k = 1 + Math.floor(rand() * nImages)
    for (let v = 0; v < k; v++) {
      const im = Math.floor(rand() * nImages)
      if (!views.has(uuids[im])) views.set(uuids[im], nextKp[im]++)
    }
    points.push({ x: p, y: 0, z: 0, color: [0, 0, 0], views })
  }
  return { uuids, points }
}

function pack(points, uuids) {
  const idx = new Map(uuids.map((u, i) => [u, i]))
  const vcount = new Uint32Array(points.length)
  const vcam = [],
    vkp = []
  points.forEach((p, i) => {
    vcount[i] = p.views.size
    for (const [u, kp] of p.views) {
      vcam.push(idx.get(u))
      vkp.push(kp)
    }
  })
  return makePackedPoints({
    pos: new Float64Array(points.length * 3),
    viewUuids: uuids,
    vcount,
    vcam: Uint32Array.from(vcam),
    vkp: Uint32Array.from(vkp),
  })
}

describe('usedPairCounts', () => {
  it('equals the per-pair distinct key-set sizes, for record-built and packed points', () => {
    for (const seed of [1, 7, 42]) {
      const { uuids, points } = randomModel(seed)
      const ref = new Map([...referenceSets(points)].map(([pid, set]) => [pid, set.size]))
      expect(new Map([...usedPairCounts(SparsePoints.fromRecords(points))].sort())).toEqual(new Map([...ref].sort()))
      expect(new Map([...usedPairCounts(pack(points, uuids))].sort())).toEqual(new Map([...ref].sort()))
    }
  })

  it('is empty without points', () => {
    expect(usedPairCounts([]).size).toBe(0)
    expect(usedPairCounts(null).size).toBe(0)
  })
})

describe('usedKeysForPair', () => {
  it('reproduces the reference key set of every pair', () => {
    const { uuids, points } = randomModel(3)
    const ref = referenceSets(points)
    const packed = pack(points, uuids)
    const built = SparsePoints.fromRecords(points)
    for (const [pid, set] of ref) {
      expect(usedKeysForPair(built, pid)).toEqual(set)
      expect(usedKeysForPair(packed, pid)).toEqual(set)
    }
    expect(usedKeysForPair(built, 'nope').size).toBe(0)
  })
})

describe('matchPairStats', () => {
  const done = (extra = {}) => ({ status: 'done', inlierCount: 50, ...extra })
  const store = new Map([
    ['a--b', done()],
    ['b--c', done()],
    ['c--d', done()],
    ['a--d', done({ enabled: false })],
    ['b--d', done({ weak: true })],
    ['a--e', { status: 'done', inlierCount: 0 }],
    ['d--e', { status: 'running' }],
    ['c--e', { status: 'error' }],
  ])

  it('counts each state once', () => {
    expect(matchPairStats(store, null)).toEqual({
      total: 8,
      verified: 3,
      running: 1,
      error: 1,
      used: null,
      excluded: 1,
      weak: 1,
    })
  })

  it('counts used pairs among the verified ones only', () => {
    // One track over a, b, c and d makes all six of their pairs co-visible, though
    // only a–b, b–c and c–d are verified matches (a–c was never matched).
    const views = new Map([
      ['a', 0],
      ['b', 0],
      ['c', 0],
      ['d', 0],
    ])
    const model = pack([{ x: 0, y: 0, z: 0, views }], ['a', 'b', 'c', 'd'])
    const counts = usedPairCounts(model)
    expect(counts.size).toBe(6)
    expect(matchPairStats(store, counts).used).toBe(3)
  })

  it('leaves out a verified pair that no tie-point joins', () => {
    const counts = new Map([['a--b', 4]])
    expect(matchPairStats(store, counts).used).toBe(1)
  })
})

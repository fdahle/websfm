import { describe, expect, it } from 'vitest'
import { usedKeysForPair, usedPairCounts } from './usedMatches.js'
import { makePackedPoints } from '../sfm/resultCodec.js'

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
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
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
  const vcam = [], vkp = []
  points.forEach((p, i) => {
    vcount[i] = p.views.size
    for (const [u, kp] of p.views) { vcam.push(idx.get(u)); vkp.push(kp) }
  })
  return makePackedPoints({
    pos: new Float64Array(points.length * 3), viewUuids: uuids, vcount,
    vcam: Uint32Array.from(vcam), vkp: Uint32Array.from(vkp),
  })
}

describe('usedPairCounts', () => {
  it('equals the per-pair distinct key-set sizes, for Map and packed points', () => {
    for (const seed of [1, 7, 42]) {
      const { uuids, points } = randomModel(seed)
      const ref = new Map([...referenceSets(points)].map(([pid, set]) => [pid, set.size]))
      expect(new Map([...usedPairCounts(points)].sort())).toEqual(new Map([...ref].sort()))
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
    for (const [pid, set] of ref) {
      expect(usedKeysForPair(points, pid)).toEqual(set)
      expect(usedKeysForPair(packed, pid)).toEqual(set)
    }
    expect(usedKeysForPair(points, 'nope').size).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { decideTurns, planTurnProbes, turnSearchPieces } from './turnSearch.js'

describe('planTurnProbes', () => {
  const main = Array.from({ length: 10 }, (_, i) => `m${i}`)
  it('takes the main photos with the most overlap evidence', () => {
    const score = (a, b) => (b === 'p0' ? ({ m3: 0.9, m7: 0.5, m1: 0 }[a] ?? 0) : 0)
    const out = planTurnProbes({ pieces: [['p0']], main, scoreUnmatched: score, maxPerImage: 5 })
    expect(out.map((p) => p.idMain)).toEqual(['m3', 'm7'])
  })
  it('spreads over the main block without evidence', () => {
    const out = planTurnProbes({ pieces: [['p0', 'p1']], main, maxPerImage: 4 })
    expect(out.filter((p) => p.idPiece === 'p0').map((p) => p.idMain)).toEqual(['m0', 'm2', 'm5', 'm7'])
    expect(out).toHaveLength(8)
  })
})

describe('decideTurns', () => {
  // Content turned 180° against the main photo: the piece photo is detected at 180°.
  const probe = (idPiece, rotationDeg, inliers = 50, idMain = 'm0') => ({ idMain, idPiece, rotationDeg, inliers })

  it('turns a piece photo by the turn its inliers vote for', () => {
    const { turns } = decideTurns({ probes: [probe('p0', 176), probe('p0', 183, 80)], pieces: [['p0']] })
    expect([...turns]).toEqual([['p0', 180]])
  })

  it('reads the turn against a main photo that was itself turned', () => {
    // Main photo detected at 90°, piece content turned 90° clockwise against it: 0.
    const { turns } = decideTurns({
      probes: [probe('p0', 90)],
      pieces: [['p0']],
      turnOf: (id) => (id === 'm0' ? 90 : 0),
    })
    expect(turns.size).toBe(0)
  })

  it('gives a photo without its own evidence the turn of its piece', () => {
    const { turns, pieces } = decideTurns({
      probes: [probe('p0', 178), probe('p1', 181), probe('p2', 30, 10)], // p2's probe is too weak
      pieces: [['p0', 'p1', 'p2']],
    })
    expect(Object.fromEntries(turns)).toEqual({ p0: 180, p1: 180, p2: 180 })
    expect(pieces).toEqual([{ size: 3, turn: 180, voters: 2, turned: 3 }])
  })

  it('turns nothing when the votes split or agree with the present turn', () => {
    expect(decideTurns({ probes: [probe('p0', 0), probe('p0', 180)], pieces: [['p0']] }).turns.size).toBe(0)
    expect(decideTurns({ probes: [probe('p0', 3), probe('p1', -4)], pieces: [['p0', 'p1']] }).turns.size).toBe(0)
  })
})

describe('turnSearchPieces', () => {
  // Two strong flights (chains of 300-inlier pairs) tied by twelve chance pairs of 15–28
  // inliers, 258 in all: one graph, and over bridge repair's 100-inlier cut.
  const a = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'],
    b = ['b0', 'b1', 'b2', 'b3', 'b4']
  const chain = (ids) => ids.slice(1).map((id, i) => ({ idA: ids[i], idB: id, status: 'done', inlierCount: 300 }))
  const weak = Array.from({ length: 12 }, (_, i) => ({
    idA: a[i % a.length],
    idB: b[i % b.length],
    status: 'done',
    inlierCount: 15 + i,
  }))
  const entries = [...chain(a), ...chain(b), ...weak]

  it('finds a flight tied on only by weak pairs, however many', () => {
    expect(turnSearchPieces({ imageIds: [...a, ...b], entries })).toEqual([b])
  })

  it('finds nothing in a block held by strong pairs', () => {
    const joined = [...entries, { idA: 'a5', idB: 'b0', status: 'done', inlierCount: 120 }]
    expect(turnSearchPieces({ imageIds: [...a, ...b], entries: joined })).toEqual([])
  })
})

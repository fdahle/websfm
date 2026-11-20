import { describe, expect, it } from 'vitest'
import { describeMargin, summarizeMargin } from './registrationMargin.js'

describe('registration margin', () => {
  const photos = [
    { name: 'a.jpg', correspondences: 500 },
    { name: 'hinge.jpg', correspondences: 34 },
    { name: 'b.jpg', correspondences: 40 }, // exactly 2× the floor: not near
    { name: 'edge.jpg', correspondences: 21 },
  ]

  it('counts the photos under factor × floor, nearest first', () => {
    const m = summarizeMargin(photos, { floor: 20, factor: 2 })
    expect(m).toMatchObject({ floor: 20, factor: 2, registered: 4, nearFloor: 2 })
    expect(m.nearest).toEqual([
      { name: 'edge.jpg', correspondences: 21 },
      { name: 'hinge.jpg', correspondences: 34 },
    ])
  })

  it('keeps at most `keep` names but counts them all', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `p${i}.jpg`, correspondences: 20 + i }))
    const m = summarizeMargin(many, { floor: 20, factor: 2, keep: 10 })
    expect(m.nearFloor).toBe(15)
    expect(m.nearest).toHaveLength(10)
    expect(m.nearest[0].correspondences).toBe(20)
    expect(describeMargin(m)).toContain('and 5 more')
  })

  it('says nothing when every photo is well over the floor', () => {
    expect(describeMargin(summarizeMargin([{ name: 'a.jpg', correspondences: 500 }], { floor: 20 }))).toBeNull()
  })

  it('names the photos, the floor and the counts in the log line', () => {
    const line = describeMargin(summarizeMargin(photos, { floor: 20, factor: 2 }))
    expect(line).toMatch(
      /^2 of 4 photos registered with fewer than 40 correspondences \(2× the floor of 20\): edge\.jpg \(21\), hinge\.jpg \(34\)\./,
    )
  })
})

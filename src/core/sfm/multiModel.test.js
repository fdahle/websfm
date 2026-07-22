import { describe, it, expect } from 'vitest'
import { secondaryJobs, alignSecondary, mergeAligned } from './multiModel.js'
import { applySimilarity } from '../products/georef.js'

const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const rotZ = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]]
const mul = (A, B) => Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) =>
  A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]))
const mv = (R, p) => R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2])
const camAt = (uuid, C, R = I) => ({ uuid, R, t: mv(R, C).map((v) => -v), K: { fx: 1000 } })

describe('secondaryJobs', () => {
  it('adds the strongest registered boundary halo to a stranded component', () => {
    const ids = ['p1', 'p2', ...Array.from({ length: 8 }, (_, i) => `s${i}`)]
    const images = ids.map((uuid) => ({ uuid }))
    const pairs = []
    for (let i = 0; i < 7; i++) pairs.push({ idA: `s${i}`, idB: `s${i + 1}`, status: 'done', inlierCount: 50 })
    pairs.push({ idA: 'p1', idB: 's0', status: 'done', inlierCount: 200 })
    pairs.push({ idA: 'p2', idB: 's1', status: 'done', inlierCount: 100 })
    const primary = { cameras: [{ uuid: 'p1' }, { uuid: 'p2' }], summary: {
      unregisteredComponents: [{ imageUuids: ids.slice(2) }],
    } }
    const [job] = secondaryJobs({ images, pairs }, primary)
    expect(job.componentIds).toHaveLength(8)
    expect(job.boundaryIds).toEqual(['p1', 'p2'])
    expect(job.images).toHaveLength(10)
  })
})

describe('alignSecondary', () => {
  const sim = { scale: 2.5, R: rotZ(0.4), t: [7, -3, 2] }
  const centresS = [[0, 0, 0], [2, 0, 0], [0, 3, 1], [2, 2, 2]]
  const primaryCams = centresS.map((C, i) => camAt(`c${i}`, applySimilarity(sim, C)))
  // Inverse of transformCamera used by alignSecondary for primary R=I.
  const secondaryCams = centresS.map((C, i) => {
    const R = sim.R
    const tp = primaryCams[i].t
    const Rd = mv(I, sim.t)
    const t = tp.map((v, k) => (v + Rd[k]) / sim.scale)
    return { uuid: `c${i}`, R, t, K: { fx: 1000 } }
  })
  secondaryCams.push(camAt('new', [1, 1, 1], sim.R))
  const primary = { status: 'done', cameras: primaryCams, points: [], summary: { selfCalDistortion: [] } }
  const secondary = {
    status: 'done', cameras: secondaryCams,
    points: [{ x: 1, y: 2, z: 3, views: [['new', 0]] }], summary: { selfCalDistortion: [] },
  }

  it('aligns and merges a secondary model supported by shared cameras', () => {
    const aligned = alignSecondary(primary, secondary, ['new'])
    expect(aligned.accepted).toBe(true)
    expect(aligned.common).toHaveLength(4)
    expect(aligned.rmsFrac).toBeLessThan(1e-6)
    expect(aligned.medianRotationDeg).toBeLessThan(1e-5)
    const merged = mergeAligned(primary, aligned)
    expect(merged.cameras).toHaveLength(5)
    expect(merged.points).toHaveLength(1)
    expect(merged.summary.secondaryMerge.addedCameras).toBe(1)
  })

  it('refuses a position-only fit when shared camera rotations disagree', () => {
    const bad = structuredClone(secondary)
    for (let i = 0; i < 3; i++) {
      bad.cameras[i].R = rotZ(1.2)
      bad.cameras[i].t = mv(bad.cameras[i].R, centresS[i]).map((v) => -v) // preserve centre
    }
    const aligned = alignSecondary(primary, bad, ['new'])
    expect(aligned.accepted).toBe(false)
    expect(aligned.reason).toContain('rotation disagreement')
  })

  it('keeps an otherwise valid secondary separate with fewer than three shared cameras', () => {
    const aligned = alignSecondary(primary, { ...secondary, cameras: secondary.cameras.slice(0, 2) }, ['new'])
    expect(aligned.accepted).toBe(false)
    expect(aligned.reason).toContain('2/3')
  })
})

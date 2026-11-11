import { describe, it, expect } from 'vitest'
import { georefEvidenceKey, currentEvidenceKey } from './georefEvidence.js'

const evidence = (o = {}) => ({
  crs: 'EPSG:32636',
  model: 'm1',
  cameras: [['u1', { K: [5675.3, 0, 3000], R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, -0] }]],
  images: [[1, 'u1']],
  gcps: [{ name: 'G1', x: 1, y: 2, z: 3, observations: [{ imageId: 1, imageName: 'img_001', u: 10.5, v: 20.25 }] }],
  poses: [
    { id: 'p1', imageId: 1, imageName: 'img_001', x: 414089.3216528354, y: 6635152.056354913, z: 225.157, omega: null },
  ],
  ...o,
})

describe('the evidence a georeference was fitted on', () => {
  it("does not change when a linked record takes its photo's name", () => {
    const renamed = evidence({
      poses: [{ ...evidence().poses[0], imageName: 'IMG_001.JPG' }],
      gcps: [
        { ...evidence().gcps[0], observations: [{ ...evidence().gcps[0].observations[0], imageName: 'IMG_001.JPG' }] },
      ],
    })
    expect(georefEvidenceKey(renamed)).toBe(georefEvidenceKey(evidence()))
  })

  it('changes with what the fit used: a position, a link, a mark, the model', () => {
    const base = georefEvidenceKey(evidence())
    expect(georefEvidenceKey(evidence({ poses: [{ ...evidence().poses[0], z: 225.2 }] }))).not.toBe(base)
    expect(georefEvidenceKey(evidence({ poses: [{ ...evidence().poses[0], imageId: 2 }] }))).not.toBe(base)
    const gcp = evidence().gcps[0]
    expect(
      georefEvidenceKey(evidence({ gcps: [{ ...gcp, observations: [{ ...gcp.observations[0], u: 10.6 }] }] })),
    ).not.toBe(base)
    expect(georefEvidenceKey(evidence({ model: 'm2' }))).not.toBe(base)
  })

  it('reads a key saved with the names as the same evidence, whatever the names became', () => {
    const saved = JSON.stringify(evidence()) // as keys were written before
    expect(saved).toContain('img_001')
    expect(currentEvidenceKey(saved)).toBe(georefEvidenceKey(evidence()))
    const now = evidence({ poses: [{ ...evidence().poses[0], imageName: 'IMG_001.JPG' }] })
    expect(currentEvidenceKey(saved)).toBe(georefEvidenceKey(now))
    expect(currentEvidenceKey(saved)).not.toBe(georefEvidenceKey(evidence({ model: 'm2' })))
  })

  it('leaves a key in the current form, a missing one and a broken one as they are', () => {
    const key = georefEvidenceKey(evidence())
    expect(currentEvidenceKey(key)).toBe(key)
    expect(currentEvidenceKey(undefined)).toBe(undefined)
    expect(currentEvidenceKey(null)).toBe(null)
    expect(currentEvidenceKey('{broken')).toBe('{broken')
  })
})

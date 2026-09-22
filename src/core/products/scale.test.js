import { describe, it, expect } from 'vitest'
import {
  fitScale, weightFromAccuracy, toMetres, fromMetres, scaleEvidenceDigest,
} from './scale.js'

describe('fitScale', () => {
  it('is exact for a single constraint', () => {
    const fit = fitScale([{ id: 'a', modelDistance: 2, knownDistance: 5 }])
    expect(fit.scale).toBeCloseTo(2.5, 12)
    expect(fit.rms).toBeCloseTo(0, 12)
    expect(fit.count).toBe(1)
    expect(fit.constraints[0].residual).toBeCloseTo(0, 12)
  })

  it('splits the difference between two disagreeing constraints (equal weight)', () => {
    // Same model length, 2 % apart in metres: the LSQ scale is the mean.
    const fit = fitScale([
      { id: 'a', modelDistance: 1, knownDistance: 1.00 },
      { id: 'b', modelDistance: 1, knownDistance: 1.02 },
    ])
    expect(fit.scale).toBeCloseTo(1.01, 12)
    // Both bars are reported; neither is dropped.
    expect(fit.constraints.map((c) => c.id)).toEqual(['a', 'b'])
    expect(fit.constraints[0].residual).toBeCloseTo(+0.01, 12)
    expect(fit.constraints[1].residual).toBeCloseTo(-0.01, 12)
    expect(fit.rms).toBeCloseTo(0.01, 12)
  })

  it('pulls the fit toward the more accurate constraint', () => {
    const fit = fitScale([
      { id: 'tight', modelDistance: 1, knownDistance: 1.00, weight: weightFromAccuracy(0.001) },
      { id: 'loose', modelDistance: 1, knownDistance: 1.02, weight: weightFromAccuracy(0.01) },
    ])
    // 1e6 vs 1e4 ⇒ ~99 % of the pull from the tight bar.
    expect(fit.scale).toBeGreaterThan(1.0)
    expect(fit.scale).toBeLessThan(1.0002)
    const expectedRms = Math.sqrt(fit.constraints.reduce((s, c) => s + c.weight * c.residual ** 2, 0)
      / fit.constraints.reduce((s, c) => s + c.weight, 0))
    expect(fit.rms).toBeCloseTo(expectedRms, 12)
  })

  it('normalises a residual by the declared σ, and reports null without one', () => {
    const fit = fitScale([
      { id: 'a', modelDistance: 1, knownDistance: 1.00, accuracy: 0.005, weight: weightFromAccuracy(0.005) },
      { id: 'b', modelDistance: 1, knownDistance: 1.02, weight: 1 },
    ])
    expect(fit.constraints[0].normalizedResidual).not.toBeNull()
    // No declared accuracy ⇒ no σ to normalise by. Never fabricate one.
    expect(fit.constraints[1].normalizedResidual).toBeNull()
    expect(fit.constraints[1].accuracy).toBeNull()
  })

  it('is scale-only: doubling every known distance doubles the fit', () => {
    const cs = [{ modelDistance: 3, knownDistance: 1 }, { modelDistance: 7, knownDistance: 2 }]
    const a = fitScale(cs)
    const b = fitScale(cs.map((c) => ({ ...c, knownDistance: c.knownDistance * 2 })))
    expect(b.scale).toBeCloseTo(a.scale * 2, 12)
  })

  it('returns null on degenerate or invalid input', () => {
    expect(fitScale([])).toBeNull()
    expect(fitScale(null)).toBeNull()
    expect(fitScale([{ modelDistance: 0, knownDistance: 1 }])).toBeNull()
    expect(fitScale([{ modelDistance: 1, knownDistance: 0 }])).toBeNull()
    expect(fitScale([{ modelDistance: -1, knownDistance: 1 }])).toBeNull()
    expect(fitScale([{ modelDistance: NaN, knownDistance: 1 }])).toBeNull()
    expect(fitScale([{ modelDistance: 1, knownDistance: Infinity }])).toBeNull()
  })

  it('treats a non-positive weight as equal weight rather than failing', () => {
    // Record-level validation refuses a bad accuracy; the fit must not fail over
    // a field the user simply never filled in.
    expect(fitScale([{ modelDistance: 1, knownDistance: 2, weight: 0 }]).scale).toBeCloseTo(2, 12)
  })
})

describe('weightFromAccuracy', () => {
  it('is inverse variance, with equal weight for a missing σ', () => {
    expect(weightFromAccuracy(0.01)).toBeCloseTo(10000, 9)
    expect(weightFromAccuracy(null)).toBe(1)
    expect(weightFromAccuracy(0)).toBe(1)
    expect(weightFromAccuracy(-1)).toBe(1)
  })
})

describe('length units', () => {
  it('round-trips mm/cm/m through metres', () => {
    expect(toMetres(250, 'mm')).toBeCloseTo(0.25, 12)
    expect(toMetres(25, 'cm')).toBeCloseTo(0.25, 12)
    expect(toMetres(0.25, 'm')).toBeCloseTo(0.25, 12)
    expect(fromMetres(0.25, 'mm')).toBeCloseTo(250, 9)
    expect(fromMetres(toMetres(37, 'cm'), 'cm')).toBeCloseTo(37, 12)
  })

  it('treats an unknown unit as metres rather than throwing', () => {
    expect(toMetres(3, 'furlong')).toBe(3)
  })
})

describe('scaleEvidenceDigest', () => {
  const bars = [
    { id: 'b1', a: { kind: 'marker', id: 'm1' }, b: { kind: 'marker', id: 'm2' },
      knownDistanceM: 1, accuracyM: 0.002, enabled: true },
  ]
  const markers = [
    { id: 'm1', observations: [{ imageId: 'i1', px: 10, py: 20 }] },
    { id: 'm2', observations: [{ imageId: 'i1', px: 90, py: 20 }] },
  ]

  it('is stable across ordering', () => {
    expect(scaleEvidenceDigest(bars, markers))
      .toBe(scaleEvidenceDigest(bars, [...markers].reverse()))
  })

  it('changes when a distance changes', () => {
    const edited = [{ ...bars[0], knownDistanceM: 1.001 }]
    expect(scaleEvidenceDigest(edited, markers)).not.toBe(scaleEvidenceDigest(bars, markers))
  })

  it('changes when a referenced marker observation moves', () => {
    const moved = [markers[0], { id: 'm2', observations: [{ imageId: 'i1', px: 91, py: 20 }] }]
    expect(scaleEvidenceDigest(bars, moved)).not.toBe(scaleEvidenceDigest(bars, markers))
  })

  it('changes when marker eligibility or observation accuracy changes', () => {
    const disabled = [{ ...markers[0], enabled: false }, markers[1]]
    const reweighted = [markers[0], {
      ...markers[1],
      observations: [{ ...markers[1].observations[0], accuracyX: 0.25 }],
    }]
    expect(scaleEvidenceDigest(bars, disabled)).not.toBe(scaleEvidenceDigest(bars, markers))
    expect(scaleEvidenceDigest(bars, reweighted)).not.toBe(scaleEvidenceDigest(bars, markers))
  })

  it('ignores disabled bars', () => {
    const off = [{ ...bars[0], enabled: false }]
    expect(scaleEvidenceDigest(off, markers)).toBe(scaleEvidenceDigest([], markers))
  })
})

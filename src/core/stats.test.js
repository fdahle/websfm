import { describe, expect, it } from 'vitest'
import { NMAD_K } from './constants.js'
import { clamp, median, nmad, quantile, quantileNearest, quantileRank, quantileSorted, upperMedian } from './stats.js'

describe('median', () => {
  it('takes the middle value of an odd count and the mean of the two middles of an even one', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([7])).toBe(7)
  })
  it('sorts numerically, not as text', () => {
    expect(median([10, 9, 100])).toBe(10)
  })
  it('is NaN for no values and leaves its input unsorted', () => {
    expect(median([])).toBeNaN()
    const v = [3, 1, 2]
    median(v)
    expect(v).toEqual([3, 1, 2])
  })
})

describe('upperMedian', () => {
  it('takes the upper of the two middles of an even count', () => {
    expect(upperMedian([4, 1, 3, 2])).toBe(3)
    expect(upperMedian([3, 1, 2])).toBe(2)
    expect(upperMedian([])).toBeNaN()
  })
})

describe('quantile', () => {
  it('interpolates between ranks as R type 7 does', () => {
    // R: quantile(c(1, 2, 3, 4, 5), c(0, .1, .25, .5, 1)) = 1, 1.4, 2, 3, 5
    const s = [1, 2, 3, 4, 5]
    expect(quantileSorted(s, 0)).toBe(1)
    expect(quantileSorted(s, 0.1)).toBeCloseTo(1.4, 12)
    expect(quantileSorted(s, 0.25)).toBe(2)
    expect(quantileSorted(s, 0.5)).toBe(3)
    expect(quantileSorted(s, 1)).toBe(5)
    expect(quantile([5, 1, 4, 2, 3], 0.1)).toBeCloseTo(1.4, 12)
  })
  it('equals the median at q = 0.5', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(median([4, 1, 3, 2]))
  })
  it('is NaN for no values', () => {
    expect(quantileSorted([], 0.5)).toBeNaN()
  })
})

describe('rank quantiles', () => {
  it('quantileNearest takes the sample nearest position (n − 1)·q', () => {
    const s = [10, 20, 30, 40, 50]
    expect(quantileNearest(s, 0.1)).toBe(10) // position 0.4
    expect(quantileNearest(s, 0.15)).toBe(20) // position 0.6
    expect(quantileNearest(s, 1)).toBe(50)
  })
  it('quantileRank takes the sample at rank ⌊q·n⌋', () => {
    const s = [10, 20, 30, 40, 50]
    expect(quantileRank(s, 0.1)).toBe(10) // rank 0.5 → 0
    expect(quantileRank(s, 0.2)).toBe(20) // rank 1
    expect(quantileRank(s, 1)).toBe(50) // capped at the last
  })
})

describe('nmad', () => {
  it('is NMAD_K times the median absolute deviation about the median', () => {
    // median 3, deviations 2 1 0 1 2 → MAD 1
    expect(nmad([1, 2, 3, 4, 5])).toBeCloseTo(NMAD_K, 12)
  })
  it('ignores a blunder that would dominate a standard deviation', () => {
    expect(nmad([1, 2, 3, 4, 1e6])).toBeCloseTo(NMAD_K, 12)
  })
  it('measures about a given centre', () => {
    // about 0: |x| = 1 2 3 4 5 → median 3
    expect(nmad([1, 2, 3, 4, 5], 0)).toBeCloseTo(3 * NMAD_K, 12)
  })
  it('estimates σ of a normal sample', () => {
    // A deterministic normal sample: the inverse CDF at evenly spaced probabilities.
    const n = 2001
    const v = []
    for (let i = 1; i <= n; i++) v.push(2.5 * probit(i / (n + 1)))
    expect(nmad(v)).toBeCloseTo(2.5, 2)
  })
})

describe('clamp', () => {
  it('limits to the range', () => {
    expect(clamp(-1, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
    expect(clamp(2, 0, 1)).toBe(1)
    expect(clamp(NaN, 0, 1)).toBeNaN()
  })
})

// Acklam's rational approximation of the normal quantile (|error| < 1.2e-9).
function probit(p) {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  if (p > 1 - lo) return -probit(1 - p)
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  )
}

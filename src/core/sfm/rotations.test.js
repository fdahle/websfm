import { describe, it, expect } from 'vitest'
import {
  I3,
  matMul3,
  matT3,
  rotAngleDeg,
  eigSym3,
  essentialSingularValues,
} from './rotations.js'

describe('matMul3', () => {
  it('is the identity element on the left', () => {
    const A = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
    expect(matMul3(I3, A)).toEqual(A)
  })

  it('computes a known product', () => {
    const A = [[1, 2, 0], [0, 1, 0], [0, 0, 1]]
    const B = [[1, 0, 0], [3, 1, 0], [0, 0, 1]]
    expect(matMul3(A, B)).toEqual([[7, 2, 0], [3, 1, 0], [0, 0, 1]])
  })
})

describe('matT3', () => {
  it('transposes a 3×3 matrix', () => {
    expect(matT3([[1, 2, 3], [4, 5, 6], [7, 8, 9]]))
      .toEqual([[1, 4, 7], [2, 5, 8], [3, 6, 9]])
  })
})

describe('rotAngleDeg', () => {
  it('is 0 for the identity', () => {
    expect(rotAngleDeg(I3)).toBeCloseTo(0, 10)
  })

  it('is 180 for a 180° rotation about z', () => {
    expect(rotAngleDeg([[-1, 0, 0], [0, -1, 0], [0, 0, 1]])).toBeCloseTo(180, 10)
  })

  it('is 90 for a 90° rotation about z', () => {
    expect(rotAngleDeg([[0, -1, 0], [1, 0, 0], [0, 0, 1]])).toBeCloseTo(90, 10)
  })

  it('clamps numerically past the acos domain', () => {
    // tr slightly above 3 (rounding) must not yield NaN.
    expect(rotAngleDeg([[1.0000001, 0, 0], [0, 1, 0], [0, 0, 1]])).toBeCloseTo(0, 6)
  })
})

describe('eigSym3', () => {
  it('returns diagonal entries sorted descending for a diagonal matrix', () => {
    expect(eigSym3([[3, 0, 0], [0, 1, 0], [0, 0, 2]])).toEqual([3, 2, 1])
  })

  it('recovers the spectrum of a symmetric block matrix', () => {
    // [[2,1],[1,2]] block has eigenvalues 3 and 1; plus a 3 on the diagonal.
    const ev = eigSym3([[2, 1, 0], [1, 2, 0], [0, 0, 3]])
    expect(ev[0]).toBeCloseTo(3, 6)
    expect(ev[1]).toBeCloseTo(3, 6)
    expect(ev[2]).toBeCloseTo(1, 6)
  })
})

describe('essentialSingularValues', () => {
  it('gives σ1≈σ2 and σ3≈0 for a valid essential matrix', () => {
    // E = [t]× R with t = (0,0,1), R = I → [[0,-1,0],[1,0,0],[0,0,0]].
    const { s1, s2, s3 } = essentialSingularValues([0, -1, 0, 1, 0, 0, 0, 0, 0])
    expect(s1).toBeCloseTo(1, 6)
    expect(s2).toBeCloseTo(1, 6)
    expect(s3).toBeCloseTo(0, 6)
  })
})

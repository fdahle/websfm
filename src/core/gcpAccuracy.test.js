import { beforeAll, describe, expect, it } from 'vitest'
import proj4 from 'proj4'
import { ensureProjection } from './crs.js'
import {
  confidenceToSigma, covarianceFromGcp, covarianceFields, normalizedGroundResidual,
  precisionInSfmFrame, reprojectGcpWithAccuracy,
} from './gcpAccuracy.js'

beforeAll(() => ensureProjection('EPSG:32632'))

describe('GCP uncertainty', () => {
  it('normalizes declared confidence levels to one sigma', () => {
    expect(confidenceToSigma(2, '2sigma')).toBe(1)
    expect(confidenceToSigma(1.959963984540054, '95')).toBeCloseTo(1)
    expect(confidenceToSigma('', '1sigma')).toBeNull()
  })

  it('round-trips sigmas and correlations through covariance', () => {
    const g = { accuracyX: 1, accuracyY: 2, accuracyZ: 4,
      correlationXY: 0.25, correlationXZ: -0.1, correlationYZ: 0.2 }
    expect(covarianceFields(covarianceFromGcp(g))).toMatchObject(g)
  })

  it('computes covariance-aware normalized residuals', () => {
    const g = { accuracyX: 1, accuracyY: 2, accuracyZ: 4,
      correlationXY: 0, correlationXZ: 0, correlationYZ: 0 }
    const out = normalizedGroundResidual(g, [1, 2, 4])
    expect(out.axes).toEqual([1, 1, 1])
    expect(out.chi2).toBeCloseTo(3)
  })

  it('rotates anisotropic precision into the SfM frame', () => {
    const g = { accuracyX: 1, accuracyY: 2, accuracyZ: 4,
      correlationXY: 0, correlationXZ: 0, correlationYZ: 0 }
    const R = [[0,-1,0],[1,0,0],[0,0,1]]
    const P = precisionInSfmFrame(g, { scale: 2, R })
    expect(P[0][0]).toBeCloseTo(1)       // 4 × 1/σy²
    expect(P[1][1]).toBeCloseTo(4)       // 4 × 1/σx²
    expect(P[2][2]).toBeCloseTo(0.25)    // 4 × 1/σz²
  })

  it('propagates coordinates and covariance when CRS linear units change', () => {
    proj4.defs('TEST:UTMFT', '+proj=utm +zone=32 +datum=WGS84 +units=us-ft +no_defs')
    const out = reprojectGcpWithAccuracy({ x: 500000, y: 0, z: 10,
      accuracyX: 1, accuracyY: 2, accuracyZ: 3,
      correlationXY: 0, correlationXZ: 0, correlationYZ: 0 }, 'EPSG:32632', 'TEST:UTMFT')
    expect(out.x).toBeCloseTo(1640416.6667, 2)
    expect(out.z).toBeCloseTo(32.8083333, 5)
    expect(out.accuracyX).toBeCloseTo(3.2808333, 4)
    expect(out.accuracyY).toBeCloseTo(6.5616667, 4)
    expect(out.accuracyZ).toBeCloseTo(9.8425, 4)
  })
})

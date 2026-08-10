import { isGeographic, metresPerCrsUnit, transform } from './crs.js'

export const GCP_ACCURACY_PRESETS = {
  unknown:       { label: 'Unknown (do not constrain)', x: null,  y: null,  z: null },
  'rtk-fixed':   { label: 'RTK fixed',                  x: 0.02,  y: 0.02,  z: 0.05 },
  'rtk-float':   { label: 'RTK float',                  x: 0.20,  y: 0.20,  z: 0.50 },
  'total-station': { label: 'Total station',            x: 0.005, y: 0.005, z: 0.01 },
  'map-picked':  { label: 'Map / ortho picked',         x: 2.0,   y: 2.0,   z: 5.0 },
  custom:        { label: 'Custom',                     x: 1.0,   y: 1.0,   z: 1.0 },
}

// Convert a declared confidence convention to one-standard-deviation values.
export function confidenceToSigma(value, convention = '1sigma', axis = 'x') {
  if (!(Number.isFinite(Number(value)) && Number(value) > 0)) return null
  const divisor = convention === 'hrms'
    ? (axis === 'z' ? 1 : Math.SQRT2)
    : convention === 'cep95'
      ? (axis === 'z' ? 1.959963984540054 : Math.sqrt(-2 * Math.log(0.05)))
      : ({ '1sigma': 1, '2sigma': 2, '95': 1.959963984540054 }[convention] ?? 1)
  return Number(value) / divisor
}

const corr = (value) => Number.isFinite(Number(value))
  ? Math.max(-0.999, Math.min(0.999, Number(value))) : 0

export function covarianceFromGcp(gcp) {
  const s = [gcp?.accuracyX, gcp?.accuracyY, gcp?.accuracyZ].map(Number)
  if (!s.every((v) => Number.isFinite(v) && v > 0)) return null
  const rxy = corr(gcp?.correlationXY), rxz = corr(gcp?.correlationXZ), ryz = corr(gcp?.correlationYZ)
  return [
    [s[0] * s[0], rxy * s[0] * s[1], rxz * s[0] * s[2]],
    [rxy * s[0] * s[1], s[1] * s[1], ryz * s[1] * s[2]],
    [rxz * s[0] * s[2], ryz * s[1] * s[2], s[2] * s[2]],
  ]
}

export function invert3(m) {
  const a=m[0][0], b=m[0][1], c=m[0][2], d=m[1][0], e=m[1][1], f=m[1][2],
    g=m[2][0], h=m[2][1], i=m[2][2]
  const A=e*i-f*h, B=c*h-b*i, C=b*f-c*e
  const D=f*g-d*i, E=a*i-c*g, F=c*d-a*f
  const G=d*h-e*g, H=b*g-a*h, I=a*e-b*d
  const det=a*A+b*D+c*G
  if (!Number.isFinite(det) || Math.abs(det) < 1e-24) return null
  const q=1/det
  return [[A*q,B*q,C*q],[D*q,E*q,F*q],[G*q,H*q,I*q]]
}

export const precisionFromGcp = (gcp) => {
  const covariance = covarianceFromGcp(gcp)
  if (!covariance) return null
  const det2 = covariance[0][0]*covariance[1][1]-covariance[0][1]*covariance[1][0]
  const determinant = covariance[0][0]*(covariance[1][1]*covariance[2][2]-covariance[1][2]*covariance[2][1])
    - covariance[0][1]*(covariance[1][0]*covariance[2][2]-covariance[1][2]*covariance[2][0])
    + covariance[0][2]*(covariance[1][0]*covariance[2][1]-covariance[1][1]*covariance[2][0])
  return covariance[0][0] > 0 && det2 > 0 && determinant > 0 ? invert3(covariance) : null
}

const mul = (a, b) => a.map((row) => b[0].map((_, j) =>
  row.reduce((sum, value, k) => sum + value * b[k][j], 0)))
const transpose = (m) => m[0].map((_, j) => m.map((row) => row[j]))

export function transformCovariance(covariance, jacobian) {
  return mul(mul(jacobian, covariance), transpose(jacobian))
}

export function covarianceFields(covariance) {
  const sigma = [0, 1, 2].map((axis) => Math.sqrt(Math.max(0, covariance[axis][axis])))
  const correlation = (a, b) => sigma[a] > 0 && sigma[b] > 0
    ? Math.max(-0.999, Math.min(0.999, covariance[a][b] / (sigma[a] * sigma[b]))) : 0
  return {
    accuracyX: sigma[0], accuracyY: sigma[1], accuracyZ: sigma[2],
    correlationXY: correlation(0, 1), correlationXZ: correlation(0, 2), correlationYZ: correlation(1, 2),
  }
}

// Numerical Jacobian for horizontal reprojection plus linear-unit scaling for Z.
// It propagates the full covariance, including correlations, across CRS changes.
export function reprojectGcpWithAccuracy(gcp, fromCrs, toCrs) {
  const source = [gcp.x, gcp.y, gcp.z ?? 0]
  const target = transform(source, fromCrs, toCrs)
  const stepX = isGeographic(fromCrs) ? 1e-6 : Math.max(1e-3, Math.abs(gcp.x) * 1e-8)
  const stepY = isGeographic(fromCrs) ? 1e-6 : Math.max(1e-3, Math.abs(gcp.y) * 1e-8)
  const tx = transform([gcp.x + stepX, gcp.y, source[2]], fromCrs, toCrs)
  const ty = transform([gcp.x, gcp.y + stepY, source[2]], fromCrs, toCrs)
  // Geographic horizontal axes are angular, but their Z convention remains
  // physical metres. Treat that as factor 1 when crossing to/from a linear CRS.
  const fromFactor = metresPerCrsUnit(fromCrs) ?? 1
  const toFactor = metresPerCrsUnit(toCrs) ?? 1
  const zScale = fromFactor / toFactor
  const J = [
    [(tx[0]-target[0])/stepX, (ty[0]-target[0])/stepY, 0],
    [(tx[1]-target[1])/stepX, (ty[1]-target[1])/stepY, 0],
    [0, 0, zScale],
  ]
  const covariance = covarianceFromGcp(gcp)
  return {
    ...gcp,
    x: target[0], y: target[1], z: gcp.z == null ? null : gcp.z * zScale,
    ...(covariance ? covarianceFields(transformCovariance(covariance, J)) : {}),
  }
}

export function precisionInSfmFrame(gcp, fit) {
  const precision = precisionFromGcp(gcp)
  if (!precision || !fit?.R || !(fit.scale > 0)) return null
  // e_crs = scale·R·e_sfm, so P_sfm = scale²·Rᵀ·P_crs·R.
  const rotated = mul(mul(transpose(fit.R), precision), fit.R)
  return rotated.map((row) => row.map((value) => value * fit.scale * fit.scale))
}

export function normalizedGroundResidual(gcp, residual) {
  const precision = precisionFromGcp(gcp)
  if (!precision || !residual?.every(Number.isFinite)) return null
  const pr = precision.map((row) => row.reduce((sum, value, j) => sum + value * residual[j], 0))
  const chi2 = residual.reduce((sum, value, i) => sum + value * pr[i], 0)
  return { chi2, normalized: Math.sqrt(Math.max(0, chi2)),
    axes: residual.map((value, i) => value / gcp[['accuracyX','accuracyY','accuracyZ'][i]]) }
}

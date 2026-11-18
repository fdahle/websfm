// Ground lengths and areas on the WGS84 ellipsoid, for measuring on the 2D map itself
// (Tools ▸ Measure with the map as the layer): no raster under the drawing, so no
// grid to measure in, and a map in degrees has no linear unit at all. Every value is
// taken on the ellipsoid from longitude/latitude, so it does not depend on the
// project CRS the map shows.
//
// Lengths: Vincenty's inverse solution (Vincenty 1975), millimetre-exact for any pair
// that is not nearly antipodal; for one that is (it does not converge), the
// great-circle distance on the mean sphere, well under 1 % off, stands in.
// Areas: each vertex goes to its authalic latitude (Snyder 1987, eq. 3-11/3-12), which
// maps the ellipsoid onto a sphere of equal area, then to an oblique Lambert azimuthal
// equal-area projection of that sphere centred on the polygon (Snyder eq. 24-2/24-3),
// where the shoelace sum is the ellipsoidal area. Edges are straight in that
// projection rather than geodesics, which is negligible at the size a measurement is
// drawn (a relative error near (size / Earth radius)²).
//
// Pure: plain [lon, lat] degree pairs in, metres and square metres out.

import { WGS84_A, WGS84_E2, WGS84_F } from '../constants.js'
import { planimetricArea } from './measure.js'

const RAD = Math.PI / 180
const B = WGS84_A * (1 - WGS84_F)
const E = Math.sqrt(WGS84_E2)

// The longitude difference wrapped to (-180, 180]: a segment across the antimeridian
// is the short way round.
const wrap = (d) => d - 360 * Math.round(d / 360)

function sphereDistance([lon1, lat1], [lon2, lat2]) {
  const r = (2 * WGS84_A + B) / 3
  const dLat = (lat2 - lat1) * RAD,
    dLon = wrap(lon2 - lon1) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Ellipsoidal distance (m) between two [lon, lat] points in degrees (Vincenty 1975). */
export function geodesicDistance(p1, p2) {
  const f = WGS84_F
  const L = wrap(p2[0] - p1[0]) * RAD
  const U1 = Math.atan((1 - f) * Math.tan(p1[1] * RAD)),
    U2 = Math.atan((1 - f) * Math.tan(p2[1] * RAD))
  const sinU1 = Math.sin(U1),
    cosU1 = Math.cos(U1),
    sinU2 = Math.sin(U2),
    cosU2 = Math.cos(U2)
  let lambda = L,
    sinSigma,
    cosSigma,
    sigma,
    cos2Alpha,
    cos2SigmaM
  for (let iter = 0; iter < 200; iter++) {
    const sinLambda = Math.sin(lambda),
      cosLambda = Math.cos(lambda)
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
    if (sinSigma === 0) return 0 // the same point
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cos2Alpha = 1 - sinAlpha * sinAlpha
    // On the equator cos²α is 0 and the term drops out.
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha))
    const prev = lambda
    lambda =
      L +
      (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    if (Math.abs(lambda - prev) < 1e-12) {
      const u2 = (cos2Alpha * (WGS84_A * WGS84_A - B * B)) / (B * B)
      const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
      const Bc = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
      const dSigma =
        Bc *
        sinSigma *
        (cos2SigmaM +
          (Bc / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
              (Bc / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
      return B * A * (sigma - dSigma)
    }
  }
  return sphereDistance(p1, p2) // nearly antipodal: no convergence
}

/** Length (m) of a polyline of [lon, lat] points; `closed` adds the closing edge. */
export function geodesicLength(lonlats, { closed = false } = {}) {
  let total = 0
  for (let i = 1; i < lonlats.length; i++) total += geodesicDistance(lonlats[i - 1], lonlats[i])
  if (closed && lonlats.length > 2) total += geodesicDistance(lonlats[lonlats.length - 1], lonlats[0])
  return total
}

// q(φ) of Snyder eq. 3-12, and its value at the pole.
function authalicQ(sinPhi) {
  const es = E * sinPhi
  return (1 - WGS84_E2) * (sinPhi / (1 - es * es) - (1 / (2 * E)) * Math.log((1 - es) / (1 + es)))
}
const Q_POLE = authalicQ(1)
/** Radius (m) of the sphere with the ellipsoid's surface area (Snyder eq. 3-13). */
export const AUTHALIC_RADIUS = WGS84_A * Math.sqrt(Q_POLE / 2)
/** Authalic latitude (radians) of a geodetic latitude in degrees (Snyder eq. 3-11). */
export function authalicLatitude(latDeg) {
  return Math.asin(Math.max(-1, Math.min(1, authalicQ(Math.sin(latDeg * RAD)) / Q_POLE)))
}

/**
 * Ellipsoidal area (m²) of a polygon of [lon, lat] points in degrees (open ring), or
 * null when its edges cross. 0 below three points.
 */
export function ellipsoidArea(lonlats) {
  if (lonlats.length < 3) return 0
  // Longitudes unwrapped against the first vertex, so a polygon across the
  // antimeridian stays in one piece.
  const lon0 = lonlats[0][0]
  const lons = lonlats.map(([lon]) => lon0 + wrap(lon - lon0))
  const betas = lonlats.map(([, lat]) => authalicLatitude(lat))
  const lonC = (lons.reduce((s, v) => s + v, 0) / lons.length) * RAD
  const betaC = betas.reduce((s, v) => s + v, 0) / betas.length
  const sinC = Math.sin(betaC),
    cosC = Math.cos(betaC)
  const pts = lons.map((lon, i) => {
    const dl = lon * RAD - lonC,
      sb = Math.sin(betas[i]),
      cb = Math.cos(betas[i])
    const k = Math.sqrt(2 / (1 + sinC * sb + cosC * cb * Math.cos(dl)))
    return {
      x: AUTHALIC_RADIUS * k * cb * Math.sin(dl),
      y: AUTHALIC_RADIUS * k * (cosC * sb - sinC * cb * Math.cos(dl)),
    }
  })
  return planimetricArea(pts)
}

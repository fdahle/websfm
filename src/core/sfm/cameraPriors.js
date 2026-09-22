import { isGeographic, localMetricFrame, transform } from '../crs.js'
import { opkMatrix } from '../footprint.js'

const mulM3 = (A, B) => A.map((row) => B[0].map((_, col) =>
  row.reduce((sum, value, k) => sum + value * B[k][col], 0)))
const transposeM3 = (A) => A[0].map((_, col) => A.map((row) => row[col]))
const inverseM3 = (m) => {
  const a=m[0][0], b=m[0][1], c=m[0][2], d=m[1][0], e=m[1][1], f=m[1][2]
  const g=m[2][0], h=m[2][1], i=m[2][2]
  const det = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)
  if (!(Math.abs(det) > 1e-10)) return null
  return [
    [(e*i-f*h)/det, (c*h-b*i)/det, (b*f-c*e)/det],
    [(f*g-d*i)/det, (a*i-c*g)/det, (c*d-a*f)/det],
    [(d*h-e*g)/det, (b*g-a*h)/det, (a*e-b*d)/det],
  ]
}

// Convert an imported photogrammetric OPK pose to the solver's camera frame.
// OPK uses photo axes (x right, y up, optical axis -z); BA uses pixel axes
// (x right, y down, optical axis +z). D=diag(1,-1,-1) is that proper-rotation
// basis change. `fitRotation` maps SfM vectors into project-CRS vectors.
export function orientationPriorInSfm(pose, fitRotation) {
  if (![pose.omega, pose.phi, pose.kappa].every(Number.isFinite)) return null
  const sigmasDeg = [pose.accuracyOmega, pose.accuracyPhi, pose.accuracyKappa]
    .map((v) => Number.isFinite(v) && v > 0 ? v : 2)
  const M = opkMatrix(pose.omega, pose.phi, pose.kappa)
  const D = [[1,0,0],[0,-1,0],[0,0,-1]]
  const targetR = mulM3(mulM3(D, M), fitRotation)

  // Local differential from [dω,dφ,dκ] to the solver's left-multiplied
  // rotation vector. Transform diagonal OPK precision through it so each
  // imported angular accuracy retains its intended axis.
  const o = pose.omega * Math.PI / 180, ph = pose.phi * Math.PI / 180
  const co=Math.cos(o), so=Math.sin(o), cp=Math.cos(ph), sp=Math.sin(ph)
  const J = [[1,0,sp],[0,-co,so*cp],[0,-so,-co*cp]]
  const Ji = inverseM3(J)
  if (!Ji) return null // OPK gimbal lock: do not invent a singular prior.
  const weights = sigmasDeg.map((v) => 1 / ((v * Math.PI / 180) ** 2))
  const precision = mulM3(transposeM3(Ji), Ji.map((row, r) =>
    row.map((value) => weights[r] * value)))
  return { targetR, orientationPrecision: precision }
}

// Marshal enabled, fully-3D camera poses into worker-safe BA priors. XY-only
// fixes remain useful to the map/matcher but cannot constrain a Euclidean 3D
// solve. A geographic working CRS is converted into one survey-centred local
// metric frame: bundle adjustment must never mix angular XY with metre Z, but it
// also must not silently discard every GPS constraint merely because the project
// is displayed/exported in longitude and latitude.
//
// Imported OPK angles and their accuracies are retained so the SfM orchestrator
// can turn them into orientation constraints after fitting the SfM↔prior frame.
export function buildCameraPriors(poses, images, crs) {
  const uuidByImageId = new Map(images.map((image) => [image.id, image.uuid]))
  const usable = poses
    .filter((pose) => pose.enabled !== false
      && Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.z))
    .map((pose) => ({ pose, uuid: uuidByImageId.get(pose.imageId) }))
    .filter(({ uuid }) => uuid != null)

  let metricPositions = null
  if (isGeographic(crs) && usable.length) {
    const wgs84 = usable.map(({ pose }) => transform([pose.x, pose.y], crs, 'EPSG:4326'))
    if (!wgs84.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))) return []

    // Circular longitude mean keeps a survey straddling ±180° centred at the
    // antimeridian instead of placing its local frame on the opposite side of Earth.
    const lonRad = wgs84.map(([lon]) => lon * Math.PI / 180)
    const lon0 = Math.atan2(
      lonRad.reduce((sum, lon) => sum + Math.sin(lon), 0),
      lonRad.reduce((sum, lon) => sum + Math.cos(lon), 0),
    ) * 180 / Math.PI
    const lat0 = wgs84.reduce((sum, [, lat]) => sum + lat, 0) / wgs84.length
    const metric = localMetricFrame(lon0, lat0)
    metricPositions = wgs84.map((position) => transform(position, 'EPSG:4326', metric))
  }

  return usable.map(({ pose, uuid }, i) => {
    const [x, y] = metricPositions?.[i] ?? [pose.x, pose.y]
    const geographic = metricPositions != null
    return {
      uuid,
      x, y, z: geographic && Number.isFinite(pose.altitudeMeters) ? pose.altitudeMeters : pose.z,
      // EXIF poses retain canonical metre uncertainties. Prefer those in the
      // local metric frame; imported geographic-pose accuracies are documented
      // as physical metres and therefore pass through unchanged.
      accuracyX: geographic && Number.isFinite(pose.accuracyMetersX)
        ? pose.accuracyMetersX : pose.accuracyX,
      accuracyY: geographic && Number.isFinite(pose.accuracyMetersY)
        ? pose.accuracyMetersY : pose.accuracyY,
      accuracyZ: geographic && Number.isFinite(pose.accuracyMetersZ)
        ? pose.accuracyMetersZ : pose.accuracyZ,
      omega: pose.omega, phi: pose.phi, kappa: pose.kappa,
      accuracyOmega: pose.accuracyOmega, accuracyPhi: pose.accuracyPhi,
      accuracyKappa: pose.accuracyKappa,
      source: pose.source,
      ...(geographic ? { metricFrame: 'local-geographic' } : {}),
    }
  })
}

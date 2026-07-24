// Footprint synthesis: project an image's four corners onto a horizontal ground
// plane from a known camera pose (exterior orientation) + intrinsics. Used when
// positions/rotations are available but no footprint polygons were imported.
//
// CRS-agnostic: the camera centre and the returned ring are in whatever CRS the
// caller works in (the project working CRS in practice). Angles are degrees in
// the standard photogrammetric omega/phi/kappa convention — the rotation matrix
// M below maps an object-space vector into image/camera space, so Mᵀ maps an
// image-space ray back into object space.

// Standard photogrammetric omega/phi/kappa rotation matrix (object → image).
// At omega=phi=kappa=0 this is the identity, i.e. a nadir camera looking straight
// down with image x→east, y→north. Row-major 3×3.
export function opkMatrix(omegaDeg, phiDeg, kappaDeg) {
  const d = Math.PI / 180
  const co = Math.cos(omegaDeg * d), so = Math.sin(omegaDeg * d)
  const cp = Math.cos(phiDeg   * d), sp = Math.sin(phiDeg   * d)
  const ck = Math.cos(kappaDeg * d), sk = Math.sin(kappaDeg * d)
  return [
    [ cp * ck,              -cp * sk,               sp      ],
    [ co * sk + so * sp * ck,  co * ck - so * sp * sk, -so * cp ],
    [ so * sk - co * sp * ck,  so * ck + co * sp * sk,  co * cp ],
  ]
}

// Resolve a sensor's focal length to pixels. Returns null when it can't be
// determined (focal in mm with no pixel size — e.g. a bare EXIF sensor).
export function focalPx(sensor) {
  if (!sensor || sensor.focal == null) return null
  if (sensor.focalUnit === 'px') return sensor.focal
  // A focal value with a pixel size (mm/px) converts to pixels; an explicit mm
  // focal without one is unusable here.
  if (sensor.pixelSize) return sensor.focal / sensor.pixelSize
  // No unit and no pixel size: assume already in pixels (calibration files
  // usually carry focal in px). EXIF-derived sensors set focalUnit:'mm', so
  // they take the branch above and return null when pixelSize is missing.
  return sensor.focalUnit == null ? sensor.focal : null
}

// Minimum depression angle (degrees below horizontal) a corner ray must have to
// count. A ray grazing the ground plane (near-horizontal) hits it tens of
// thousands of km away — a footprint "covering the whole earth" — which is the
// signature of a bad focal (near-180° FOV from a garbage EXIF focal) or an
// oblique pose that sees past the horizon. At 1° the far corner sits at most
// ~57× the flying height, so genuine near-nadir aerial always clears it while the
// earth-spanning garbage is rejected. See projectFootprint's 'diverges' result.
export const MIN_RAY_DEPRESSION_DEG = 1

// Project one pixel (u,v) through the camera onto plane Z = groundZ.
// Returns [X, Y] (object space) or null if the ray doesn't usefully descend to
// the plane (camera at/below it, a ray pointing up — the horizon — or a ray so
// near-horizontal it would land absurdly far away; see MIN_RAY_DEPRESSION_DEG).
export function projectPixelToGround(u, v, { Mt, center, focal, cx, cy, groundZ, minSinDepression = 0 }) {
  // Image-space ray direction: photo x right, photo y up (pixel rows grow down,
  // hence the negation), optical axis at -focal.
  const vx = u - cx
  const vy = -(v - cy)
  const vz = -focal
  // Object-space direction = Mᵀ · [vx, vy, vz].
  const dx = Mt[0][0] * vx + Mt[0][1] * vy + Mt[0][2] * vz
  const dy = Mt[1][0] * vx + Mt[1][1] * vy + Mt[1][2] * vz
  const dz = Mt[2][0] * vx + Mt[2][1] * vy + Mt[2][2] * vz
  if (dz === 0) return null
  const s = (groundZ - center[2]) / dz
  if (s <= 0) return null   // plane is behind the camera along this ray
  // Reject a near-horizontal (grazing) ray: its depression below horizontal is
  // asin(-dz / |d|). Too shallow ⇒ the intersection is implausibly far.
  if (minSinDepression > 0) {
    const len = Math.hypot(dx, dy, dz)
    if (len === 0 || -dz / len < minSinDepression) return null
  }
  return [center[0] + s * dx, center[1] + s * dy]
}

// Project the four image corners onto plane Z = groundZ. Returns a discriminated
// result so callers can report *why* a footprint couldn't be made:
//   { rings: [[ [x,y], …, firstAgain ]] }   success (single closed ring)
//   { error: 'invalid' }      bad intrinsics or missing camera centre
//   { error: 'below_plane' }  camera at/below the ground plane (raise camera Z or
//                             lower the elevation)
//   { error: 'diverges' }     a corner ray points away from the plane — the view
//                             is too oblique (sees past the horizon) or the
//                             orientation angles use an unexpected convention
//
// pose:   { x, y, z, omega, phi, kappa }  — centre in object space, angles in degrees
// sensor: { focal(px), cx, cy, width, height } — cx/cy default to the image centre
export function projectFootprint(pose, sensor, groundZ) {
  const focal = sensor.focal
  const { width, height } = sensor
  if (!(focal > 0) || !(width > 0) || !(height > 0)) return { error: 'invalid' }
  if (pose.x == null || pose.y == null || pose.z == null || groundZ == null) return { error: 'invalid' }
  if (groundZ >= pose.z) return { error: 'below_plane' }   // camera must be above the plane

  const cx = sensor.cx ?? width / 2
  const cy = sensor.cy ?? height / 2
  const M = opkMatrix(pose.omega ?? 0, pose.phi ?? 0, pose.kappa ?? 0)
  // Transpose (object ← image).
  const Mt = [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ]
  const minSinDepression = Math.sin((MIN_RAY_DEPRESSION_DEG * Math.PI) / 180)
  const ctx = { Mt, center: [pose.x, pose.y, pose.z], focal, cx, cy, groundZ, minSinDepression }

  const corners = [[0, 0], [width, 0], [width, height], [0, height]]
  const ring = []
  for (const [u, v] of corners) {
    const g = projectPixelToGround(u, v, ctx)
    if (!g) return { error: 'diverges' }
    ring.push(g)
  }
  ring.push([ring[0][0], ring[0][1]])   // close the ring (GeoJSON convention)
  return { rings: [ring] }
}

// Core value types for the SfM pipeline.
//
// These are the vocabulary the compute modules speak in. They exist mainly to
// pin down two classes of bug the JS code can't catch on its own:
//   1. Matrix layout — every Mat3 here is ROW-MAJOR. R[i][j] is row i, col j.
//      (The wasm boundary flattens row-major; see reconstruction.js.)
//   2. Which-CRS confusion — coordinates are tagged with the CRS they live in,
//      so transforming source coords as if they were project coords is a type
//      error rather than a silent geographic blunder.
//
// Pure types only: this module emits no runtime code and imports no
// Vue/Pinia/wasm. JS modules consume these via JSDoc, e.g.
//   /** @param {import('./types').Pose} pose */

// ── Linear algebra ────────────────────────────────────────────────────────────

/** A 3-vector. As a translation it is [tx, ty, tz]; as a point [x, y, z]. */
export type Vec3 = [number, number, number]

/** A 2-vector, e.g. an image-plane coordinate [x, y]. */
export type Vec2 = [number, number]

/**
 * A 3×3 matrix in ROW-MAJOR order: `M[row][col]`.
 * Rotations (`Pose.R`) and fundamental/essential matrices use this layout.
 */
export type Mat3 = [Vec3, Vec3, Vec3]

// ── Camera geometry ───────────────────────────────────────────────────────────

/**
 * Pinhole intrinsics in pixels. The K matrix is
 * `[[fx, 0, cx], [0, fy, cy], [0, 0, 1]]`.
 */
export interface Intrinsics {
  fx: number
  fy: number
  cx: number
  cy: number
}

/**
 * Camera exterior orientation (extrinsics): rotation + translation that map a
 * world point into the camera frame. This is what the reconstruction/bundle
 * modules pass around as a "camera".
 */
export interface Pose {
  /** Row-major rotation. */
  R: Mat3
  /** Translation [tx, ty, tz]. */
  t: Vec3
}

/** Alias: a reconstructed camera is its pose; intrinsics live in {@link Sensor}. */
export type Camera = Pose

/** A triangulated / bundle-adjusted 3D point. */
export interface Point3 {
  x: number
  y: number
  z: number
}

/** A 2D observation of a 3D point in a given camera, in pixel coords. */
export interface Observation {
  camIdx: number
  ptIdx: number
  x: number
  y: number
}

// ── Sensor (shared intrinsics) ────────────────────────────────────────────────

/**
 * A "sensor" is the calibration shared by many images: focal length, principal
 * point, lens distortion, pixel/sensor size and the dimensions it applies to.
 * Any numeric field may be `null` when unknown (e.g. straight from EXIF).
 */
export interface Sensor {
  label: string
  width: number | null
  height: number | null
  /** Focal length; unit given by {@link Sensor.focalUnit} (default px). */
  focal: number | null
  /** Set to 'mm' for EXIF-seeded sensors; absent means pixels. */
  focalUnit?: 'mm' | 'px'
  cx: number | null
  cy: number | null
  k1: number | null
  k2: number | null
  k3: number | null
  p1: number | null
  p2: number | null
  /** mm per pixel — converts an mm focal to px (focal / pixelSize). */
  pixelSize: number | null
  /** Film/sensor format width in mm — the alternative mm→px conversion for
   *  film cameras (fx = focal / sensorWidthMm × width). */
  sensorWidthMm?: number | null
}

// ── CRS-tagged coordinates ────────────────────────────────────────────────────

/** A CRS authority code, e.g. 'EPSG:4326' or 'EPSG:3031' (Antarctic Polar). */
export type CrsCode = string

declare const crsTag: unique symbol

/**
 * A coordinate branded with the CRS it lives in. The brand is phantom (erased
 * at runtime) — the underlying value is still a plain `[x, y]` / `[x, y, z]`.
 * Tagging makes "fed a source-CRS coord where a project-CRS coord was wanted"
 * a compile-time error. Use {@link asCrs} to tag and `transform()` to convert.
 */
export type CrsCoord<C extends CrsCode = CrsCode> = (Vec2 | Vec3) & {
  readonly [crsTag]?: C
}

/** Tag a raw coordinate as belonging to CRS `C` (no runtime cost). */
export function asCrs<C extends CrsCode>(coord: Vec2 | Vec3): CrsCoord<C> {
  return coord as CrsCoord<C>
}

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

/**
 * Dense point cloud — stored **flat**, not as an array of point objects. A fused
 * dense cloud is millions of points; boxed `{x,y,z,color}` objects were ~110 B each
 * (the fusion OOM's main-thread tail). Position/colour live in split typed arrays
 * (Structure-of-Arrays), fed straight to the viewer / PLY / DEM. Sparse clouds keep
 * the object-array shape (they carry per-point view-tracks). See useReconstructionStore.
 */
export interface DenseCloud {
  count: number
  /** xyz per point, length 3·count. */
  pos: Float32Array
  /** rgb (0–255) per point, length 3·count; null when uncoloured. */
  col: Uint8Array | null
  /**
   * World-space unit normals, length 3·count. Present when the dense run produced
   * them (reused PatchMatch plane normals) — the oriented-normal input to screened
   * Poisson meshing. Undefined on legacy/normal-less runs (do NOT heal).
   */
  nrm?: Float32Array
}

/**
 * Triangle mesh product — screened-Poisson surface over a dense cloud. Flat, like
 * DenseCloud (no per-vertex objects). `count` is the triangle count; `nVerts` the
 * vertex count. Positions/colours are per-vertex; `idx` indexes triangles into them.
 */
export interface MeshCloud {
  /** triangle count. */
  count: number
  /** vertex count. */
  nVerts: number
  /** xyz per vertex, length 3·nVerts. */
  pos: Float32Array
  /** triangle vertex indices, length 3·count. */
  idx: Uint32Array
  /** rgb (0–255) per vertex, length 3·nVerts; null when uncoloured. */
  col: Uint8Array | null
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
  /** Digital (default) vs scanned film (fiducial interior orientation, F4).
   *  Absent ⇒ 'digital' (back-compat). */
  kind?: 'digital' | 'film'
  /** Calibrated interior orientation for a film sensor (only when kind==='film'). */
  fiducials?: Fiducials
}

// ── Fiducial-mark interior orientation (F4) ───────────────────────────────────

/** One calibrated fiducial mark, position in mm in the certificate's camera frame. */
export interface FiducialMark {
  id: string
  xMm: number
  yMm: number
}

/** A film sensor's calibrated fiducial layout + principal point + focal, all mm. */
export interface Fiducials {
  marks: FiducialMark[]
  /** Principal point (autocollimation), mm, same origin as the marks. */
  ppxMm: number
  ppyMm: number
  /** Calibrated focal length (certificate value), mm. */
  focalMm: number
}

/** One clicked scan-pixel observation of a fiducial mark on an image (F4). */
export interface FiducialObservation {
  fidId: string
  px: number
  py: number
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

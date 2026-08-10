import init, { recover_pose, triangulate_dlt, solve_pnp, bundle_adjust, compute_depth_map }
  from '../../wasm/reconstruction/reconstruction.js'

let initPromise = null
function ensureWasm() {
  if (!initPromise) initPromise = init()
  return initPromise
}

// Common sensor widths (mm), matched as lowercased substrings of "make model".
// Last-resort fallback when EXIF carries a real focal length but no 35mm
// equivalent and no focal-plane resolution. Extend as needed.
const SENSOR_WIDTH_MM = [
  // Full-frame (~36mm)
  ['canon eos 5d', 35.8], ['canon eos 6d', 35.8], ['canon eos r', 36.0], ['canon eos-1d x', 36.0],
  ['nikon d6', 35.9], ['nikon d8', 35.9], ['nikon z', 35.9],
  ['sony ilce-7', 35.6], ['sony ilce-9', 35.6], ['sony dsc-rx1', 35.8],
  // APS-C (~23.5mm)
  ['canon eos 7d', 22.3], ['canon eos 80d', 22.3], ['canon eos 90d', 22.3], ['canon eos m', 22.3],
  ['nikon d3', 23.5], ['nikon d5', 23.5], ['nikon d7', 23.5], ['sony ilce-6', 23.5],
  // Micro-Four-Thirds
  ['dmc-gh', 17.3], ['dc-gh', 17.3], ['e-m', 17.3],
]

function sensorWidthFromDb(meta) {
  const key = `${meta?.make ?? ''} ${meta?.model ?? ''}`.toLowerCase()
  for (const [needle, mm] of SENSOR_WIDTH_MM) if (key.includes(needle)) return mm
  return null
}

// Physical sensor width (mm) from EXIF focal-plane resolution (how exiftool/COLMAP
// derive sensor size), else a make/model table. FocalPlaneResolutionUnit: 2=inch,
// 3=cm, 4=mm. Returns null when nothing usable is available.
export function sensorWidthMm(meta) {
  const res = meta?.focalPlaneXRes
  const w = meta?.width
  if (res && w) {
    const unitMm = meta?.focalPlaneResUnit === 3 ? 10 : meta?.focalPlaneResUnit === 4 ? 1 : 25.4
    const mm = (w / res) * unitMm
    if (mm > 1 && mm < 80) return mm   // reject implausible values from bad EXIF
  }
  return sensorWidthFromDb(meta)
}

// True when a physical film width (mm) matches a standard aerial format within
// ±5%. Historical mapping cameras use 230mm (9") or 240mm frames; a scan whose
// implied width is far from these usually means a wrong pixel pitch.
export function isKnownAerialFilmWidth(mm) {
  return [230, 240].some((w) => Math.abs(mm - w) / w <= 0.05)
}

// Resolve K intrinsics (pixels) for one image, preferring the (user-editable)
// assigned sensor over raw EXIF. Order of reliability:
//   1. sensor focal already in pixels        (table value — authoritative)
//   2. sensor focal (mm) × imageWidth ÷ sensor/film width (mm) (table value —
//      the natural film-camera input: focal + format from a calibration sheet)
//   3. sensor focal (mm) ÷ pixel size         (table value — a scan pitch is more
//      often wrong than a declared format, so it ranks below it; see path 2)
//   4. EXIF 35mm-equivalent focal
//   5. focal (mm, from sensor or EXIF) × imageWidth ÷ derivable sensor width
//   6. default-FOV guess (fx = max(w,h)) — poor; registration may fail
// Returns { fx, fy, cx, cy, source } where `source` explains the path taken.
export function resolveK(meta, sensor = null) {
  const w = sensor?.width || meta?.width || 1000
  const h = sensor?.height || meta?.height || 1000
  const cx = sensor?.cx ?? w / 2
  const cy = sensor?.cy ?? h / 2

  // 0. Fiducial interior orientation (F4): a film sensor whose per-image affine
  //    fit gave a canonical pixel frame. sfm.js computes the frame and stashes it
  //    on the sensor as `_fiducialK` (a plain K + a source label) — it is
  //    authoritative, the whole reason the keypoints were moved into that frame.
  if (sensor?._fiducialK) {
    const { fx, fy, cx: fcx, cy: fcy } = sensor._fiducialK
    return { fx, fy, cx: fcx, cy: fcy, source: sensor._fiducialK.source ?? 'fiducial interior orientation' }
  }

  // A focal in mm only — px focals are handled separately in path 1.
  const sensorFocalMm = (sensor?.focal != null && sensor.focalUnit !== 'px') ? sensor.focal : null

  // 1. Sensor with an explicit pixel focal — the edited table wins outright.
  if (sensor?.focal != null && sensor.focalUnit === 'px') {
    return { fx: sensor.focal, fy: sensor.focal, cx, cy, source: 'sensor table (focal in px)' }
  }

  // 2. Sensor focal in mm + film/sensor width in mm → fx = focal/widthMm × w.
  //    The standard scanned-aerial-film input: focal length and format size from the
  //    camera calibration certificate, no pixel size needed. This is checked BEFORE the
  //    pixel-size path because a declared format is measured ground truth, whereas a
  //    scan pitch is usually inferred from the scanner setting and is the value that
  //    goes wrong (the CA…V set's 0.025mm/px implies a 253mm frame — no such film
  //    exists — for a ~9% focal error). When both are present the certificate wins, and
  //    the pitch is then only a cross-check.
  if (sensorFocalMm != null && sensor.sensorWidthMm) {
    const fx = (sensorFocalMm / sensor.sensorWidthMm) * w
    return { fx, fy: fx, cx, cy, source: `sensor table (${sensorFocalMm}mm, ${sensor.sensorWidthMm}mm format)` }
  }

  // 3. Sensor focal in mm + a pixel size → fx = focal / pixelSize.
  if (sensorFocalMm != null && sensor.pixelSize) {
    const fx = sensorFocalMm / sensor.pixelSize
    // Sanity check: widthPx × pitch is the physical film width the scan implies.
    // Standard aerial film is ~230mm or ~240mm; a wildly different value (e.g. a
    // full-frame scan at the wrong pitch) silently distorts every focal downstream.
    const impliedFilmWidthMm = w * sensor.pixelSize
    return {
      fx, fy: fx, cx, cy,
      source: `sensor table (${sensorFocalMm}mm ÷ ${sensor.pixelSize}mm/px)`,
      impliedFilmWidthMm,
      filmWidthOk: isKnownAerialFilmWidth(impliedFilmWidthMm),
    }
  }

  // 4. EXIF 35mm-equivalent focal length.
  if (meta?.focalLength35) {
    const fx = (meta.focalLength35 / 36) * w
    return { fx, fy: fx, cx, cy, source: 'EXIF 35mm-equivalent focal' }
  }

  // 5. A real focal (mm) — sensor's or EXIF's — plus a derivable sensor width.
  const focalMm = sensorFocalMm ?? meta?.focalLength
  if (focalMm) {
    const sw = sensorWidthMm(meta)
    if (sw) {
      const fx = (focalMm / sw) * w
      return { fx, fy: fx, cx, cy, source: `focal ${focalMm}mm (sensor width ${sw.toFixed(1)}mm)` }
    }
  }

  // 6. No usable calibration. Distinguish "no focal at all" from "focal known but
  //    no sensor/pixel size to convert it" — the latter is fixable in the table.
  const fx = Math.max(w, h)
  const why = focalMm
    ? `default FOV (focal ${focalMm}mm present but no pixel size or film/sensor format to convert it)`
    : 'default FOV (no focal length in metadata)'
  return { fx, fy: fx, cx, cy, source: why }
}

// Back-compat / metadata-only estimate (no sensor override).
export function estimateK(meta) {
  return resolveK(meta, null)
}

// Build a flat 12-element projection matrix P = [R|t] (normalised coords, no K).
// R is row-major 3×3, t is [tx, ty, tz].
export function makeP34flat(R, t) {
  return new Float32Array([
    R[0][0], R[0][1], R[0][2], t[0],
    R[1][0], R[1][1], R[1][2], t[1],
    R[2][0], R[2][1], R[2][2], t[2],
  ])
}

// Compute E = Kb^T * F * Ka where Ka, Kb are { fx, fy, cx, cy }.
// F is a 3×3 row-major array [[…],[…],[…]].
// Returns 9-element Float32Array (row-major).
export function fundamentalToEssential(F, Ka, Kb) {
  // K as 3×3
  const ka = [[Ka.fx,0,Ka.cx],[0,Ka.fy,Ka.cy],[0,0,1]]
  const kb = [[Kb.fx,0,Kb.cx],[0,Kb.fy,Kb.cy],[0,0,1]]
  // E = Kb^T * F * Ka
  const mul = (A, B) => {
    const C = [[0,0,0],[0,0,0],[0,0,0]]
    for (let i=0;i<3;i++) for (let j=0;j<3;j++) for (let k=0;k<3;k++) C[i][j]+=A[i][k]*B[k][j]
    return C
  }
  const kbT = [[kb[0][0],kb[1][0],kb[2][0]],[kb[0][1],kb[1][1],kb[2][1]],[kb[0][2],kb[1][2],kb[2][2]]]
  const FKa = mul(F, ka)
  const E = mul(kbT, FKa)
  return new Float32Array([E[0][0],E[0][1],E[0][2],E[1][0],E[1][1],E[1][2],E[2][0],E[2][1],E[2][2]])
}

// Recover camera B pose from essential matrix E via cheirality check.
// ptsA/ptsB: array of { x, y } pixel coords (image A and B respectively).
// Ka: intrinsics of camera A (for cheirality back-projection).
// Returns { R: [[…]×3], t: [tx,ty,tz] } in normalised coords, or null.
export async function recoverPose(ptsA, ptsB, E, Ka) {
  await ensureWasm()
  const n = Math.min(ptsA.length, ptsB.length)
  if (n < 5) return null

  const flatA = new Float32Array(n * 2)
  const flatB = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    flatA[i*2] = ptsA[i].x; flatA[i*2+1] = ptsA[i].y
    flatB[i*2] = ptsB[i].x; flatB[i*2+1] = ptsB[i].y
  }

  const raw = recover_pose(flatA, flatB, E, Ka.fx, Ka.fy, Ka.cx, Ka.cy)
  if (!raw || raw.length < 12) return null

  return {
    R: [[raw[0],raw[1],raw[2]],[raw[3],raw[4],raw[5]],[raw[6],raw[7],raw[8]]],
    t: [raw[9], raw[10], raw[11]],
  }
}

// Triangulate N matched point pairs (normalised image coords) given two
// flat 12-element projection matrices (no K baked in).
// ptsA/ptsB: arrays of { x, y } in normalised coords ((pixel - c) / f).
// Returns array of { x, y, z } (NaN entries filtered out).
export async function triangulateDlt(ptsA, ptsB, PA, PB) {
  await ensureWasm()
  const n = Math.min(ptsA.length, ptsB.length)
  if (n === 0) return []

  const flatA = new Float32Array(n * 2)
  const flatB = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    flatA[i*2] = ptsA[i].x; flatA[i*2+1] = ptsA[i].y
    flatB[i*2] = ptsB[i].x; flatB[i*2+1] = ptsB[i].y
  }

  const raw = triangulate_dlt(flatA, flatB, PA, PB)
  const pts = []
  for (let i = 0; i < n; i++) {
    const x = raw[i*3], y = raw[i*3+1], z = raw[i*3+2]
    if (!isNaN(x) && !isNaN(y) && !isNaN(z) && isFinite(x) && isFinite(y) && isFinite(z)) {
      pts.push({ x, y, z, srcIdx: i })
    }
  }
  return pts
}

// RANSAC PnP: estimate camera pose from 3D-2D correspondences.
// pts3d: [{ x,y,z }], pts2d: [{ x,y }] (pixel coords).
// Returns { R, t, inlierMask } or null.
export async function solvePnp(pts3d, pts2d, K, opts = {}) {
  await ensureWasm()
  const { ransacThreshPx = 4.0, maxIters = 200 } = opts
  const n = Math.min(pts3d.length, pts2d.length)
  if (n < 6) return null

  const flat3 = new Float32Array(n * 3)
  const flat2 = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    flat3[i*3] = pts3d[i].x; flat3[i*3+1] = pts3d[i].y; flat3[i*3+2] = pts3d[i].z
    flat2[i*2] = pts2d[i].x; flat2[i*2+1] = pts2d[i].y
  }

  const raw = solve_pnp(flat3, flat2, K.fx, K.fy, K.cx, K.cy, ransacThreshPx, maxIters)
  if (!raw || raw.length < 12 + n) return null

  return {
    R: [[raw[0],raw[1],raw[2]],[raw[3],raw[4],raw[5]],[raw[6],raw[7],raw[8]]],
    t: [raw[9], raw[10], raw[11]],
    inlierMask: Array.from(raw.slice(12)),
  }
}

// Bundle adjustment: refine camera poses and 3D points.
// cameras: [{ R, t }], intrinsics: [{ fx,fy,cx,cy }], points3d: [{x,y,z}]
// observations: [{ camIdx, ptIdx, x, y }] (pixel coords)
// Returns { cameras: [{ R, t }], points3d: [{x,y,z}], costBefore, costAfter } or null.
// costBefore/costAfter are RMS reprojection error (px) from the WASM solver.
// `opts`:
//   maxIters          — outer LM iterations (default 30)
//   refineIntrinsics  — comma-separated self-calibration terms, any subset of
//                       'f','cxcy','k1','k2','k3' (e.g. 'f,k1' or 'f,cxcy,k1,k2,k3');
//                       'none'/'' disables. Parsed to the crate's refine BITMASK
//                       (1=f, 2=cxcy, 4=k1, 8=k2, 16=k3) by refineModeMask.
//   sensorOfCam       — per-camera integer sensor id (cameras sharing an id share
//                       one focal); required for refinement, ignored for 'none'.
//   gcpAnchors        — [{ ptIdx, target:[x,y,z], precision:3×3 }] — GCP-anchored 3D
//                       points (see core/sfm/sfm.js), pulled toward `target`
//                       (already in this same SfM frame) with independently
//                       covariance-weighted residuals on top of normal reprojection
//                       observations. Omit/empty for plain SfM-only BA.
//   cameraPriors      — [{ camIdx, target:[x,y,z], weights:[wx,wy,wz],
//                          targetR?:3×3, orientationPrecision?:3×3 }]
//                       camera-centre constraints in this same SfM frame. The
//                       position weights and orientation precision are inverse
//                       variances (orientation is expressed in radians).
// Returns { cameras, points3d, intrinsics, costBefore, costAfter, costTrace,
//   anchorRmsAfter, cameraPriorRmsAfter } — `intrinsics` is the refined effective K per camera
// `{ fx, fy, cx, cy, k1, k2, k3 }` (radial coeffs 0 for terms not refined); anchorRmsAfter
// is the RMS anchor residual in world units (0 when there are no anchors).
const REFINE_BIT = { f: 1, cxcy: 2, k1: 4, k2: 8, k3: 16 }
// Parse a refine-terms string into the crate's bitmask. Unknown / 'none' tokens
// contribute nothing (so 'none', '', undefined → 0).
export function refineModeMask(spec) {
  if (!spec || spec === 'none') return 0
  let mask = 0
  for (const tok of String(spec).split(',')) mask |= REFINE_BIT[tok.trim()] ?? 0
  return mask
}
export async function bundleAdjust(cameras, intrinsics, points3d, observations, opts = {}) {
  await ensureWasm()
  const {
    maxIters = 30, refineIntrinsics = 'none', sensorOfCam = null,
    gcpAnchors = [], cameraPriors = [],
  } = opts
  const refineMode = refineModeMask(refineIntrinsics)
  const nCam = cameras.length
  const nPts = points3d.length
  const nObs = observations.length
  if (nCam === 0 || nPts === 0 || nObs === 0) return null

  const camFlat = new Float32Array(nCam * 12)
  cameras.forEach(({ R, t }, c) => {
    const b = c * 12
    camFlat.set([R[0][0],R[0][1],R[0][2],R[1][0],R[1][1],R[1][2],R[2][0],R[2][1],R[2][2],t[0],t[1],t[2]], b)
  })

  const kFlat = new Float32Array(nCam * 4)
  intrinsics.forEach(({ fx, fy, cx, cy }, c) => {
    kFlat.set([fx, fy, cx, cy], c * 4)
  })

  const ptsFlat = new Float32Array(nPts * 3)
  points3d.forEach(({ x, y, z }, i) => { ptsFlat.set([x, y, z], i * 3) })

  const obsFlat = new Float32Array(nObs * 4)
  const obsWFlat = new Float32Array(nObs * 2)
  observations.forEach(({ camIdx, ptIdx, x, y, weightX = 1, weightY = 1 }, i) => {
    obsFlat.set([camIdx, ptIdx, x, y], i * 4)
    obsWFlat.set([weightX, weightY].map((v) => Number.isFinite(v) && v > 0 ? v : 1), i * 2)
  })

  const anchorFlat  = new Float32Array(gcpAnchors.length * 4)
  const anchorWFlat = new Float32Array(gcpAnchors.length * 9)
  gcpAnchors.forEach(({ ptIdx, target, precision, weights, weight }, i) => {
    anchorFlat.set([ptIdx, target[0], target[1], target[2]], i * 4)
    const axisWeights = weights ?? [weight, weight, weight]
    const matrix = precision ?? [[axisWeights[0],0,0],[0,axisWeights[1],0],[0,0,axisWeights[2]]]
    anchorWFlat.set(matrix.flat().map((value, j) => Number.isFinite(value)
      ? value : (j % 4 === 0 ? 1 : 0)), i * 9)
  })

  // Row layout is shared with bundle.rs. A zero orientation-precision matrix
  // means position-only (EXIF or an imported row without complete OPK angles).
  const cameraPriorFlat = new Float32Array(cameraPriors.length * 25)
  cameraPriors.forEach(({ camIdx, target, weights, targetR, orientationPrecision }, i) => {
    const R = targetR?.flat() ?? [1,0,0,0,1,0,0,0,1]
    const P = orientationPrecision?.flat() ?? Array(9).fill(0)
    cameraPriorFlat.set([
      camIdx, target[0], target[1], target[2], weights[0], weights[1], weights[2],
      ...R, ...P,
    ], i * 25)
  })

  // sensor_of_cam: aligned to `cameras`; -1 (own group) where unknown. Empty/all-−1
  // is fine — the solver only uses it when refineMode > 0.
  const sensorFlat = new Int32Array(nCam)
  for (let c = 0; c < nCam; c++) {
    const id = sensorOfCam ? sensorOfCam[c] : -1
    sensorFlat[c] = Number.isInteger(id) ? id : -1
  }

  const raw = bundle_adjust(
    camFlat, kFlat, ptsFlat, obsFlat, obsWFlat, anchorFlat, anchorWFlat, cameraPriorFlat,
    maxIters, sensorFlat, refineMode,
  )
  // Layout: cameras(nCam×12), points(nPts×3), intrinsics(nCam×7 = fx,fy,cx,cy,k1,k2,k3),
  // costBefore, costAfter, anchorRmsAfter, cameraPriorRmsAfter, then a variable-length per-iteration
  // RMS convergence trace.
  const intrBase = nCam * 12 + nPts * 3
  const base = intrBase + nCam * 7
  if (!raw || raw.length < base + 4) return null
  const costBefore = raw[base]
  const costAfter  = raw[base + 1]
  const anchorRmsAfter = raw[base + 2]
  const cameraPriorRmsAfter = raw[base + 3]
  const costTrace  = raw.length > base + 4 ? Array.from(raw.slice(base + 4)) : []

  const outCameras = cameras.map((_, c) => {
    const b = c * 12
    return {
      R: [[raw[b],raw[b+1],raw[b+2]],[raw[b+3],raw[b+4],raw[b+5]],[raw[b+6],raw[b+7],raw[b+8]]],
      t: [raw[b+9], raw[b+10], raw[b+11]],
    }
  })

  const ptsBase = nCam * 12
  const outPoints = points3d.map((_, i) => ({
    x: raw[ptsBase + i*3], y: raw[ptsBase + i*3+1], z: raw[ptsBase + i*3+2],
  }))

  const outIntrinsics = cameras.map((_, c) => {
    const b = intrBase + c * 7
    return { fx: raw[b], fy: raw[b+1], cx: raw[b+2], cy: raw[b+3], k1: raw[b+4], k2: raw[b+5], k3: raw[b+6] }
  })

  return {
    cameras: outCameras, points3d: outPoints, intrinsics: outIntrinsics,
    costBefore, costAfter, costTrace, anchorRmsAfter, cameraPriorRmsAfter,
  }
}

// PatchMatch multi-view-stereo depth map for one reference image (dense recon).
//   refGray:  Uint8Array grayscale, length refW*refH
//   refK:     { fx, fy, cx, cy } at the reference's WORKING resolution
//   sources:  [{ gray: Uint8Array, w, h, K:{fx,fy,cx,cy}, R:[[…]×3], t:[tx,ty,tz], mask? }]
//             R,t map the reference camera frame → that source's frame. `mask`, when
//             present, is a length-w*h 0/1 LUT (1 = excluded frame/fiducial) so the
//             ZNCC match skips a source's border instead of falsely correlating to it.
//   opts:     { depthMin, depthMax, seedDepth?: Float32Array(refW*refH),
//               window=3, iterations=3, bestK=3, seed=1 }  (the dense pipeline passes window 3)
// Returns { depth: Float32Array, cost: Float32Array, width, height } (cost: lower
// is more confident; depth in the reconstruction's up-to-scale world units).
export async function computeDepthMap(refGray, refW, refH, refK, sources, opts = {}) {
  await ensureWasm()
  const {
    depthMin, depthMax, seedDepth = new Float32Array(0),
    window = 3, iterations = 3, bestK = 3, seed = 1,
  } = opts
  const n = sources.length
  if (n === 0 || refW * refH === 0) return null

  // Concatenate source pixels; pack per-source dims, intrinsics, relative pose.
  let total = 0
  for (const s of sources) total += s.w * s.h
  const srcGray = new Uint8Array(total)
  const srcMask = new Uint8Array(total) // 0/1, parallel to srcGray (0 where no mask)
  const srcDims = new Uint32Array(n * 2)
  const srcK = new Float32Array(n * 4)
  const srcRel = new Float32Array(n * 12)
  let off = 0
  sources.forEach((s, i) => {
    srcGray.set(s.gray, off)
    if (s.mask) srcMask.set(s.mask.subarray(0, s.w * s.h), off)
    off += s.w * s.h
    srcDims[i*2] = s.w; srcDims[i*2+1] = s.h
    srcK.set([s.K.fx, s.K.fy, s.K.cx, s.K.cy], i * 4)
    const { R, t } = s
    srcRel.set([R[0][0],R[0][1],R[0][2],R[1][0],R[1][1],R[1][2],R[2][0],R[2][1],R[2][2],t[0],t[1],t[2]], i * 12)
  })

  const refKArr = new Float32Array([refK.fx, refK.fy, refK.cx, refK.cy])
  const raw = compute_depth_map(
    refGray, refW, refH, refKArr,
    srcGray, srcDims, srcK, srcRel, srcMask,
    seedDepth,
    depthMin, depthMax,
    window, iterations, bestK, seed >>> 0,
  )
  const npix = refW * refH
  if (!raw || raw.length < npix * 5) return null
  return {
    depth: raw.slice(0, npix),
    cost: raw.slice(npix, npix * 2),
    // Per-pixel converged plane normals (camera-frame, unit, nz<0), same shape as
    // the GPU backend returns — reused by fusion → Poisson meshing.
    normals: raw.slice(npix * 2, npix * 5),
    width: refW, height: refH,
  }
}

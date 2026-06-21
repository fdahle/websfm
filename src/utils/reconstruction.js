import init, { recover_pose, triangulate_dlt, solve_pnp, bundle_adjust }
  from '../wasm/reconstruction/reconstruction.js'

let initPromise = null
function ensureWasm() {
  if (!initPromise) initPromise = init()
  return initPromise
}

// Estimate K intrinsics from image metadata (pixels).
// Uses focalLength35 (35mm-equiv) if available; falls back to max(w,h).
export function estimateK(meta) {
  const w = meta?.width  || 1000
  const h = meta?.height || 1000
  const cx = w / 2
  const cy = h / 2
  if (meta?.focalLength35) {
    const fx = (meta.focalLength35 / 36) * w
    return { fx, fy: fx, cx, cy }
  }
  // Default: assume ~60° FOV
  const fx = Math.max(w, h)
  return { fx, fy: fx, cx, cy }
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
// Returns { cameras: [{ R, t }], points3d: [{x,y,z}] } or null.
export async function bundleAdjust(cameras, intrinsics, points3d, observations, opts = {}) {
  await ensureWasm()
  const { maxIters = 30 } = opts
  const nCam = cameras.length
  const nPts = points3d.length
  const nObs = observations.length
  if (nCam === 0 || nPts === 0 || nObs === 0) return null

  const camFlat = new Float32Array(nCam * 12)
  cameras.forEach(({ R, t }, c) => {
    const b = c * 12
    camFlat.set([R[0][0],R[0][1],R[0][2],t[0],R[1][0],R[1][1],R[1][2],t[1],R[2][0],R[2][1],R[2][2],t[2]], b)
  })

  const kFlat = new Float32Array(nCam * 4)
  intrinsics.forEach(({ fx, fy, cx, cy }, c) => {
    kFlat.set([fx, fy, cx, cy], c * 4)
  })

  const ptsFlat = new Float32Array(nPts * 3)
  points3d.forEach(({ x, y, z }, i) => { ptsFlat.set([x, y, z], i * 3) })

  const obsFlat = new Float32Array(nObs * 4)
  observations.forEach(({ camIdx, ptIdx, x, y }, i) => {
    obsFlat.set([camIdx, ptIdx, x, y], i * 4)
  })

  const raw = bundle_adjust(camFlat, kFlat, ptsFlat, obsFlat, maxIters)
  if (!raw || raw.length < nCam * 12 + nPts * 3) return null

  const outCameras = cameras.map((_, c) => {
    const b = c * 12
    return {
      R: [[raw[b],raw[b+1],raw[b+2]],[raw[b+3],raw[b+4],raw[b+5]],[raw[b+6],raw[b+7],raw[b+8]]],
      t: [raw[b+9], raw[b+10], raw[b+11]],
    }
  })

  const base = nCam * 12
  const outPoints = points3d.map((_, i) => ({
    x: raw[base + i*3], y: raw[base + i*3+1], z: raw[base + i*3+2],
  }))

  return { cameras: outCameras, points3d: outPoints }
}

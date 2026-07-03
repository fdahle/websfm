import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../wasm/reconstruction/reconstruction.js'
import {
  makeP34flat,
  triangulateDlt,
  recoverPose,
  fundamentalToEssential,
  solvePnp,
  bundleAdjust,
  resolveK,
} from './reconstruction.js'

// The wasm glue defaults to fetch()ing its .wasm via a URL, which Node can't do.
// Load the bytes ourselves and hand them to init(); the module-level `wasm` is a
// singleton, so the core module's own init() call then resolves immediately.
beforeAll(async () => {
  const wasmUrl = new URL('../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  const bytes = await readFile(fileURLToPath(wasmUrl))
  await initRecon({ module_or_path: bytes })
})

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

// Project a world point into a camera given pose [R|t], to NORMALISED coords
// (no K). x_cam = R·X + t, then divide by depth.
function projectNorm(R, t, X) {
  const xc = R[0][0] * X.x + R[0][1] * X.y + R[0][2] * X.z + t[0]
  const yc = R[1][0] * X.x + R[1][1] * X.y + R[1][2] * X.z + t[1]
  const zc = R[2][0] * X.x + R[2][1] * X.y + R[2][2] * X.z + t[2]
  return { x: xc / zc, y: yc / zc }
}

function matMul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j]
  return C
}

// Skew-symmetric [t]_x such that [t]_x · v = t × v.
function crossMat(t) {
  return [
    [0, -t[2], t[1]],
    [t[2], 0, -t[0]],
    [-t[1], t[0], 0],
  ]
}

describe('resolveK (intrinsics resolution)', () => {
  const meta = { width: 10137, height: 9600 }

  it('uses a focal in px directly', () => {
    const K = resolveK(meta, { width: 10137, height: 9600, focal: 6758, focalUnit: 'px' })
    expect(K.fx).toBeCloseTo(6758, 6)
    expect(K.fy).toBeCloseTo(6758, 6)
    expect(K.cx).toBeCloseTo(10137 / 2, 6)
  })

  it('converts an mm focal via pixel size', () => {
    const K = resolveK(meta, { width: 10137, focal: 152, focalUnit: 'mm', pixelSize: 152 / 6758 })
    expect(K.fx).toBeCloseTo(6758, 3)
  })

  it('reports the implied film width and flags off-standard pitch (Q4)', () => {
    // 0.025mm/px × 10137px = 253mm — wider than standard 230/240mm film.
    const bad = resolveK(meta, { width: 10137, focal: 154, focalUnit: 'mm', pixelSize: 0.025 })
    expect(bad.impliedFilmWidthMm).toBeCloseTo(253.4, 1)
    expect(bad.filmWidthOk).toBe(false)
    // A pitch giving a ~230mm frame is accepted.
    const good = resolveK(meta, { width: 10137, focal: 152, focalUnit: 'mm', pixelSize: 230 / 10137 })
    expect(good.impliedFilmWidthMm).toBeCloseTo(230, 3)
    expect(good.filmWidthOk).toBe(true)
  })

  it('converts an mm focal via film/sensor format width (film camera)', () => {
    // 152mm focal on a 228mm (9") format, scanned to 10137px wide.
    const K = resolveK(meta, { width: 10137, focal: 152, focalUnit: 'mm', sensorWidthMm: 228 })
    expect(K.fx).toBeCloseTo((152 / 228) * 10137, 3)
    expect(K.source).toMatch(/format/)
  })

  it('falls back to a default FOV with no calibration', () => {
    const K = resolveK(meta, null)
    expect(K.fx).toBe(10137) // max(w, h)
    expect(K.source).toMatch(/default FOV/)
  })
})

describe('triangulateDlt', () => {
  it('recovers known 3D points from two views (no rotation, lateral baseline)', async () => {
    // Camera A at the origin, camera B shifted +1 along world-X (t = -baseline).
    const PA = makeP34flat(I3, [0, 0, 0])
    const PB = makeP34flat(I3, [-1, 0, 0])

    const worldPts = [
      { x: 0.1, y: 0.2, z: 5 },
      { x: -0.3, y: 0.15, z: 6 },
      { x: 0.4, y: -0.2, z: 4 },
      { x: -0.05, y: -0.35, z: 7 },
    ]
    const ptsA = worldPts.map((X) => projectNorm(I3, [0, 0, 0], X))
    const ptsB = worldPts.map((X) => projectNorm(I3, [-1, 0, 0], X))

    const out = await triangulateDlt(ptsA, ptsB, PA, PB)
    expect(out).toHaveLength(worldPts.length)

    out.forEach((p, i) => {
      expect(p.x).toBeCloseTo(worldPts[i].x, 3)
      expect(p.y).toBeCloseTo(worldPts[i].y, 3)
      expect(p.z).toBeCloseTo(worldPts[i].z, 3)
      expect(p.srcIdx).toBe(i)
    })
  })

  it('returns an empty array when given no points', async () => {
    const P = makeP34flat(I3, [0, 0, 0])
    expect(await triangulateDlt([], [], P, P)).toEqual([])
  })
})

// Rotation about the Y axis by `a` radians.
function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
}

// A synthetic two-view setup with a known essential matrix. Camera A = [I|0],
// camera B = [Rtrue | ttrue]; a generic rotation + off-axis baseline keeps it
// well away from the degenerate (axis-aligned, no-rotation) case. With identity
// intrinsics, pixel coords equal normalised coords. The data is verified valid:
// epipolar residuals bᵀEa ≈ 1e-16 and trace(EᵀE) = 2|t|² (essential-matrix form).
function syntheticTwoView() {
  const Rtrue = rotY(0.2)
  const ttrue = [1, 0.3, 0.2]
  const E = matMul3(crossMat(ttrue), Rtrue) // E = [t]_x · R
  const Eflat = new Float32Array([
    E[0][0], E[0][1], E[0][2],
    E[1][0], E[1][1], E[1][2],
    E[2][0], E[2][1], E[2][2],
  ])
  const Ka = { fx: 1, fy: 1, cx: 0, cy: 0 }
  const worldPts = [
    { x: 0.2, y: 0.1, z: 5 }, { x: -0.3, y: 0.2, z: 6 },
    { x: 0.4, y: -0.1, z: 4 }, { x: -0.2, y: -0.3, z: 7 },
    { x: 0.1, y: 0.35, z: 5.5 }, { x: -0.4, y: 0.05, z: 4.5 },
    { x: 0.25, y: -0.25, z: 6.5 }, { x: 0.05, y: 0.15, z: 5 },
  ]
  const ptsA = worldPts.map((X) => projectNorm(I3, [0, 0, 0], X))
  const ptsB = worldPts.map((X) => projectNorm(Rtrue, ttrue, X))
  return { Rtrue, ttrue, Eflat, Ka, ptsA, ptsB }
}

describe('recoverPose', () => {
  it('recovers the ground-truth rotation and translation direction', async () => {
    const { Rtrue, ttrue, Eflat, Ka, ptsA, ptsB } = syntheticTwoView()
    const pose = await recoverPose(ptsA, ptsB, Eflat, Ka)
    expect(pose).not.toBeNull()
    const { R, t } = pose

    // Rotation matches ground truth (cheirality selects the correct candidate).
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(R[i][j]).toBeCloseTo(Rtrue[i][j], 3)

    // R is a proper rotation: orthonormal (R·Rᵀ = I) with det ≈ +1.
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d = R[i][0] * R[j][0] + R[i][1] * R[j][1] + R[i][2] * R[j][2]
        expect(d).toBeCloseTo(i === j ? 1 : 0, 4)
      }
    const det =
      R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
      R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
      R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0])
    expect(det).toBeCloseTo(1, 4)

    // Translation is recovered only up to scale: a unit vector parallel to ttrue.
    const tn = Math.hypot(...t)
    expect(tn).toBeCloseTo(1, 4)
    const gn = Math.hypot(...ttrue)
    const dot = (t[0] * ttrue[0] + t[1] * ttrue[1] + t[2] * ttrue[2]) / (tn * gn)
    expect(Math.abs(dot)).toBeCloseTo(1, 3)
  })

  it('returns null with fewer than 5 correspondences', async () => {
    const Ka = { fx: 1, fy: 1, cx: 0, cy: 0 }
    const E = new Float32Array(9)
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 0, y: 2 }]
    expect(await recoverPose(pts, pts, E, Ka)).toBeNull()
  })
})

describe('fundamentalToEssential', () => {
  it('reduces to F when both intrinsics are identity', () => {
    // With Ka = Kb = I, E = Kb^T F Ka = F.
    const F = [
      [0, -0.2, 0.1],
      [0.2, 0, -0.3],
      [-0.1, 0.3, 0],
    ]
    const Kid = { fx: 1, fy: 1, cx: 0, cy: 0 }
    const E = fundamentalToEssential(F, Kid, Kid)
    const expected = [0, -0.2, 0.1, 0.2, 0, -0.3, -0.1, 0.3, 0]
    expected.forEach((v, i) => expect(E[i]).toBeCloseTo(v, 5))
  })

  it('applies E = Kb^T · F · Ka', () => {
    const F = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const Ka = { fx: 2, fy: 3, cx: 5, cy: 7 }
    const Kb = { fx: 11, fy: 13, cx: 17, cy: 19 }
    // Reference multiply in plain JS.
    const Kmat = (K) => [[K.fx, 0, K.cx], [0, K.fy, K.cy], [0, 0, 1]]
    const mul = (A, B) => {
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
          for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j]
      return C
    }
    const kb = Kmat(Kb)
    const kbT = [[kb[0][0], kb[1][0], kb[2][0]], [kb[0][1], kb[1][1], kb[2][1]], [kb[0][2], kb[1][2], kb[2][2]]]
    const ref = mul(kbT, mul(F, Kmat(Ka)))
    const E = fundamentalToEssential(F, Ka, Kb)
    const flat = [ref[0][0], ref[0][1], ref[0][2], ref[1][0], ref[1][1], ref[1][2], ref[2][0], ref[2][1], ref[2][2]]
    flat.forEach((v, i) => expect(E[i]).toBeCloseTo(v, 3))
  })
})

// Deterministic PRNG so the synthetic scenes below are fixed across runs.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Realistic-ish intrinsics (≈ a 6000×4000 frame) so coordinate-layout bugs that
// only bite with a non-trivial principal point and focal length get exercised.
const KPIX = { fx: 5833.3, fy: 5833.3, cx: 3000, cy: 2000 }

// Project a world point through pose [R|t] to PIXEL coords (K applied).
function projectPix(R, t, X) {
  const xc = R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2] + t[0]
  const yc = R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2] + t[1]
  const zc = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2]
  return { x: KPIX.fx * (xc / zc) + KPIX.cx, y: KPIX.fy * (yc / zc) + KPIX.cy, z: zc }
}

// Camera centre C → translation t = -R·C, the convention used throughout SfM.
function poseFromCenter(R, C) {
  return [
    -(R[0][0] * C[0] + R[0][1] * C[1] + R[0][2] * C[2]),
    -(R[1][0] * C[0] + R[1][1] * C[1] + R[1][2] * C[2]),
    -(R[2][0] * C[0] + R[2][1] * C[1] + R[2][2] * C[2]),
  ]
}

describe('solvePnp', () => {
  it('recovers a known pose from 3D-2D pixel correspondences', async () => {
    const rng = mulberry32(7)
    const world = Array.from({ length: 40 }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const Rtrue = rotY(0.2)
    const ttrue = poseFromCenter(Rtrue, [1.5, 0.3, 0])
    const pts3 = world.map(([x, y, z]) => ({ x, y, z }))
    const pts2 = world.map((X) => projectPix(Rtrue, ttrue, X))

    const pnp = await solvePnp(pts3, pts2, KPIX, { ransacThreshPx: 4.0, maxIters: 200 })
    expect(pnp).not.toBeNull()

    // Rotation and translation recovered (absolute scale, unlike two-view pose).
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(pnp.R[i][j]).toBeCloseTo(Rtrue[i][j], 2)
    pnp.t.forEach((v, i) => expect(v).toBeCloseTo(ttrue[i], 1))

    // Nearly all points are inliers and reproject tightly.
    const inliers = pnp.inlierMask.filter((v) => v > 0.5).length
    expect(inliers).toBeGreaterThanOrEqual(world.length - 2)
    const resid = pts3.map((P, i) => {
      const p = projectPix(pnp.R, pnp.t, [P.x, P.y, P.z])
      return Math.hypot(p.x - pts2[i].x, p.y - pts2[i].y)
    }).sort((a, b) => a - b)
    expect(resid[resid.length >> 1]).toBeLessThan(2.0)
  })

  it('returns null with fewer than 6 correspondences', async () => {
    const pts3 = Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0, z: 5 }))
    const pts2 = pts3.map(() => ({ x: 0, y: 0 }))
    expect(await solvePnp(pts3, pts2, KPIX)).toBeNull()
  })
})

describe('bundleAdjust', () => {
  // Two cameras with a real rotation + off-origin baseline and a cloud of points,
  // all consistent to machine precision. This is the case that exposed the
  // camera-packing layout bug: the wrapper must write [R(9)|t(3)] blocks, not the
  // interleaved P34 layout — otherwise any non-identity camera is read as garbage.
  function exactScene(seed = 11, n = 50) {
    const rng = mulberry32(seed)
    const world = Array.from({ length: n }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const poses = [
      { R: I3, t: [0, 0, 0] },
      { R: rotY(0.15), t: poseFromCenter(rotY(0.15), [2, 0, 0]) },
    ]
    const cameras = poses.map(({ R, t }) => ({ R, t }))
    const intrinsics = poses.map(() => KPIX)
    const points3d = world.map(([x, y, z]) => ({ x, y, z }))
    const observations = []
    points3d.forEach((P, ptIdx) => poses.forEach((p, camIdx) => {
      const o = projectPix(p.R, p.t, [P.x, P.y, P.z])
      observations.push({ camIdx, ptIdx, x: o.x, y: o.y })
    }))
    return { poses, cameras, intrinsics, points3d, observations }
  }

  it('reports ~zero cost on an already-optimal reconstruction', async () => {
    const { cameras, intrinsics, points3d, observations } = exactScene()
    const res = await bundleAdjust(cameras, intrinsics, points3d, observations, { maxIters: 30 })
    expect(res).not.toBeNull()
    // The input IS the optimum; a correct cost evaluation must be sub-pixel and
    // BA must not move away from it. (Pre-fix this read ~53900px.)
    expect(res.costBefore).toBeLessThan(1.0)
    expect(res.costAfter).toBeLessThan(1.0)
  })

  it('drives a perturbed camera back down toward zero reprojection error', async () => {
    const { cameras, intrinsics, points3d, observations } = exactScene(23, 60)
    // Nudge camera B's translation off the truth; BA should recover.
    const perturbed = cameras.map((c, i) => i === 1
      ? { R: c.R, t: [c.t[0] + 0.3, c.t[1] - 0.2, c.t[2] + 0.15] }
      : c)
    const res = await bundleAdjust(perturbed, intrinsics, points3d, observations, { maxIters: 50 })
    expect(res).not.toBeNull()
    expect(res.costBefore).toBeGreaterThan(10) // the perturbation really hurt
    expect(res.costAfter).toBeLessThan(res.costBefore) // and BA improved it
  })

  it('returns null when there are no observations', async () => {
    const { cameras, intrinsics, points3d } = exactScene()
    expect(await bundleAdjust(cameras, intrinsics, points3d, [])).toBeNull()
  })
})

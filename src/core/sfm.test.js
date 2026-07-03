import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../wasm/reconstruction/reconstruction.js'
import { reconstruct } from './sfm.js'

beforeAll(async () => {
  const wasmUrl = new URL('../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

// ── tiny linear algebra ───────────────────────────────────────────────────────
const mul = (A, B) => {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j]
  return C
}
const T = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]]
const mv = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
]
const skew = (t) => [[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]]
const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]] }

// Deterministic PRNG so the synthetic scene is fixed across runs.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One sensor for all images → one known K (matches core estimateK from this meta).
const META = { width: 1000, height: 800, focalLength35: 35 }
const FX = (META.focalLength35 / 36) * META.width // estimateK: fx = (f35/36)·w
const K = [[FX, 0, META.width / 2], [0, FX, META.height / 2], [0, 0, 1]]
const KINV = [[1 / FX, 0, -(META.width / 2) / FX], [0, 1 / FX, -(META.height / 2) / FX], [0, 0, 1]]
const Kobj = { fx: FX, fy: FX, cx: META.width / 2, cy: META.height / 2 }

// Project a world point through pose [R|t] to pixel coords (or null if behind).
function project(R, t, X) {
  const c = mv(R, X).map((v, i) => v + t[i])
  if (c[2] <= 0) return null
  return { x: K[0][0] * (c[0] / c[2]) + K[0][2], y: K[1][1] * (c[1] / c[2]) + K[1][2] }
}

// Fundamental matrix for the pair (A,B): F = K_B^{-T} · [t_rel]_x R_rel · K_A^{-1}
// with x_B = R_rel·x_A + t_rel. Same K for both cameras here.
function fundamental(Ri, ti, Rj, tj) {
  const Rrel = mul(Rj, T(Ri))
  const trel = tj.map((v, k) => v - mv(Rrel, ti)[k])
  const E = mul(skew(trel), Rrel)
  return mul(mul(T(KINV), E), KINV) // K_B^{-T} E K_A^{-1}
}

describe('reconstruct (incremental SfM, synthetic 3-view scene)', () => {
  it('registers all three cameras with near-zero reprojection error', async () => {
    const rng = mulberry32(42)

    // 60 non-planar world points well in front of the rig.
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4,        // x ∈ [-2, 2]
      (rng() - 0.5) * 3,        // y ∈ [-1.5, 1.5]
      8 + rng() * 4,            // z ∈ [8, 12]
    ])

    // True camera poses (x_cam = R·X + t, t = -R·C for centre C). A reference rig
    // with lateral baselines + small yaw → comfortable parallax.
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']

    // Per-image keypoints: every point projects into every camera (verified > 0).
    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META,
      keypoints: world.map((X) => project(Rs[ci], ts[ci], X)),
    }))
    for (const img of images) expect(img.keypoints.every(Boolean)).toBe(true)

    // All three pairs; matches are identity (point i ↔ point i), all inliers.
    const matches = world.map((_, i) => [i, i])
    const pairs = []
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      pairs.push({
        idA: uuids[a], idB: uuids[b],
        F: fundamental(Rs[a], ts[a], Rs[b], ts[b]),
        matches, inlierCount: N, status: 'done',
      })
    }

    const logs = []
    const progress = []
    // baIterations: 0 isolates init + incremental registration + triangulation +
    // track merging deterministically. The LM bundle-adjustment path is exercised
    // by the noisy end-to-end test below and by the Rust crate's BA unit tests.
    const out = await reconstruct(
      { images, pairs, settings: { baIterations: 0 } },
      {
        onLog: (m, level, cat) => logs.push([level, cat, m]),
        onProgress: (d, total, label) => progress.push([d, total, label]),
      },
    )

    expect(out.status).toBe('done')
    expect(out.cameras).toHaveLength(3)
    expect(new Set(out.cameras.map((c) => c.uuid))).toEqual(new Set(uuids))
    expect(out.points.length).toBeGreaterThan(30)
    expect(progress.at(-1)).toEqual([3, 3, 'Done'])

    // Reprojection check: project each reconstructed point into every camera that
    // sees it and compare to the stored keypoint. Noise-free input + a faithful
    // pipeline ⇒ sub-pixel residuals.
    const camByUuid = new Map(out.cameras.map((c) => [c.uuid, c]))
    const residuals = []
    for (const pt of out.points) {
      for (const [uuid, kpIdx] of pt.views) {
        const cam = camByUuid.get(uuid)
        const c = mv(cam.R, [pt.x, pt.y, pt.z]).map((v, i) => v + cam.t[i])
        const u = Kobj.fx * (c[0] / c[2]) + Kobj.cx
        const v = Kobj.fy * (c[1] / c[2]) + Kobj.cy
        const kp = images.find((im) => im.uuid === uuid).keypoints[kpIdx]
        residuals.push(Math.hypot(u - kp.x, v - kp.y))
      }
    }
    residuals.sort((a, b) => a - b)
    const median = residuals[residuals.length >> 1]
    expect(median).toBeLessThan(1.0)

    // Track merging: all 60 points are visible in all 3 cameras with identity
    // matches, so observations must collapse into 3-view tracks — not a pile of
    // 2-view duplicates (which is what the pre-merge pipeline produced, ~2× the
    // point count). Guards both the extension step and the no-duplicate invariant.
    expect(out.points.length).toBeLessThanOrEqual(N)
    const threePlus = out.points.filter((pt) => pt.views.length >= 3).length
    expect(threePlus).toBeGreaterThan(30)
    for (const pt of out.points) {
      const seen = pt.views.map(([u]) => u)
      expect(new Set(seen).size).toBe(seen.length)   // no camera twice in a track
      expect(seen.length).toBeLessThanOrEqual(3)      // never more views than cameras
    }
  })

  it('runs LM bundle adjustment end-to-end on a noisy scene', async () => {
    const rng = mulberry32(7)
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']

    // ±~0.4px keypoint noise (sum of two uniforms) so BA + filtering has real work.
    const noise = () => (rng() - 0.5 + rng() - 0.5)
    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META,
      keypoints: world.map((X) => {
        const p = project(Rs[ci], ts[ci], X)
        return { x: p.x + noise(), y: p.y + noise() }
      }),
    }))
    const matches = world.map((_, i) => [i, i])
    const pairs = []
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      pairs.push({
        idA: uuids[a], idB: uuids[b],
        F: fundamental(Rs[a], ts[a], Rs[b], ts[b]),
        matches, inlierCount: N, status: 'done',
      })
    }

    const out = await reconstruct(
      { images, pairs, settings: { baIterations: 25 } },
      { onLog: () => {} },
    )
    expect(out.status).toBe('done')
    expect(out.cameras).toHaveLength(3)

    // The Q3 run summary is populated and internally consistent: BA drove the
    // post-BA median below the (looser) pre-BA p95, and the model is well-formed.
    expect(out.summary).toBeTruthy()
    expect(out.summary.nCameras).toBe(3)
    expect(out.summary.postBaMedianPx).toBeLessThan(1.5)
    expect(out.summary.preBaP95px).toBeGreaterThanOrEqual(out.summary.postBaMedianPx)
    expect(out.summary.perPairInitReproj.length).toBeGreaterThan(0)
  })

  it('returns status "idle" when fewer than two images have keypoints', async () => {
    const out = await reconstruct(
      { images: [{ uuid: 'c0', name: 'c0', kpStatus: 'done', meta: META, keypoints: [{ x: 1, y: 2 }] }], pairs: [], settings: {} },
      {},
    )
    expect(out.status).toBe('idle')
    expect(out.cameras).toHaveLength(0)
    expect(out.points).toHaveLength(0)
  })
})

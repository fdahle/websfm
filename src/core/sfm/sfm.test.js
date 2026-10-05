import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { RUN_BUDGET } from './progressPlan.js'
import {
  reconstruct, retriangulatePairs, mergeSplitTracks, rotationCycleFilter,
  pruneFinalTwoViewTracks, completeTracks,
} from './sfm.js'
import { resolveK } from './reconstruction.js'
import { distortPixel } from './distortion.js'
import { canonicalFrame } from './fiducials.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
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

// One sensor for all images → one known K (matches core resolveK from this meta).
const META = { width: 1000, height: 800, focalLength35: 35 }
const FX = resolveK(META).fx
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
        onProgress: (d, total, label, fraction) => progress.push([d, total, label, fraction]),
      },
    )

    expect(out.status).toBe('done')
    expect(out.cameras).toHaveLength(3)
    expect(new Set(out.cameras.map((c) => c.uuid))).toEqual(new Set(uuids))
    expect(out.points.length).toBeGreaterThan(30)
    // Progress is phase-weighted, not a camera count (core/sfm/progressPlan.js): the
    // run ends on the finalize phase with every camera counted. The bar value must be
    // monotonic and must NOT be full at the end of registration — that premature 100%
    // is exactly what the phase plan replaced.
    expect(progress.at(-1).slice(0, 2)).toEqual([3, 3])
    const fractions = progress.map((p) => p[3]).filter((f) => f != null)
    expect(fractions.length).toBeGreaterThan(0)
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1])
    }
    expect(fractions.at(-1)).toBeCloseTo(RUN_BUDGET.primary[1], 10)
    const lastRegister = progress.filter((p) => /Registering /.test(p[2] ?? '')).at(-1)
    if (lastRegister) expect(lastRegister[3]).toBeLessThan(0.5)

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

  // WS1 — weak-pair registration bridge. A third camera whose only links to the model
  // are WEAK pairs (valid F below the accept gate) must still register via PnP, but weak
  // pairs must never seed initialization or triangulate fresh structure.
  it('registers a camera linked to the model only through weak PnP bridges', async () => {
    const rng = mulberry32(123)
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']
    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META,
      keypoints: world.map((X) => project(Rs[ci], ts[ci], X)),
    }))
    const matches = world.map((_, i) => [i, i])
    // Only c0↔c1 is strong (seeds init + triangulates all structure). Both links to c2
    // are marked weak, so c2 can register only by PnP against points triangulated from
    // the strong pair.
    const mk = (a, b, weak) => ({
      idA: uuids[a], idB: uuids[b],
      F: fundamental(Rs[a], ts[a], Rs[b], ts[b]),
      matches, inlierCount: N, status: 'done', weak,
    })
    const pairs = [mk(0, 1, false), mk(0, 2, true), mk(1, 2, true)]

    const out = await reconstruct(
      { images, pairs, settings: { baIterations: 0 } },
      { onLog: () => {} },
    )
    expect(out.status).toBe('done')
    // All three register: c0/c1 from the strong seed, c2 via the weak PnP bridges.
    expect(new Set(out.cameras.map((c) => c.uuid))).toEqual(new Set(uuids))
  })

  it('cannot seed initialization from weak pairs alone', async () => {
    const rng = mulberry32(321)
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']
    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META,
      keypoints: world.map((X) => project(Rs[ci], ts[ci], X)),
    }))
    const matches = world.map((_, i) => [i, i])
    // Every pair weak → no strong pair to seed init. The reconstruction can't bootstrap.
    const pairs = []
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      pairs.push({
        idA: uuids[a], idB: uuids[b],
        F: fundamental(Rs[a], ts[a], Rs[b], ts[b]),
        matches, inlierCount: N, status: 'done', weak: true,
      })
    }
    const out = await reconstruct({ images, pairs, settings: { baIterations: 0 } }, { onLog: () => {} })
    // No strong pair ⇒ init returns 'idle', no cameras committed.
    expect(out.status).toBe('idle')
    expect(out.cameras).toHaveLength(0)
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

  it('undistorts keypoints from a sensor with known radial distortion', async () => {
    const rng = mulberry32(99)
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']
    const dist = { k1: -0.08, k2: 0.01, k3: 0, p1: 0, p2: 0 }
    const sensor = { focal: FX, focalUnit: 'px', cx: META.width / 2, cy: META.height / 2, ...dist }

    // Observed keypoints = ideal pinhole projection pushed through the lens.
    const distorted = uuids.map((uuid, ci) =>
      world.map((X) => distortPixel(project(Rs[ci], ts[ci], X).x, project(Rs[ci], ts[ci], X).y, Kobj, dist)))
    const matches = world.map((_, i) => [i, i])
    const pairs = []
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      pairs.push({
        idA: uuids[a], idB: uuids[b],
        F: fundamental(Rs[a], ts[a], Rs[b], ts[b]),  // the ideal (pinhole) epipolar geometry
        matches, inlierCount: N, status: 'done',
      })
    }
    const build = (withSensor) => uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META,
      sensor: withSensor ? sensor : null,
      keypoints: distorted[ci].map((p) => ({ x: p.x, y: p.y })),
    }))

    // With the sensor's k1/k2, keypoints are undistorted at ingest → clean pinhole
    // model. Without it, the lens error leaks straight into the reconstruction.
    const corrected = await reconstruct({ images: build(true), pairs, settings: { baIterations: 20 } }, { onLog: () => {} })
    const uncorrected = await reconstruct({ images: build(false), pairs, settings: { baIterations: 20 } }, { onLog: () => {} })

    expect(corrected.status).toBe('done')
    expect(corrected.cameras).toHaveLength(3)
    expect(corrected.summary.postBaMedianPx).toBeLessThan(1.0)
    // The correction demonstrably helps: uncorrected residual is much worse.
    expect(uncorrected.summary.postBaMedianPx).toBeGreaterThan(2 * corrected.summary.postBaMedianPx)
  })

  it('folds self-calibrated k1 back into the keypoints, keeping the model pinhole (D1)', async () => {
    const rng = mulberry32(7)
    const N = 80
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']
    // Pure radial k1 (Brown r²) = exactly BA's shared-k1 model, so self-cal can
    // capture it fully. No sensor → ingest does NOT undistort; BA must self-calibrate.
    const dist = { k1: -0.05, k2: 0, k3: 0, p1: 0, p2: 0 }
    const distorted = uuids.map((uuid, ci) =>
      world.map((X) => {
        const p = project(Rs[ci], ts[ci], X)
        return distortPixel(p.x, p.y, Kobj, dist)
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
    // Shared sensor id on every image so the run reports one self-cal group (D2).
    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META, sensor: null, sensorId: 'sensorA',
      keypoints: distorted[ci].map((p) => ({ x: p.x, y: p.y })),
    }))

    const logs = []
    // Wide filter gate so the (still-distorted) pre-self-cal residuals survive the
    // filter passes and self-cal actually runs on the full set.
    const out = await reconstruct(
      { images, pairs, settings: { baIterations: 40, refineIntrinsics: 'f,k1', filterMaxReprojPx: 30 } },
      { onLog: (m, level, cat) => logs.push([level, cat, m]) },
    )

    expect(out.status).toBe('done')
    expect(out.cameras).toHaveLength(3)
    // The distortion was folded into the keypoints, not left stranded on the model:
    // every camera K is pinhole (k1 = 0) at the end.
    for (const c of out.cameras) expect(c.K.k1 || 0).toBe(0)
    // Pinhole reprojection stats are now consistent with BA's own RMS — the point of
    // D1. With a stranded k1 this would stay large and the filter would gut the model.
    expect(out.summary.postBaMedianPx).toBeLessThan(1.0)
    expect(out.points.length).toBeGreaterThan(30)
    expect(logs.some(([, , m]) => /folded self-calibrated distortion/.test(m))).toBe(true)

    // D2: the run exports the composed self-calibrated distortion so dense can reproduce
    // the fold. One sensor group, a k1 near the true −0.05 that BA recovered; k2/k3 = 0
    // (not refined) and a tiny composed-fit residual.
    expect(out.summary.selfCalDistortion).toHaveLength(1)
    const [scd] = out.summary.selfCalDistortion
    expect(scd.sensorId).toBe('sensorA')
    expect(scd.k1).toBeLessThan(0)          // barrel, matching the injected sign
    expect(Math.abs(scd.k1 - (-0.05))).toBeLessThan(0.02)
    expect(scd.k2).toBe(0)
    expect(scd.k3).toBe(0)
    expect(scd.fitRmsPx).toBeLessThan(0.5)
  })

  it('self-calibrates and folds a 2-coefficient radial bag (k1,k2) (WS2)', async () => {
    const rng = mulberry32(11)
    const N = 90
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0.2, 0], [-2, -0.2, 0], [0.5, 1.5, 0.3]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15), rotY(0.08)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2', 'c3']
    const dist = { k1: -0.12, k2: 0.04, k3: 0, p1: 0, p2: 0 }
    const distorted = uuids.map((uuid, ci) =>
      world.map((X) => {
        const p = project(Rs[ci], ts[ci], X)
        return distortPixel(p.x, p.y, Kobj, dist)
      }))
    const matches = world.map((_, i) => [i, i])
    const pairs = []
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
      pairs.push({
        idA: uuids[a], idB: uuids[b],
        F: fundamental(Rs[a], ts[a], Rs[b], ts[b]),
        matches, inlierCount: N, status: 'done',
      })
    }
    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META, sensor: null, sensorId: 'sensorA',
      keypoints: distorted[ci].map((p) => ({ x: p.x, y: p.y })),
    }))

    const out = await reconstruct(
      { images, pairs, settings: { baIterations: 50, refineIntrinsics: 'f,k1,k2', filterMaxReprojPx: 30 } },
      { onLog: () => {} },
    )
    expect(out.status).toBe('done')
    // Model stays pinhole (all radial folded into keypoints).
    for (const c of out.cameras) { expect(c.K.k1 || 0).toBe(0); expect(c.K.k2 || 0).toBe(0) }
    expect(out.summary.postBaMedianPx).toBeLessThan(1.0)
    // Composed bag recovers both injected coefficients.
    expect(out.summary.selfCalDistortion).toHaveLength(1)
    const [scd] = out.summary.selfCalDistortion
    expect(Math.abs(scd.k1 - (-0.12))).toBeLessThan(0.03)
    expect(Math.abs(scd.k2 - 0.04)).toBeLessThan(0.03)
    expect(scd.fitRmsPx).toBeLessThan(0.5)
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

describe('reconstruct — GCP-anchored bundle adjustment (F2)', () => {
  // Same noise-free 3-camera rig as the first describe block, plus 3 "GCPs" (world
  // points 0/1/2, observed in cameras 0+1) whose surveyed position is their exact
  // true world position — this synthetic rig's SfM frame coincides with the true
  // world frame, so the anchor should hold with near-zero residual and not break
  // the reconstruction.
  it('runs the GCP-anchored BA pass end-to-end without regressing the model', async () => {
    const rng = mulberry32(42)
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']

    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META,
      keypoints: world.map((X) => project(Rs[ci], ts[ci], X)),
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

    const gcps = [0, 1, 2].map((i) => ({
      x: world[i][0], y: world[i][1], z: world[i][2],
      accuracyX: 0.1, accuracyY: 0.1, accuracyZ: 0.1,
      observations: [
        { uuid: 'c0', px: images[0].keypoints[i].x, py: images[0].keypoints[i].y },
        { uuid: 'c1', px: images[1].keypoints[i].x, py: images[1].keypoints[i].y },
      ],
    }))

    const logs = []
    const out = await reconstruct(
      { images, pairs, gcps, settings: { baIterations: 25 } },
      { onLog: (m, level, cat) => logs.push([level, cat, m]) },
    )

    expect(out.status).toBe('done')
    expect(out.cameras).toHaveLength(3)
    expect(logs.some(([, , m]) => m.includes('GCP-anchored bundle adjustment RMS'))).toBe(true)
    expect(logs.some(([level, , m]) => level === 'warn' && m.includes('GCP anchoring'))).toBe(false)

    // Reconstruction quality is unaffected (still sub-pixel median reprojection).
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
    expect(residuals[residuals.length >> 1]).toBeLessThan(1.0)
  })

  it('skips anchoring quietly with fewer than 3 qualifying GCPs', async () => {
    const rng = mulberry32(42)
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['c0', 'c1', 'c2']
    const images = uuids.map((uuid, ci) => ({
      uuid, name: uuid, kpStatus: 'done', meta: META,
      keypoints: world.map((X) => project(Rs[ci], ts[ci], X)),
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
    // Only 2 GCPs — below the ≥3 threshold to attempt a similarity fit.
    const gcps = [0, 1].map((i) => ({
      x: world[i][0], y: world[i][1], z: world[i][2],
      observations: [{ uuid: 'c0', px: images[0].keypoints[i].x, py: images[0].keypoints[i].y },
        { uuid: 'c1', px: images[1].keypoints[i].x, py: images[1].keypoints[i].y }],
    }))
    const logs = []
    const out = await reconstruct(
      { images, pairs, gcps, settings: { baIterations: 25 } },
      { onLog: (m, level, cat) => logs.push([level, cat, m]) },
    )
    expect(out.status).toBe('done')
    expect(logs.some(([, , m]) => m.includes('GCP anchoring skipped'))).toBe(true)
  })
})

// A3: retriangulation + track merging (pure helpers, tested directly).
describe('retriangulatePairs / mergeSplitTracks (A3)', () => {
  // Three cameras looking at a world point W; keypoint index 0 in each is W's
  // exact projection, so reprojection is zero and gates always pass.
  const W = [0, 0, 10]
  const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
  const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
  const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
  const uuids = ['c0', 'c1', 'c2']
  const cameras = new Map(uuids.map((u, i) => [u, { R: Rs[i], t: ts[i], K: Kobj }]))
  const kpOf = new Map(uuids.map((u, i) => [u, [project(Rs[i], ts[i], W)]])) // one kp each
  const keypointOf = (uuid, kp) => kpOf.get(uuid)?.[kp] ?? null

  it('retriangulates an unassigned match into a new 2-view point', async () => {
    const points3d = []
    const triangulate = async () => [{ x: W[0], y: W[1], z: W[2], srcIdx: 0 }]
    const { added } = await retriangulatePairs({
      points3d, cameras, pairs: [{ idA: 'c0', idB: 'c1', matches: [[0, 0]] }],
      keypointOf, maxReprojPx: 2, triangulate,
    })
    expect(added).toBe(1)
    expect(points3d).toHaveLength(1)
    expect([...points3d[0].views.entries()].sort()).toEqual([['c0', 0], ['c1', 0]])
  })

  it('rejects a retriangulated point that reprojects outside the gate', async () => {
    const points3d = []
    const triangulate = async () => [{ x: 5, y: 5, z: 10, srcIdx: 0 }] // wrong position
    const { added } = await retriangulatePairs({
      points3d, cameras, pairs: [{ idA: 'c0', idB: 'c1', matches: [[0, 0]] }],
      keypointOf, maxReprojPx: 2, triangulate,
    })
    expect(added).toBe(0)
    expect(points3d).toHaveLength(0)
  })

  it('rejects a low-parallax point even when it reprojects perfectly', async () => {
    const points3d = []
    const triangulate = async () => [{ x: W[0], y: W[1], z: W[2], srcIdx: 0 }]
    const { added, lowParallax } = await retriangulatePairs({
      points3d, cameras, pairs: [{ idA: 'c0', idB: 'c1', matches: [[0, 0]] }],
      keypointOf, maxReprojPx: 2, minTriAngleDeg: 20, triangulate,
    })
    expect(added).toBe(0)
    expect(lowParallax).toBe(1)
    expect(points3d).toHaveLength(0)
  })

  it('merges two points that are the same feature split across a match', () => {
    const p1 = { ...ptAt(W), views: new Map([['c0', 0], ['c1', 0]]) }
    const p2 = { ...ptAt(W), views: new Map([['c2', 0]]) }
    const res = mergeSplitTracks({
      points3d: [p1, p2], cameras,
      pairs: [{ idA: 'c0', idB: 'c2', matches: [[0, 0]] }], // links p1(c0) ↔ p2(c2)
      keypointOf, maxReprojPx: 2,
    })
    expect(res.merged).toBe(1)
    expect(res.points3d).toHaveLength(1)
    expect([...res.points3d[0].views.keys()].sort()).toEqual(['c0', 'c1', 'c2'])
  })

  it('does not merge when the union would put two keypoints in one image', () => {
    const p1 = { ...ptAt(W), views: new Map([['c0', 0], ['c2', 0]]) }
    const p2 = { ...ptAt(W), views: new Map([['c2', 1]]) } // c2 already in p1 at kp 0
    const res = mergeSplitTracks({
      points3d: [p1, p2], cameras,
      pairs: [{ idA: 'c0', idB: 'c2', matches: [[0, 1]] }],
      keypointOf: (uuid, kp) => (uuid === 'c2' && kp === 1 ? project(Rs[2], ts[2], W) : keypointOf(uuid, kp)),
      maxReprojPx: 2,
    })
    expect(res.merged).toBe(0)
    expect(res.points3d).toHaveLength(2)
  })
})

// COLMAP-style track completion (one-endpoint-assigned matches), tested directly.
describe('completeTracks', () => {
  // Four cameras around world point W. Keypoint 0 in each image is W's exact
  // projection; keypoint 1 is a decoy 40 px away (a wrong match).
  const W = [0, 0, 10]
  const Rs = [rotY(0), rotY(0.15), rotY(-0.15), rotY(0.3)]
  const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0], [4, 0, 1]]
  const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
  const uuids = ['c0', 'c1', 'c2', 'c3']
  const cameras = new Map(uuids.map((u, i) => [u, { R: Rs[i], t: ts[i], K: Kobj }]))
  const kpOf = new Map(uuids.map((u, i) => {
    const k = project(Rs[i], ts[i], W)
    return [u, [k, { x: k.x + 40, y: k.y }]]
  }))
  const keypointOf = (uuid, kp) => kpOf.get(uuid)?.[kp] ?? null
  const twoView = () => ({ ...ptAt(W), views: new Map([['c0', 0], ['c1', 0]]) })
  const opts = { cameras, keypointOf, maxReprojPx: 2 }

  it('adds the unassigned endpoint of a one-endpoint match and counts the lift', () => {
    const pt = twoView()
    const res = completeTracks({ ...opts, points3d: [pt], pairs: [{ idA: 'c0', idB: 'c2', matches: [[0, 0]] }] })
    expect(res).toMatchObject({ added: 1, addedExtra: 0, lifted: 1 })
    expect([...pt.views.entries()].sort()).toEqual([['c0', 0], ['c1', 0], ['c2', 0]])
  })

  it('chains across rounds (A↔C enables C↔D) until nothing more is added', () => {
    // c2↔c3 comes first, so in round 1 neither endpoint is assigned yet.
    const pairs = [{ idA: 'c2', idB: 'c3', matches: [[0, 0]] }, { idA: 'c0', idB: 'c2', matches: [[0, 0]] }]
    const one = twoView()
    expect(completeTracks({ ...opts, points3d: [one], pairs, maxRounds: 1 }).added).toBe(1)
    expect(one.views.has('c3')).toBe(false)
    const many = twoView()
    const res = completeTracks({ ...opts, points3d: [many], pairs, maxRounds: 5 })
    expect(res).toMatchObject({ added: 2, rounds: 3, lifted: 1 })
    expect([...many.views.keys()].sort()).toEqual(['c0', 'c1', 'c2', 'c3'])
  })

  it('rejects an observation outside the reprojection gate', () => {
    const pt = twoView()
    const res = completeTracks({ ...opts, points3d: [pt], pairs: [{ idA: 'c0', idB: 'c2', matches: [[0, 1]] }] })
    expect(res.added).toBe(0)
    expect(pt.views.has('c2')).toBe(false)
  })

  it('never gives a track a second keypoint in the same image, and skips both/neither-assigned matches', () => {
    const pt = { ...ptAt(W), views: new Map([['c0', 0], ['c2', 0]]) }
    const other = { ...ptAt(W), views: new Map([['c1', 1]]) }
    const res = completeTracks({
      ...opts,
      points3d: [pt, other],
      pairs: [
        { idA: 'c0', idB: 'c2', matches: [[0, 1]] }, // c2 already in the track (kp 0)
        { idA: 'c0', idB: 'c1', matches: [[0, 1]] }, // both endpoints assigned → merge's job
        { idA: 'c1', idB: 'c3', matches: [[0, 0]] }, // neither assigned → retriangulation's job
      ],
      keypointOf: (uuid, kp) => (uuid === 'c2' && kp === 1 ? kpOf.get('c2')[0] : keypointOf(uuid, kp)),
    })
    expect(res.added).toBe(0)
    expect(pt.views.get('c2')).toBe(0)
  })

  it('counts additions through extraPairs apart and ignores unregistered images', () => {
    const pt = twoView()
    const partial = new Map([...cameras].filter(([u]) => u !== 'c3'))
    const res = completeTracks({
      ...opts, cameras: partial, points3d: [pt],
      pairs: [{ idA: 'c0', idB: 'c3', matches: [[0, 0]] }], // c3 not registered
      extraPairs: [{ idA: 'c1', idB: 'c2', matches: [[0, 0]] }],
    })
    expect(res).toMatchObject({ added: 0, addedExtra: 1 })
    expect(pt.views.has('c3')).toBe(false)
    expect(pt.views.get('c2')).toBe(0)
  })

  it('updates a caller-supplied live index through its addView', () => {
    const pt = twoView()
    const index = new Map([['c0', new Map([[0, pt]])], ['c1', new Map([[0, pt]])]])
    const calls = []
    const addView = (p, uuid, kp) => {
      calls.push([uuid, kp]); p.views.set(uuid, kp)
      if (!index.has(uuid)) index.set(uuid, new Map())
      index.get(uuid).set(kp, p)
    }
    // points3d is deliberately empty: with an index supplied it must not be re-indexed.
    completeTracks({ ...opts, points3d: [], pairs: [{ idA: 'c1', idB: 'c2', matches: [[0, 0]] }], index, addView })
    expect(calls).toEqual([['c2', 0]])
    expect(index.get('c2').get(0)).toBe(pt)
  })
})

describe('pruneFinalTwoViewTracks', () => {
  const track = (views) => ({ x: 0, y: 0, z: 1, views: new Map(views.map((u, i) => [u, i])) })

  it('removes uncorroborated 2-view points when a healthy multi-view core exists', () => {
    const strong = Array.from({ length: 80 }, () => track(['a', 'b', 'c']))
    const fragile = Array.from({ length: 20 }, () => track(['a', 'b']))
    const res = pruneFinalTwoViewTracks([...strong, ...fragile])
    expect(res.applied).toBe(true)
    expect(res.removed).toBe(20)
    expect(res.points3d).toHaveLength(80)
    expect(res.points3d.every((pt) => pt.views.size >= 3)).toBe(true)
  })

  it('keeps 2-view points when pruning would erase a weak or tiny model', () => {
    const strong = Array.from({ length: 10 }, () => track(['a', 'b', 'c']))
    const fragile = Array.from({ length: 90 }, () => track(['a', 'b']))
    const input = [...strong, ...fragile]
    const res = pruneFinalTwoViewTracks(input)
    expect(res.applied).toBe(false)
    expect(res.removed).toBe(0)
    expect(res.points3d).toBe(input)
  })
})

function ptAt([x, y, z]) { return { x, y, z } }

describe('rotationCycleFilter (repetitive-structure defense)', () => {
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const rotZ = (deg) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]]
  }

  it('drops the one graph-inconsistent edge in a K4 and keeps the rest', () => {
    // Nodes a<b<c<d fully connected; every true relative rotation is identity, so
    // every cycle closes to 0° — except edge c–d, which carries a bogus 30° pose.
    // c–d sits in 2 triangles (a-c-d, b-c-d), both broken → 0% support → dropped.
    const edges = [
      { idA: 'a', idB: 'b', R: I }, { idA: 'a', idB: 'c', R: I }, { idA: 'a', idB: 'd', R: I },
      { idA: 'b', idB: 'c', R: I }, { idA: 'b', idB: 'd', R: I },
      { idA: 'c', idB: 'd', R: rotZ(30) }, // false pair
    ]
    const { drop } = rotationCycleFilter(edges)
    expect(drop).toHaveLength(1)
    expect(drop[0]).toMatchObject({ idA: 'c', idB: 'd', tri: 2, good: 0 })
  })

  it('keeps everything when all cycles are consistent', () => {
    const edges = [
      { idA: 'a', idB: 'b', R: I }, { idA: 'a', idB: 'c', R: I }, { idA: 'a', idB: 'd', R: I },
      { idA: 'b', idB: 'c', R: I }, { idA: 'b', idB: 'd', R: I }, { idA: 'c', idB: 'd', R: I },
    ]
    expect(rotationCycleFilter(edges).drop).toHaveLength(0)
  })

  it('canonicalises reversed edges (idA>idB) by transposing R', () => {
    // Same K4 as above but c–d supplied reversed (d,c) — the filter must transpose
    // R to the min→max direction and still flag the pair as (c,d).
    const edges = [
      { idA: 'a', idB: 'b', R: I }, { idA: 'a', idB: 'c', R: I }, { idA: 'a', idB: 'd', R: I },
      { idA: 'b', idB: 'c', R: I }, { idA: 'b', idB: 'd', R: I },
      { idA: 'd', idB: 'c', R: rotZ(30) }, // reversed direction
    ]
    const { drop } = rotationCycleFilter(edges)
    expect(drop).toHaveLength(1)
    expect(drop[0]).toMatchObject({ idA: 'c', idB: 'd' })
  })

  it('will not judge an edge in fewer than minTriangles triangles', () => {
    // A single triangle: each edge is in only 1 triangle (< default minTriangles=2),
    // so even a broken cycle leaves everything unjudged.
    const edges = [
      { idA: 'a', idB: 'b', R: I }, { idA: 'b', idB: 'c', R: rotZ(40) }, { idA: 'a', idB: 'c', R: I },
    ]
    expect(rotationCycleFilter(edges).drop).toHaveLength(0)
  })

  it('drops ≥90% of false edges and ≤2% of true edges under 2° rotation noise', () => {
    // Deterministic pseudo-random small-angle noise about a varying axis, applied to
    // every true edge (true relative rotation = identity, so cycles close to 0°); a
    // handful of edges carry a large bogus rotation (repetitive-structure false pair).
    let seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const rodrigues = (ax, deg) => {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
      const n = Math.hypot(...ax) || 1, [x, y, z] = ax.map((v) => v / n)
      const C = 1 - c
      return [
        [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
        [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
        [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
      ]
    }
    const N = 10
    const falseSet = new Set(['1--4', '2--7', '3--8', '5--9', '0--6']) // 5 of 45
    const edges = []
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const key = `${i}--${j}`
      if (falseSet.has(key)) {
        edges.push({ idA: String(i), idB: String(j), R: rotZ(35), inliers: 400 })
      } else {
        // ≤2° noise about a pseudo-random axis on the identity relative rotation.
        const R = rodrigues([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], (rnd() * 2))
        edges.push({ idA: String(i), idB: String(j), R, inliers: 4000 })
      }
    }
    const { drop } = rotationCycleFilter(edges)
    const dropped = new Set(drop.map((d) => `${d.idA}--${d.idB}`))
    let falseDropped = 0, trueDropped = 0
    for (const key of dropped) { if (falseSet.has(key)) falseDropped++; else trueDropped++ }
    // ≥90% of the 5 false edges (≥5), and ≤2% of the 40 true edges (0).
    expect(falseDropped).toBeGreaterThanOrEqual(Math.ceil(0.9 * falseSet.size))
    expect(trueDropped).toBeLessThanOrEqual(Math.floor(0.02 * (edges.length - falseSet.size)))
  })

  it('protects a strong edge whose weighted support is low but non-zero', () => {
    // Sequential edge a–b (5000 inliers, TRUE identity) is the only judgeable edge:
    // its neighbours c–f are pendant (each connects only to a,b → their edges sit in
    // one triangle, below minTriangles, so they are never dropped). a–b's support is
    // 14% (one good triangle a-b-c weight 50 vs three broken a-b-{d,e,f} weight 300),
    // below the 30% floor — without strong-edge protection it would be dropped.
    const edges = [
      { idA: 'a', idB: 'b', R: I, inliers: 5000 },
      { idA: 'a', idB: 'c', R: I, inliers: 50 }, { idA: 'b', idB: 'c', R: I, inliers: 50 },
      { idA: 'a', idB: 'd', R: rotZ(30), inliers: 100 }, { idA: 'b', idB: 'd', R: I, inliers: 100 },
      { idA: 'a', idB: 'e', R: rotZ(30), inliers: 100 }, { idA: 'b', idB: 'e', R: I, inliers: 100 },
      { idA: 'a', idB: 'f', R: rotZ(30), inliers: 100 }, { idA: 'b', idB: 'f', R: I, inliers: 100 },
    ]
    const { drop } = rotationCycleFilter(edges)
    expect(drop.some((d) => d.idA === 'a' && d.idB === 'b')).toBe(false)
  })

  it('drops a low-support false edge when no inlier counts are supplied (protection self-disables)', () => {
    // Uniform-quality graph: no `inliers` fields, so all default to 1 → the strong-edge
    // floor must NOT shield every edge. K5 of true (identity) edges plus one false edge
    // c–d that breaks all its triangles (a-c-d, b-c-d, c-d-e → ~0% support < 30% floor).
    // With the B1 bug, the percentile floor equalled 1 and every edge was "strong", so
    // c–d escaped on any non-zero support — the old (correct) behaviour must drop it.
    const edges = [
      { idA: 'a', idB: 'b', R: I }, { idA: 'a', idB: 'c', R: I }, { idA: 'a', idB: 'd', R: I }, { idA: 'a', idB: 'e', R: I },
      { idA: 'b', idB: 'c', R: I }, { idA: 'b', idB: 'd', R: I }, { idA: 'b', idB: 'e', R: I },
      { idA: 'c', idB: 'e', R: I }, { idA: 'd', idB: 'e', R: I },
      { idA: 'c', idB: 'd', R: rotZ(30) }, // false pair, breaks every triangle it sits in
    ]
    const { drop } = rotationCycleFilter(edges)
    expect(drop.some((d) => d.idA === 'c' && d.idB === 'd')).toBe(true)
  })
})

// ── F4: fiducial interior orientation ─────────────────────────────────────────
// A synthetic film scene: each "scan" is a rotated/offset copy of the same
// canonical camera. The pipeline must fit each image's scan→canonical affine
// from the clicked fiducials, reconstruct in the shared canonical frame, and
// report a canonical K equal to focalMm ÷ pitch.
describe('reconstruct (film scans, fiducial interior orientation)', () => {
  const FID = {
    marks: [
      { id: 'F1', xMm: -106, yMm: -106 }, { id: 'F2', xMm: 106, yMm: -106 },
      { id: 'F3', xMm: 106, yMm: 106 }, { id: 'F4', xMm: -106, yMm: 106 },
    ],
    ppxMm: 0, ppyMm: 0, focalMm: 153,
  }
  const SLOTS = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl']
  const CAL = { ...FID, transform: 'affine',
    slotMap: Object.fromEntries(SLOTS.map((slot, i) => [slot, FID.marks[i].id])) }
  const PITCH = 0.02 // mm/px
  const frame = canonicalFrame(FID, PITCH)
  const cK = frame.K // { fx = 153/0.02 = 7650, fy, cx, cy }
  const cKINV = [[1 / cK.fx, 0, -cK.cx / cK.fx], [0, 1 / cK.fy, -cK.cy / cK.fy], [0, 0, 1]]

  // Project world point through pose into the CANONICAL pixel frame.
  const projC = (R, t, X) => {
    const c = mv(R, X).map((v, i) => v + t[i])
    if (c[2] <= 0) return null
    return { x: cK.fx * (c[0] / c[2]) + cK.cx, y: cK.fy * (c[1] / c[2]) + cK.cy }
  }
  // canonical px → camera mm (inverse of canonicalFrame's mm→px map).
  const c2mm = (p) => [frame.originX + p.x * PITCH, frame.originY + p.y * PITCH]
  // camera mm → scan px for a scanner placement (rotation θ, offset ox/oy).
  const mm2scan = (mm, th, ox, oy) => {
    const c = Math.cos(th), s = Math.sin(th)
    return { x: (c * mm[0] - s * mm[1]) / PITCH + ox, y: (s * mm[0] + c * mm[1]) / PITCH + oy }
  }
  // Fundamental in the canonical frame (keypoints land there after the fiducial move).
  const fundC = (Ri, ti, Rj, tj) => {
    const Rrel = mul(Rj, T(Ri))
    const trel = tj.map((v, k) => v - mv(Rrel, ti)[k])
    const E = mul(skew(trel), Rrel)
    return mul(mul(T(cKINV), E), cKINV)
  }

  it('registers all film cameras and reports canonical K = focal ÷ pitch', async () => {
    const rng = mulberry32(11)
    const N = 60
    const world = Array.from({ length: N }, () => [
      (rng() - 0.5) * 4, (rng() - 0.5) * 3, 8 + rng() * 4,
    ])
    const centers = [[0, 0, 0], [2, 0, 0], [-2, 0, 0]]
    const Rs = [rotY(0), rotY(0.15), rotY(-0.15)]
    const ts = Rs.map((R, i) => mv(R, centers[i]).map((v) => -v))
    const uuids = ['f0', 'f1', 'f2']
    // Each scan gets its own placement: rotation + offset (the scanner geometry
    // the fit must remove). Noise-free ⇒ the fit is exact, so post-move keypoints
    // land exactly in the canonical frame.
    const scan = [{ th: 0.0, ox: 40, oy: -25 }, { th: 0.08, ox: -60, oy: 30 }, { th: -0.05, ox: 15, oy: 55 }]

    const images = uuids.map((uuid, ci) => {
      const kpCanon = world.map((X) => projC(Rs[ci], ts[ci], X))
      const { th, ox, oy } = scan[ci]
      return {
        uuid, name: uuid, kpStatus: 'done',
        meta: { width: frame.width, height: frame.height },
        sensor: { kind: 'film', fiducialCalibration: CAL },
        // Keypoints are stored in SCAN space (what the app persists).
        keypoints: kpCanon.map((p) => mm2scan(c2mm(p), th, ox, oy)),
        // Detection stores anonymous raster slots; calibration assigns metric IDs.
        fiducialDetections: FID.marks.map((m, i) => {
          const s = mm2scan([m.xMm, m.yMm], th, ox, oy)
          return { slot: SLOTS[i], px: s.x, py: s.y, confidence: 1 }
        }),
      }
    })
    for (const img of images) expect(img.keypoints.every(Boolean)).toBe(true)

    const matches = world.map((_, i) => [i, i])
    const pairs = []
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      pairs.push({ idA: uuids[a], idB: uuids[b], F: fundC(Rs[a], ts[a], Rs[b], ts[b]), matches, inlierCount: N, status: 'done' })
    }

    const out = await reconstruct(
      { images, pairs, settings: { baIterations: 0 } },
      { onLog: () => {}, onProgress: () => {} },
    )

    expect(out.status).toBe('done')
    expect(out.cameras).toHaveLength(3)
    // Canonical K equals focalMm ÷ pitch, shared by every film camera.
    for (const cam of out.cameras) {
      expect(cam.K.fx).toBeCloseTo(FID.focalMm / PITCH, 3)
      expect(cam.K.cx).toBeCloseTo(cK.cx, 3)
      expect(cam.K.cy).toBeCloseTo(cK.cy, 3)
    }
    // Reprojection (in the canonical frame) is sub-pixel — the scan geometry was
    // removed exactly at ingest.
    const camByUuid = new Map(out.cameras.map((c) => [c.uuid, c]))
    const residuals = []
    for (const pt of out.points) {
      for (const [uuid, kpIdx] of pt.views) {
        const cam = camByUuid.get(uuid)
        const c = mv(cam.R, [pt.x, pt.y, pt.z]).map((v, i) => v + cam.t[i])
        const u = cK.fx * (c[0] / c[2]) + cK.cx
        const v = cK.fy * (c[1] / c[2]) + cK.cy
        const kpCanon = projC(Rs[uuids.indexOf(uuid)], ts[uuids.indexOf(uuid)], world[kpIdx])
        residuals.push(Math.hypot(u - kpCanon.x, v - kpCanon.y))
      }
    }
    residuals.sort((a, b) => a - b)
    expect(residuals[residuals.length >> 1]).toBeLessThan(1.0)

    // The run records a per-image scan→canonical transform for the dense stage.
    expect(out.summary.fiducialTransforms).toHaveLength(3)
    expect(new Set(out.summary.fiducialTransforms.map((t) => t.uuid))).toEqual(new Set(uuids))
  })
})

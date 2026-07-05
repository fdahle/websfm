import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../wasm/reconstruction/reconstruction.js'
import { reconstruct, retriangulatePairs, mergeSplitTracks, rotationCycleFilter } from './sfm.js'
import { distortPixel } from './distortion.js'

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
})

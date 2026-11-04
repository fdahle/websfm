// PatchMatch on synthetic scenes with a known depth: the cases both kernels, the Rust one
// (mvs.rs, src/core/dense/patchmatchQuality.test.js on every push) and the WebGPU one
// (patchmatch.wgsl, tests/bench/gpuDepthCheck.js, the nightly browser suite), are held to.
// The two cannot be compared pixel by pixel (their random streams differ, and the GPU runs
// in f32), so each is compared with the truth, against the same bounds: a change to one
// kernel that loses quality fails here, whichever kernel it is in.
//
// A case runs depthMapForImage (and, for the geometric pass, geomDepthMapForImage) with
// the kernel it is given, so the pyramid, seeding and passes around the kernel are the
// app's own. Pure: no Node or DOM, so the page and the Node test share it.

import { depthMapForImage, geomDepthMapForImage } from '../../src/core/dense/mvs.js'
import { packSparseForDense } from '../../src/core/dense/sparseInput.js'
import { SparsePoints } from '../../src/core/sfm/sparsePoints.js'

const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

// One textured plane N·X = D seen by a reference camera at the origin and three sources
// translated from it (R = I). Every image is rendered by sampling a world-space texture at
// each pixel's 3D point, so the true (depth, normal) is exactly photo-consistent and the
// error left over is the optimiser's. `nVec`/`D` give the plane (N facing the camera,
// nz < 0); the default is a steep plane receding from ~1.5 to ~7.5 units (5:1), the shape
// of a ground-level or oblique view. `flatBand`: the texture is constant for world x in
// [−flatBand, flatBand], a textureless strip only a planar prior can fill.
export function planeScene(nVec = [0, -0.8, -0.6], D = -1.5, { flatBand = 0 } = {}) {
  const W = 160,
    H = 120
  const K = { fx: 120, fy: 120, cx: W / 2, cy: H / 2 }
  const m = Math.hypot(...nVec)
  const N = nVec.map((x) => x / m)
  // Several incommensurate wave directions: no repetition the matcher could lock onto.
  const waves = [
    [9.1, 3.3, 0.2],
    [-4.7, 11.3, 1.1],
    [17.9, -6.1, 2.3],
    [5.3, 21.7, 0.7],
    [27.1, 13.9, 1.9],
  ]
  const tex = (x, z) => {
    if (Math.abs(x) < flatBand) return 128
    let s = 0
    for (const [a, b, ph] of waves) s += Math.sin(a * x + b * z + ph)
    return 128 + 22 * s
  }
  const clip = (g) => Math.max(0, Math.min(255, Math.round(g)))
  const render = (t) => {
    // Camera at world C = −t (R = I): plane in its frame is N·Xc = D + N·t.
    const Dc = D + N[0] * t[0] + N[1] * t[1] + N[2] * t[2]
    const gray = new Uint8Array(W * H),
      depth = new Float32Array(W * H)
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const r = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]
        const Z = Dc / (N[0] * r[0] + N[1] * r[1] + N[2])
        depth[v * W + u] = Z
        gray[v * W + u] = clip(tex(Z * r[0] - t[0], Z - t[2]))
      }
    return { gray, depth }
  }
  const ref = render([0, 0, 0])
  const srcT = [
    [-0.3, 0, 0],
    [0.3, 0, 0],
    [0, -0.2, 0],
  ]
  const rendered = srcT.map(render)
  const sources = srcT.map((t, k) => ({ gray: rendered[k].gray, w: W, h: H, K, cam: { R: I, t } }))
  // Sparse support: a sprinkle of true surface points (as the SfM cloud would give).
  const points = []
  for (let v = 4; v < H; v += 13)
    for (let u = 5; u < W; u += 17) {
      const Z = ref.depth[v * W + u]
      points.push({ x: (Z * (u - K.cx)) / K.fx, y: (Z * (v - K.cy)) / K.fy, z: Z })
    }
  // The textureless strip's pixels in the reference (world x = Z·(u − cx)/fx).
  const band = flatBand ? (u, v) => Math.abs((ref.depth[v * W + u] * (u - K.cx)) / K.fx) < flatBand : () => false
  return {
    ref: { gray: ref.gray, width: W, height: H, K, cam: { R: I, t: [0, 0, 0] } },
    sources,
    srcDepth: rendered.map((r) => r.depth),
    points: SparsePoints.fromRecords(points),
    gt: ref.depth,
    band,
    W,
    H,
  }
}

// Share of interior pixels within 1 % / 0.2 % relative depth error, the median error, and
// the share within 1 % inside the textureless strip (null without one).
export function scoreDepth(dm, scene) {
  const { gt, W, H, band } = scene
  const errs = []
  let bandOk = 0,
    bandN = 0
  const b = 6 // skip the window-wide border, where sources leave the frame
  for (let v = b; v < H - b; v++)
    for (let u = b; u < W - b; u++) {
      const i = v * W + u
      const e = dm && dm.depth[i] > 0 ? Math.abs(dm.depth[i] - gt[i]) / gt[i] : Infinity
      errs.push(e)
      if (band(u, v)) {
        bandN++
        if (e <= 0.01) bandOk++
      }
    }
  errs.sort((a, c) => a - c)
  const within = (tol) => errs.filter((e) => e <= tol).length / errs.length
  return {
    within1: within(0.01),
    within02: within(0.002),
    median: errs[errs.length >> 1],
    band1: bandN ? bandOk / bandN : null,
  }
}

const SHALLOW = [[0.05, -0.15, -0.99], -4.0]

// What both kernels must reach. Each case switches one mechanism of the search on, at
// the app's own settings otherwise (bilateral NCC, the pyramid): best-K and ACMH view
// selection, the sparse window, the planar prior on a textureless strip, the geometric
// pass. `min`: lower bounds on scoreDepth's shares, `maxMedian`: an upper bound on the
// median error. Measured 2026-11-04, Rust / WebGPU on SwiftShader / WebGPU on an NVIDIA
// Turing (within 1 % · median error):
//   bestk    0.891 / 0.891 / 0.890 · 0.440 / 0.437 / 0.439 %
//   acmh     0.857 / 0.857 / 0.853 · 0.461 / 0.463 / 0.459 %
//   shallow  1.000 / 1.000 / 1.000 · 0.074 / 0.074 / 0.078 %   (within 0.2 %: 0.915 / 0.912 / 0.910)
//   step2    0.800 / 0.798 / 0.797 · 0.540 / 0.536 / 0.545 %
//   prior    0.883 / 0.867 / 0.841 · strip 0.562 / 0.507 / 0.389   (without the prior: 0.785 · strip 0.140)
//   geom     0.977 / 0.975 / 0.976 · 0.166 / 0.160 / 0.164 %   (without the pass: acmh above)
// The bounds sit a little below the lowest of the three (the GPU runs in f32 on its own
// random stream; another GPU's sampler rounds differently), and above what the case gives
// with its mechanism off, where that is measured.
export const PATCHMATCH_CASES = [
  {
    id: 'bestk',
    label: 'best-K view selection, deep plane',
    settings: { viewSelection: 'bestk' },
    min: { within1: 0.85 },
    maxMedian: 0.005,
  },
  {
    id: 'acmh',
    label: 'ACMH view selection, deep plane',
    settings: { viewSelection: 'acmh' },
    min: { within1: 0.82 },
    maxMedian: 0.0052,
  },
  {
    id: 'shallow',
    label: 'ACMH, shallow near-nadir plane',
    plane: SHALLOW,
    settings: { viewSelection: 'acmh' },
    min: { within1: 0.99, within02: 0.88 },
    maxMedian: 0.0009,
  },
  {
    id: 'step2',
    label: 'ACMH, 9×9 window sampled every other pixel',
    settings: { viewSelection: 'acmh', window: 4, windowStep: 2 },
    min: { within1: 0.76 },
    maxMedian: 0.0062,
  },
  {
    id: 'prior',
    label: 'ACMH + planar prior, textureless strip',
    plane: SHALLOW,
    flatBand: 0.6,
    settings: { viewSelection: 'acmh', planarPrior: true },
    min: { within1: 0.81, band1: 0.3 },
    maxMedian: 0.0013,
  },
  {
    id: 'geom',
    label: 'ACMH + geometric pass',
    geom: true,
    settings: { viewSelection: 'acmh' },
    min: { within1: 0.95 },
    maxMedian: 0.0019,
  },
]

// Run one case with `computeDepthMapFn` (the app's computeDepthMap or computeDepthMapGPU).
// Returns { score, check } — check: the run-time GPU check of the photometric map, the
// kernel's final cost against the Rust cost of the same planes (depthMapForImage
// hooks.validate: { rms, median, p90, max, n }).
export async function runPatchmatchCase(c, computeDepthMapFn) {
  const [nVec, D] = c.plane ?? []
  const scene = planeScene(nVec, D, { flatBand: c.flatBand ?? 0 })
  const pos = packSparseForDense(scene.points).pos
  const settings = { window: 3, iterations: 3, bestK: 2, coarseLong: 40, ...c.settings }
  let dm = await depthMapForImage(scene.ref, scene.sources, pos, settings, computeDepthMapFn, { validate: true })
  const check = dm?.gpuCheck ?? null
  if (dm && c.geom) {
    // The sources' first-pass depth planes stand in as their true depths: the pass is
    // checked for what it adds, not for the first-pass maps of three other views.
    dm = await geomDepthMapForImage(scene.ref, scene.sources, pos, dm, scene.srcDepth, settings, computeDepthMapFn)
  }
  return { score: scoreDepth(dm, scene), check }
}

// The bounds a score misses, as readable lines (empty = the case passes).
export function caseFailures(c, score) {
  const out = []
  for (const [k, lo] of Object.entries(c.min ?? {}))
    if (!(score[k] >= lo)) out.push(`${k} ${score[k]?.toFixed(3)} < ${lo}`)
  if (!(score.median <= c.maxMedian)) out.push(`median ${score.median.toFixed(5)} > ${c.maxMedian}`)
  return out
}

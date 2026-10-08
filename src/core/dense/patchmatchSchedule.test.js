import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { depthMapForImage } from './mvs.js'
import { refineScale, levelPerturbStarts } from './refineSchedule.js'

// End-to-end yardstick for the PatchMatch refinement schedule: the real WASM kernel,
// driven through depthMapForImage, on a synthetic scene with a DEEP depth range — a
// steep plane receding from ~1.5 to ~7.5 units (5:1), the shape of a ground-level or
// oblique view. Images are rendered by sampling a world-space texture at each pixel's
// 3D point, so the true (depth, normal) is exactly photo-consistent and the error
// left over is the optimiser's.
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

// `nVec`/`D` give the plane N·X = D (N facing the camera, nz < 0); the default is the
// steep, deep one.
function planeScene(nVec = [0, -0.8, -0.6], D = -1.5) {
  const W = 160, H = 120
  const K = { fx: 120, fy: 120, cx: W / 2, cy: H / 2 }
  const m = Math.hypot(...nVec)
  const N = nVec.map((x) => x / m)
  // Several incommensurate wave directions: no repetition the matcher could lock onto.
  const waves = [[9.1, 3.3, 0.2], [-4.7, 11.3, 1.1], [17.9, -6.1, 2.3], [5.3, 21.7, 0.7], [27.1, 13.9, 1.9]]
  const tex = (x, z) => {
    let s = 0
    for (const [a, b, ph] of waves) s += Math.sin(a * x + b * z + ph)
    return 128 + 22 * s
  }
  const clip = (g) => Math.max(0, Math.min(255, Math.round(g)))
  const render = (t) => {
    // Camera at world C = −t (R = I): plane in its frame is N·Xc = D + N·t.
    const Dc = D + N[0] * t[0] + N[1] * t[1] + N[2] * t[2]
    const gray = new Uint8Array(W * H), depth = new Float64Array(W * H)
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const r = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]
      const Z = Dc / (N[0] * r[0] + N[1] * r[1] + N[2])
      depth[v * W + u] = Z
      gray[v * W + u] = clip(tex(Z * r[0] - t[0], Z - t[2]))
    }
    return { gray, depth }
  }
  const ref = render([0, 0, 0])
  const srcT = [[-0.3, 0, 0], [0.3, 0, 0], [0, -0.2, 0]]
  const sources = srcT.map((t) => ({ gray: render(t).gray, w: W, h: H, K, cam: { R: I, t } }))
  // Sparse support: a sprinkle of true surface points (as the SfM cloud would give).
  const points = []
  for (let v = 4; v < H; v += 13) for (let u = 5; u < W; u += 17) {
    const Z = ref.depth[v * W + u]
    points.push({ x: Z * (u - K.cx) / K.fx, y: Z * (v - K.cy) / K.fy, z: Z })
  }
  return {
    ref: { gray: ref.gray, width: W, height: H, K, cam: { R: I, t: [0, 0, 0] } },
    sources, points, gt: ref.depth, W, H,
  }
}

// Share of interior pixels within `tol` relative depth error, and the median error.
function score(dm, gt, W, H) {
  const errs = []
  const b = 6 // skip the window-wide border, where sources leave the frame
  for (let v = b; v < H - b; v++) for (let u = b; u < W - b; u++) {
    const i = v * W + u
    errs.push(Math.abs(dm.depth[i] - gt[i]) / gt[i])
  }
  errs.sort((a, c) => a - c)
  const within = (tol) => errs.filter((e) => e <= tol).length / errs.length
  return { within1: within(0.01), within02: within(0.002), median: errs[errs.length >> 1] }
}

describe('PatchMatch refinement on a deep scene (real WASM kernel)', () => {
  const run = async (settings, plane = []) => {
    const s = planeScene(...plane)
    const dm = await depthMapForImage(s.ref, s.sources, s.points, { window: 3, iterations: 3, bestK: 2, ...settings })
    return score(dm, s.gt, s.W, s.H)
  }
  // Measured 2026-10-08 (share of pixels within 1 % / 0.2 %, median error), deep scene:
  //   range steps, restart per level            single 65.8 / 15.4 / 0.69 %   3-level 82.5 / 21.3 / 0.50 %
  //   depth steps, restart per level                                         3-level 83.7 / 22.0 / 0.48 %
  //   min(depth, range) steps + continued       single 76.2 / 19.2 / 0.57 %   3-level 91.9 / 25.0 / 0.41 %
  // Shallow scene (depth 3.7–4.6, a near-nadir view):
  //   range steps, restart per level            single 98.8 / 44.7 / 0.229 %  3-level 99.1 / 45.7 / 0.224 %
  //   pure depth steps (±50 % of depth)         single 98.3 / 41.3 / 0.251 %  ← why the step is min(depth, range)
  //   min(depth, range) steps + continued       single 98.8 / 44.7 / 0.229 %  3-level 99.4 / 49.7 / 0.202 %
  // The bounds sit between the old and new figures, so either half regressing fails.
  const SHALLOW = [[0.05, -0.15, -0.99], -4.0]

  it('refines near and far pixels alike at a single level (depth-relative steps)', async () => {
    const r = await run({ coarseLong: 1000 })
    expect(r.within1).toBeGreaterThan(0.72)
    expect(r.median).toBeLessThan(0.0063)
  })

  it('keeps refining through the pyramid instead of restarting each level', async () => {
    const r = await run({ coarseLong: 40 })
    expect(r.within1).toBeGreaterThan(0.88)
    expect(r.within02).toBeGreaterThan(0.235)
    expect(r.median).toBeLessThan(0.0045)
  })

  it('loses nothing on a shallow scene', async () => {
    const single = await run({ coarseLong: 1000 }, SHALLOW)
    expect(single.within02).toBeGreaterThan(0.44)
    const pyramid = await run({ coarseLong: 40 }, SHALLOW)
    expect(pyramid.within02).toBeGreaterThan(0.47)
  })
})

describe('refinement schedule', () => {
  it('halves the scale every sweep', () => {
    expect([0, 1, 2].map((it) => refineScale(1, it))).toEqual([1, 0.5, 0.25])
    expect(refineScale(0.25, 1)).toBe(0.125)
    expect(refineScale(0, 0)).toBe(1) // unset ⇒ an unseeded start
  })

  it('starts each finer level at twice the scale the coarser one ended on', () => {
    // Default pyramid: the coarsest level gets the most sweeps (5 / 4 / 3).
    expect(levelPerturbStarts([5, 4, 3])).toEqual([1, 0.125, 0.03125])
    expect(levelPerturbStarts([3])).toEqual([1]) // single level ⇒ unchanged start
    expect(levelPerturbStarts([1, 1])).toEqual([1, 1]) // never above 1
  })
})

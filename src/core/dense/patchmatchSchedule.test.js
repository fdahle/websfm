import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { depthMapForImage } from './mvs.js'
import { packSparseForDense } from './sparseInput.js'
import { planeScene, scoreDepth } from '../../../tests/bench/patchmatchCases.js'
import { refineScale, levelPerturbStarts } from './refineSchedule.js'

// End-to-end yardstick for the PatchMatch refinement schedule: the real WASM kernel,
// driven through depthMapForImage, on a synthetic scene with a DEEP depth range — a
// steep plane receding from ~1.5 to ~7.5 units (5:1), the shape of a ground-level or
// oblique view (planeScene in tests/bench/patchmatchCases.js, where the cases both
// kernels are held to live).
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

describe('PatchMatch refinement on a deep scene (real WASM kernel)', () => {
  const run = async (settings, plane = []) => {
    const s = planeScene(...plane)
    // The schedule on plain NCC: bilateral weighting (the default since 2026-10-26)
    // narrows the effective window, and on this smooth synthetic texture the shallow
    // plane's share within 0.2 % drops 0.44 → 0.43 — a property of the cost, not the
    // schedule (on ETH3D and Aukerman it is neutral or better, docs/METHODS.md).
    const dm = await depthMapForImage(s.ref, s.sources, packSparseForDense(s.points).pos, {
      window: 3,
      iterations: 3,
      bestK: 2,
      bilateralSigmaColor: 0,
      ...settings,
    })
    return scoreDepth(dm, s)
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
  }, 60_000) // two full kernel runs: ~5 s alone, several times that on a loaded machine
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

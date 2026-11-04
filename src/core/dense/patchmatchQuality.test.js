import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { computeDepthMap } from '../sfm/reconstruction.js'
import { depthMapForImage } from './mvs.js'
import { packSparseForDense } from './sparseInput.js'
import { DENSE_TUNING } from '../tuning.js'
import { PATCHMATCH_CASES, runPatchmatchCase, caseFailures, planeScene } from '../../../tests/bench/patchmatchCases.js'

// The Rust PatchMatch kernel (mvs.rs) against the truth on the synthetic cases the WebGPU
// kernel is held to as well (tests/bench/patchmatchCases.js; the GPU side runs in the
// nightly browser suite, tests/browser/gpu-depth.spec.js). A change to the search that
// loses quality fails here; the same bounds catch it in the other kernel. PM_PRINT=1
// prints each case's scores, for setting the bounds.
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

describe('PatchMatch quality on synthetic scenes (Rust kernel)', () => {
  for (const c of PATCHMATCH_CASES) {
    it(c.label, async () => {
      const { score, check } = await runPatchmatchCase(c, computeDepthMap)
      if (process.env.PM_PRINT)
        process.stderr.write(`${c.id} ${JSON.stringify(score)} check ${JSON.stringify(check)}\n`)
      expect(caseFailures(c, score)).toEqual([])
      // The run's handed-on cost is the Rust cost of its own final planes.
      expect(check.rms).toBeLessThan(1e-4)
    })
  }
})

// The run-time GPU check's verdict (depthMapForImage hooks.validate → dm.gpuCheck), on a
// stand-in GPU kernel: the Rust one with its handed-on cost changed. Hardware rounding
// leaves the median difference near 1e-5–1e-4; a kernel that computes something else
// moves it by far more, and the run then moves to the CPU (workers/ops/dense.js).
describe('the GPU check verdict', () => {
  const verdict = async (perturb) => {
    const s = planeScene()
    const kernel = async (...args) => {
      const dm = await computeDepthMap(...args)
      if (dm) dm.cost = dm.cost.map((c, i) => c + perturb(i))
      return dm
    }
    const dm = await depthMapForImage(
      s.ref,
      s.sources,
      packSparseForDense(s.points).pos,
      { coarseLong: 1000 },
      kernel,
      {
        validate: true,
      },
    )
    return dm.gpuCheck
  }

  it('passes a kernel within hardware rounding', async () => {
    // Most pixels a few 1e-6 off, one in fifty far off (low-texture pixels on a sampler).
    const g = await verdict((i) => (i % 50 === 0 ? 0.05 : (i % 7) * 1e-6))
    expect(g.ok).toBe(true)
    expect(g.median).toBeLessThan(DENSE_TUNING.gpuCheckWarn)
    expect(g.rms).toBeGreaterThan(5e-3) // the old RMS check would have failed it
  })

  it('fails a kernel whose cost is off everywhere', async () => {
    const g = await verdict(() => 2e-2)
    expect(g.ok).toBe(false)
  })
})

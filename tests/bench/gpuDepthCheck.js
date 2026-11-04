// The WebGPU PatchMatch kernel (patchmatch.wgsl) on the synthetic cases the Rust kernel is
// held to (patchmatchCases.js): each case's depth against the truth, and the GPU's final
// cost against the Rust cost of the same planes (the run-time A/B check). Run by the
// nightly browser suite on a software GPU (tests/browser/gpu-depth.spec.js) and by hand on
// this machine's GPU (scripts/bench/gpu-depth-check.mjs).
import { computeDepthMapGPU } from '/src/workers/gpu/depthMapGpu.js'
import { ensureDevice } from '/src/workers/gpu/device.js'
import { PATCHMATCH_CASES, runPatchmatchCase, caseFailures } from './patchmatchCases.js'

window.check = async () => {
  const st = await ensureDevice()
  const i = st?.info ?? {}
  const out = {
    adapter: st ? `${i.vendor ?? '?'} / ${i.architecture ?? '?'}${st.isFallback ? ' [software]' : ''}` : null,
    cases: [],
  }
  if (!st) return out
  for (const c of PATCHMATCH_CASES) {
    const t0 = performance.now()
    try {
      const { score, check } = await runPatchmatchCase(c, computeDepthMapGPU)
      out.cases.push({
        id: c.id,
        label: c.label,
        score,
        check,
        failures: caseFailures(c, score),
        ms: performance.now() - t0,
      })
    } catch (e) {
      out.cases.push({ id: c.id, label: c.label, err: String(e?.message ?? e), failures: ['error'] })
    }
  }
  return out
}
window.checkReady = true

// GPU vs WASM brute-force matching on planted descriptors (scripts/bench/gpu-match-check.mjs).
// Each case plants `shared` near-duplicate rows in B and compares the WebGPU matcher's
// match count with the WASM crate's. They must agree; a pair wider than one 64×64
// tile returning 0 on the GPU is the 2026-10 Vulkan/NVIDIA `acc` zero-init miscompile
// (match.wgsl).
import { beginGpuMatchRun, matchDescriptorsGpu, endGpuMatchRun } from '/src/workers/gpu/matchGpu.js'
import { matchDescriptors } from '/src/core/features/bruteforce.js'
import { ensureDevice } from '/src/workers/gpu/device.js'
let s = 12345
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
function planted(nA, nB, dim, shared) {
  const A = new Float32Array(nA * dim), B = new Float32Array(nB * dim)
  for (let i = 0; i < A.length; i++) A[i] = Math.floor(rnd() * 64)
  for (let i = 0; i < B.length; i++) B[i] = Math.floor(rnd() * 64)
  for (let k = 0; k < shared; k++) for (let d = 0; d < dim; d++) B[k * dim + d] = A[k * dim + d] + Math.floor(rnd() * 3)
  return [A, B]
}
window.check = async () => {
  const st = await ensureDevice()
  const i = st?.info ?? {}
  const out = { adapter: st ? `${i.vendor ?? '?'} / ${i.architecture ?? '?'}${st.isFallback ? ' [software]' : ''}` : null, limits: st && { maxStorage: st.device.limits.maxStorageBufferBindingSize, wgStorage: st.device.limits.maxComputeWorkgroupStorageSize } }
  const b = await beginGpuMatchRun({ runId: 'p', cacheBudgetBytes: 256 * 2 ** 20 })
  out.begin = b.ok ? 'ok' : b.reason
  const cases = []
  for (const [nA, nB, shared, ids, cross] of [[390, 387, 200, false, true], [390, 387, 200, true, true], [390, 387, 200, false, false], [64, 64, 40, false, true], [2000, 2000, 1000, true, true], [9000, 9000, 3000, true, true]]) {
    const [A, B] = planted(nA, nB, 128, shared)
    const o = { dim: 128, ratioThreshold: 0.8, crossCheck: cross }
    const cpu = await matchDescriptors(A, B, o)
    let gpu, err = null
    try { gpu = await matchDescriptorsGpu({ runId: 'p', idA: ids ? `a${nA}` : null, idB: ids ? `b${nB}` : null, descA: A, descB: B, ...o }) } catch (e) { err = String(e?.message ?? e) }
    cases.push({ nA, nB, shared, ids, cross, cpu: cpu.matches.length, gpu: gpu?.matches?.length ?? null, err, ok: !err && gpu?.matches?.length === cpu.matches.length })
  }
  out.cases = cases
  out.ok = cases.every((c) => c.ok)
  endGpuMatchRun({ runId: 'p' })
  return out
}
window.checkReady = true

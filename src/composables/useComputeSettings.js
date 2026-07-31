import { ref, watch } from 'vue'
import { configureWorkerPoolSize, MAX_POOL_SIZE } from '../workers/computeClient.js'

// Machine-level compute limits (not per-run tuning), so they live in Settings and
// persist to localStorage — shared across every run rather than re-entered per modal.
//
// memBudgetGb: the dense pre-flight (Build Depth Maps, Step 5) refuses to start if
// the projected peak memory exceeds this, to stop the browser killing the tab. It's
// a property of *this machine's* RAM, not of a given project — hence a global setting.
// Key preserved from the old DepthMapsModal field so existing values migrate.
const BUDGET_KEY = 'websfm.dense.memBudgetGb'
const DEFAULT_BUDGET_GB = 2

const memBudgetGb = ref(Number(localStorage.getItem(BUDGET_KEY)) || DEFAULT_BUDGET_GB)

watch(memBudgetGb, (v) => {
  if (v > 0) localStorage.setItem(BUDGET_KEY, String(v))
})

// useGpu: opt into the experimental WebGPU backends (LightGlue matching + PatchMatch
// depth maps). A property of *this browser/GPU*, not of a project or run — so it lives
// here rather than duplicated as a per-modal checkbox. Both consumers fall back to CPU
// automatically when the adapter can't run the model, so leaving it on is safe.
const GPU_KEY = 'websfm.compute.useGpu'
const useGpu = ref(localStorage.getItem(GPU_KEY) === 'true') // default off (experimental)

watch(useGpu, (v) => localStorage.setItem(GPU_KEY, String(!!v)))

// 0 means automatic (one worker per available core minus the UI thread, capped
// at MAX_POOL_SIZE). A lower manual value is useful on memory-constrained devices.
const WORKERS_KEY = 'websfm.compute.workerCount'
const storedWorkers = Number(localStorage.getItem(WORKERS_KEY))
const workerCount = ref(storedWorkers > 0 ? Math.min(MAX_POOL_SIZE, Math.round(storedWorkers)) : 0)

export function useComputeSettings() {
  function setMemBudgetGb(v) {
    const n = Number(v)
    if (n > 0) memBudgetGb.value = n
  }
  function setUseGpu(v) { useGpu.value = !!v }
  function setWorkerCount(v) {
    const n = Number(v)
    const next = n > 0 ? Math.max(1, Math.min(MAX_POOL_SIZE, Math.round(n))) : 0
    workerCount.value = next
    localStorage.setItem(WORKERS_KEY, String(next))
    return configureWorkerPoolSize(next)
  }
  return {
    memBudgetGb, setMemBudgetGb, DEFAULT_BUDGET_GB,
    useGpu, setUseGpu,
    workerCount, setWorkerCount, MAX_POOL_SIZE,
  }
}
